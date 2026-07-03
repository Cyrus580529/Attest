import type { RefKind } from '../types';
import type { LlmMessage, LlmToolCall } from '../llm/types';
import type { HostAdapter } from '../host/types';
import type { AskFn, ConfirmFn } from '../honesty/types';
import { REF_TOOL_KINDS, WRITE_REF_KINDS } from './tools';
import { resolveRef } from './refResolver';
import { serializeSnapshot } from './serialize';
import { executeWrite } from './execWrite';
import { Ledger } from '../honesty/ledger';
import type { WorldModel } from '../memory/worldModel';
import { genericExpectation } from '../memory/worldModel';
import { pageSignature } from '../memory/pageSignature';
import type { PageSnapshot } from '../types';
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
  ask: AskFn,
  worldModel?: WorldModel,
  settleDelaysMs?: number[],
): Promise<CallResult> {
  const name = call.name;
  const before = host.snapshot();

  if (name === 'observePage') {
    const result = serializeSnapshot(before);
    ledger.record({ kind: 'observe', tool: name, detail: result });
    return { steps: [{ type: 'observation', tool: name, result }], toolResult: result };
  }

  if (name === 'askUser') {
    const question = String(call.arguments.question ?? '').trim();
    if (!question) {
      ledger.record({ kind: 'error', tool: name, detail: 'askUser 需要 question' });
      return { steps: [{ type: 'error', tool: name, error: 'askUser 需要 question' }], toolResult: 'ERROR: askUser 需要 question' };
    }
    const { answer } = await ask(question);
    const answered = answer !== undefined;
    ledger.record({ kind: 'clarify', question, answered });
    const toolResult = answered
      ? `用户回答：${answer}`
      : '（无人应答。若这是完成任务的关键信息缺失，请只用任务明确提供的值继续、缺失的可选字段留空交由系统默认，' +
        '并在最终回答里说明你做的假设；绝不编造用户未提供的值填入。）';
    return { steps: [{ type: 'clarify', question, answered }], toolResult };
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
    const wr = await executeWrite(
      host,
      ledger,
      confirm,
      grantedScopes,
      { tool: name as 'setControl' | 'invokeAction', refId, value, args },
      settleDelaysMs ? { settleDelaysMs } : {},
    );
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
const MAX_PRIOR_LINES = 8; // 注入上限：防陈旧注入/检索稀释把先验变负担（Library Drift 教训）

function worldModelPrior(deps: LoopDeps): string {
  const { worldModel, host } = deps;
  if (!worldModel) return '';
  return worldModelPriorText(worldModel, host.snapshot());
}

function worldModelPriorText(worldModel: WorldModel, snap: PageSnapshot): string {
  // rank 0=active 1=suspect 2=负先验：额度不够时 active 优先——它们才是可照抄 predict 的。
  const ranked: { rank: number; line: string }[] = [];
  for (const a of snap.actions) {
    const p = worldModel.lookup(snap, a.name);
    if (p) {
      const caveat = p.status === 'suspect' ? '（注意：最近一次未按此效果发生，先验证再依赖）' : '';
      // 泛化形注入：剥实例 id/具体值——原文带 id 会让模型照抄 predict 后跨实例必落空
      const expected = [...new Set(p.details.map(genericExpectation))].join('; ');
      ranked.push({ rank: p.status === 'suspect' ? 1 : 0, line: `- ${a.name} → 预期变化: ${expected}${caveat}` });
      continue;
    }
    if (worldModel.noEffectCount(snap, a.name) >= 2) {
      ranked.push({ rank: 2, line: `- ${a.name} → 已知多次执行均无可观察变化，勿依赖它达成效果` });
    }
  }
  const lines = ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_PRIOR_LINES)
    .map((x) => x.line);
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
  const { llm, host, tools, systemPrompt, confirm, ask, worldModel, maxSteps, maxContextTokens } = deps;
  const ledger = new Ledger();
  const grantedScopes = new Set<string>(); // 本 run 内共享的作用域授权（scope: 'all'）
  let lastPriorSig = pageSignature(host.snapshot()); // 起始页先验随 user 消息注入，此后按签名变化补注

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
        // 自评降级通道：goalMet:false = 模型申报"页面反馈显示业务失败"。只降不升（applyClaim 保证）。
        const claim = call.arguments.goalMet === false ? { goalMet: false } : undefined;
        yield finishStep(String(call.arguments.answer ?? '').trim(), ledger, claim);
        finished = true;
        break;
      }
      const result = await processCall(call, host, ledger, confirm, grantedScopes, ask, worldModel, deps.settleDelaysMs);
      for (const s of result.steps) yield s;
      // 中途换页（签名变化）时把新页先验搭在本工具结果上补注——多页流程里先验
      // 不只服务起始页；同签名不重复，token 只在换页时花。
      let content = result.toolResult;
      if (worldModel) {
        const sig = pageSignature(host.snapshot());
        if (sig !== lastPriorSig) {
          lastPriorSig = sig;
          const prior = worldModelPriorText(worldModel, host.snapshot());
          if (prior) content += prior;
        }
      }
      messages.push({ role: 'tool', toolCallId: call.id, content });
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

  // 步数耗尽＝目标未达成：走同一条自评降级通道（completed→failed，cancelled 保持更精确原因）。
  yield finishStep('我没能在限定步数内完成这个任务，没有可确认的结果。', ledger, { goalMet: false });
}
