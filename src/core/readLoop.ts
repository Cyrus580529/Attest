import type { RefKind } from '../types';
import type { LlmMessage, LlmToolCall } from '../llm/types';
import type { HostAdapter } from '../host/types';
import type { ConfirmFn } from '../honesty/types';
import { REF_TOOL_KINDS, WRITE_REF_KINDS } from './tools';
import { resolveRef } from './refResolver';
import { serializeSnapshot } from './serialize';
import { executeWrite } from './execWrite';
import { Ledger } from '../honesty/ledger';
import { guardFinish } from '../honesty/narrationGuard';
import type { WorldModel } from '../memory/worldModel';
import { finishStep, factualLedgerSummary, observationDigest } from './finish';
import { compactMessages } from './compaction';
import { matchesPrediction } from './speculation/prediction';
import type { AgentStep, LoopDeps } from './loopTypes';

interface CallResult {
  steps: AgentStep[];
  toolResult: string;
}

/** 单个工具调用的派发：observe/read 走读路径，write 走"高危held→verify"写路径；每步记账。 */
export async function processCall(
  call: LlmToolCall,
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
  grantedScopes: Set<string>,
  worldModel?: WorldModel,
): Promise<CallResult> {
  const name = call.name;
  const before = host.snapshot();

  if (name === 'observePage') {
    const result = serializeSnapshot(before);
    ledger.record({ kind: 'observe', tool: name, detail: result });
    return { steps: [{ type: 'observation', tool: name, result }], toolResult: result };
  }

  const readKind: RefKind | undefined = REF_TOOL_KINDS[name];
  if (readKind) {
    const refId = String(call.arguments.ref ?? '');
    const res = resolveRef(before, refId, readKind);
    if (!res.ok) {
      ledger.record({ kind: 'error', tool: name, detail: res.error });
      return { steps: [{ type: 'error', tool: name, refId, error: res.error }], toolResult: `ERROR: ${res.error}` };
    }
    let result: string;
    try {
      if (name === 'readSurface') {
        result = host.readSurface(res.ref);
      } else {
        const r = name === 'openObject' ? await host.openObject(res.ref) : await host.navigate(res.ref);
        result = serializeSnapshot(r.snapshot);
      }
    } catch (e) {
      // host 读故障不许炸穿循环：记账为 error，模型看到 ERROR 自行改道或如实收尾。
      const error = `host 读取失败：${e instanceof Error ? e.message : String(e)}`;
      ledger.record({ kind: 'error', tool: name, detail: error });
      return { steps: [{ type: 'error', tool: name, refId, error }], toolResult: `ERROR: ${error}` };
    }
    ledger.record({ kind: 'observe', tool: name, detail: result });
    return { steps: [{ type: 'observation', tool: name, refId, result }], toolResult: result };
  }

  const writeKind: RefKind | undefined = WRITE_REF_KINDS[name];
  if (writeKind) {
    const refId = String(call.arguments.ref ?? '');
    const value = name === 'setControl' ? String(call.arguments.value ?? '') : undefined;
    const rawArgs = call.arguments.args;
    const args =
      name === 'invokeAction' && rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : undefined;
    // 复用唯一的写原语（verify-or-refuse + 高危 held 只此一处）。grantedScopes 由调用方
    // 传入：读循环主路共享一个（作用域授权 all 生效）。
    const wr = await executeWrite(host, ledger, confirm, grantedScopes, {
      tool: name as 'setControl' | 'invokeAction',
      refId,
      value,
      args,
    });
    // 世界模型：每次真正执行的写（含"执行了但无变化"）都在此刻写时裁定——
    // 验证写学正先验，无变化记负样本/落空；连续落空即判漂移，作为 drift step 上报。
    if (worldModel && wr.evidence !== undefined) {
      const node =
        name === 'setControl'
          ? before.controls.find((c) => c.ref.id === refId)
          : before.actions.find((a) => a.ref.id === refId);
      if (node) {
        worldModel.learn(before, node.name, { changed: wr.verified, details: wr.evidence });
        for (const d of worldModel.drainDrift()) {
          wr.steps.push({ type: 'drift', tool: name, refId, expected: d.expected, observed: d.observed });
        }
      }
    }
    return { steps: wr.steps, toolResult: wr.toolResult };
  }

  ledger.record({ kind: 'error', tool: name, detail: `unknown tool "${name}"` });
  return { steps: [{ type: 'error', tool: name, error: `unknown tool "${name}"` }], toolResult: 'ERROR: unknown tool' };
}

/**
 * 世界模型先验：把当前页可见动作的「已知可观察效果」拼成提示，帮模型规划/写 predict（不旁路模型）。
 * 分级注入（授权输出）：active 原样；suspect 带警示（最近一次未按已知效果发生）；
 * 负先验（≥2 次确认无效果）明示勿依赖——先验不只说哪条路通，也说哪条路死。
 */
