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
import { finishStep } from './finish';
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
    if (name === 'readSurface') {
      result = host.readSurface(res.ref);
    } else {
      const r = name === 'openObject' ? await host.openObject(res.ref) : await host.navigate(res.ref);
      result = serializeSnapshot(r.snapshot);
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
    // 世界模型：验证写即学 (签名, 名) → diff——纯从证据，作为下次同页任务的先验（LLM 仍主导）。
    if (worldModel && wr.verified && wr.evidence && wr.evidence.length > 0) {
      const node =
        name === 'setControl'
          ? before.controls.find((c) => c.ref.id === refId)
          : before.actions.find((a) => a.ref.id === refId);
      if (node) worldModel.learn(before, node.name, { changed: true, details: wr.evidence });
    }
    return { steps: wr.steps, toolResult: wr.toolResult };
  }

  ledger.record({ kind: 'error', tool: name, detail: `unknown tool "${name}"` });
  return { steps: [{ type: 'error', tool: name, error: `unknown tool "${name}"` }], toolResult: 'ERROR: unknown tool' };
}

/** 世界模型先验：把当前页可见动作的「已知可观察效果」拼成提示，帮模型规划/写 predict（不旁路模型）。 */
function worldModelPrior(deps: LoopDeps): string {
  const { worldModel, host } = deps;
  if (!worldModel) return '';
  const snap = host.snapshot();
  const lines = snap.actions
    .map((a) => ({ name: a.name, p: worldModel.predict(snap, a.name) }))
    .filter((x) => x.p)
    .map((x) => `- ${x.name} → 预期变化: ${x.p!.expectDetails.join('; ')}`);
  return lines.length > 0
    ? `\n\n（已知动作效果，可用于规划与 predict；仍以实际验证为准）\n${lines.join('\n')}`
    : '';
}

/**
 * 读循环（单步 tool-calling，LLM 全程主导）：模型每回合亲自规划，可一次提多步并给 predict 做 lookahead；
 * 世界模型（若有）把「已知动作→diff」作先验注入，帮模型更自信地规划——但绝不旁路模型。
 */
export async function* runReadLoop(deps: LoopDeps, userMessage: string): AsyncGenerator<AgentStep> {
  const { llm, host, tools, systemPrompt, confirm, worldModel, maxSteps } = deps;
  const ledger = new Ledger();
  const grantedScopes = new Set<string>(); // 本 run 内共享的作用域授权（scope: 'all'）

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage + worldModelPrior(deps) },
  ];

  for (let i = 0; i < maxSteps; i++) {
    const turn = await llm.step(messages, tools);

    if (turn.toolCalls.length === 0) {
      yield finishStep(turn.content, ledger);
      return;
    }

    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

    let finished = false;
    for (const call of turn.toolCalls) {
      if (call.name === 'finish') {
        yield finishStep(String(call.arguments.answer ?? '').trim(), ledger);
        finished = true;
        break;
      }
      const result = await processCall(call, host, ledger, confirm, grantedScopes, worldModel);
      for (const s of result.steps) yield s;
      messages.push({ role: 'tool', toolCallId: call.id, content: result.toolResult });

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
  }

  const guarded = guardFinish('我没能在限定步数内完成这个任务，没有可确认的结果。', ledger.entries);
  yield {
    type: 'finish',
    answer: guarded.answer,
    outcome: guarded.outcome === 'completed' ? 'failed' : guarded.outcome,
    ledger: ledger.toJSON(),
  };
}