function worldModelPrior(deps: LoopDeps): string {
  const { worldModel, host } = deps;
  if (!worldModel) return '';
  const snap = host.snapshot();
  const lines: string[] = [];
  for (const a of snap.actions) {
    const p = worldModel.lookup(snap, a.name);
    if (p) {
      const caveat = p.status === 'suspect' ? '（注意：最近一次未按此效果发生，先验证再依赖）' : '';
      lines.push(`- ${a.name} → 预期变化: ${p.details.join('; ')}${caveat}`);
      continue;
    }
    if (worldModel.noEffectCount(snap, a.name) >= 2) {
      lines.push(`- ${a.name} → 已知多次执行均无可观察变化，勿依赖它达成效果`);
    }
  }
  // 批量+predict 的鼓励只随先验出现：live A/B 实测「无知识的投机」全落空反而更贵，
  // 有已知效果时批量+照抄 predict 才是纯赚（命中连续执行省往返）。
  return lines.length > 0
    ? `\n\n（已知动作效果，可用于规划；仍以实际验证为准。对下列已知效果的动作，尽量在同一回合批量提交多步并给写步骤附 predict——直接照抄已知效果即可，命中会自动连续执行、省去往返；对效果未知的动作不要猜 predict。）\n${lines.join('\n')}`
    : '';
}

/**
 * 读循环（单步 tool-calling，LLM 全程主导）：模型每回合亲自规划，可一次提多步并给 predict 做 lookahead；
 * 世界模型（若有）把「已知动作→diff」作先验注入，帮模型更自信地规划——但绝不旁路模型。
 */
export async function* runReadLoop(deps: LoopDeps, userMessage: string): AsyncGenerator<AgentStep> {
  const { llm, host, tools, systemPrompt, confirm, worldModel, maxSteps, maxContextTokens } = deps;
  const ledger = new Ledger();
  const grantedScopes = new Set<string>(); // 本 run 内共享的作用域授权（scope: 'all'）

  let messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage + worldModelPrior(deps) },
  ];

  for (let i = 0; i < maxSteps; i++) {
    // 上下文管理：历史超预算时压缩（保 system+user+近期，中间以账本摘要替代），防长任务撑爆窗口。
    // 摘要含「事实进展」(做了什么) + 「关键观察原文摘录」(看到了什么)——后者防丢失关键观察细节。
    const digest = observationDigest(ledger.entries);
    messages = compactMessages(
      messages,
      `（为控制上下文，较早的中间步骤已省略。至此事实进展：${factualLedgerSummary(ledger.entries)}。` +
        `${digest ? `\n${digest}\n` : ''}当前页面以最近的工具结果为准。）`,
      { maxContextTokens },
    );
    const turn = await llm.step(messages, tools);

    if (turn.toolCalls.length === 0) {
      yield finishStep(turn.content, ledger);
      return;
    }

    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

    let finished = false;
    const responded = new Set<string>();
    for (const call of turn.toolCalls) {
      if (call.name === 'finish') {
        yield finishStep(String(call.arguments.answer ?? '').trim(), ledger);
        finished = true;
        break;
      }
      const result = await processCall(call, host, ledger, confirm, grantedScopes, worldModel);
      for (const s of result.steps) yield s;
      messages.push({ role: 'tool', toolCallId: call.id, content: result.toolResult });
      responded.add(call.id);

      // lookahead：模型可在一回合内提多步并给 predict。写步命中预测则继续执行本回合后续步；
      // 落空/未验证/error/取消 → 中断本轮批次，回到 llm.step 让模型按真实结果重规划（模型始终主导）。
      const actionStep = result.steps.find((s) => s.type === 'action') as
        | Extract<AgentStep, { type: 'action' }>
        | undefined;
      if (result.steps.some((s) => s.type === 'error' || s.type === 'cancelled')) break;
      if (actionStep && !actionStep.verified) break;
      if (actionStep) {
        const predict = Array.isArray(call.arguments.predict)
          ? (call.arguments.predict as unknown[]).map(String)
          : undefined;
        if (predict && predict.length > 0) {
          const hit = matchesPrediction(
            { changed: actionStep.verified, details: actionStep.evidence },
            { expectDetails: predict },
          );
          yield { type: 'speculate', tool: call.name, refId: actionStep.refId, hit };
          if (!hit) {
            yield {
              type: 'mispredict',
              tool: call.name,
              refId: actionStep.refId,
              expected: predict,
              actual: actionStep.evidence,
            };
            break;
          }
        }
      }
    }
    if (finished) return;
    // OpenAI 协议合同：assistant 的每个 tool_call 都必须有对应 tool 回执。
    // 批次中断（落空/未验证/错误/取消）跳过的步骤补"未执行"回执，否则下一轮请求 400。
    for (const call of turn.toolCalls) {
      if (!responded.has(call.id)) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: 'SKIPPED: 本回合批次已中断，此步未执行。请按最新工具结果重规划。',
        });
      }
    }
  }

  const guarded = guardFinish('我没能在限定步数内完成这个任务，没有可确认的结果。', ledger.entries);
  yield {
    type: 'finish',
    answer: guarded.answer,
    outcome: guarded.outcome === 'completed' ? 'failed' : guarded.outcome,
    ledger: ledger.toJSON(),
  };
}
