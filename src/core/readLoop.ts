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
import { memoryKey } from '../memory/pageSignature';
import { recordRef, type RecordedStep } from '../memory/pageMemory';
import type { WorldModel } from '../memory/worldModel';
import { finishStep } from './finish';
import { runSpeculative } from './speculation/runSpeculative';
import { fromMemory } from './speculation/sources';
import type { AgentStep, LoopDeps } from './loopTypes';

interface CallResult {
  steps: AgentStep[];
  toolResult: string;
  recorded?: RecordedStep;
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
    return {
      steps: [{ type: 'observation', tool: name, refId, result }],
      toolResult: result,
      recorded: { tool: name, ref: recordRef(before, res.ref) },
    };
  }

  const writeKind: RefKind | undefined = WRITE_REF_KINDS[name];
  if (writeKind) {
    const refId = String(call.arguments.ref ?? '');
    const value = name === 'setControl' ? String(call.arguments.value ?? '') : undefined;
    // 复用唯一的写原语（verify-or-refuse + 高危 held 只此一处）。grantedScopes 由调用方
    // 传入：读循环主路共享一个（作用域授权 all 生效）；重放传一次性空集（高危仍逐个确认）。
    const wr = await executeWrite(host, ledger, confirm, grantedScopes, {
      tool: name as 'setControl' | 'invokeAction',
      refId,
      value,
    });
    const recorded = wr.ref
      ? { tool: name, ref: recordRef(before, wr.ref), value, observedDiff: wr.evidence }
      : undefined;
    // 世界模型：验证写即学 (签名, 名) → diff——纯从证据，供后续为记忆步补预测。
    if (worldModel && wr.verified && wr.evidence && wr.evidence.length > 0) {
      const node =
        name === 'setControl'
          ? before.controls.find((c) => c.ref.id === refId)
          : before.actions.find((a) => a.ref.id === refId);
      if (node) worldModel.learn(before, node.name, { changed: true, details: wr.evidence });
    }
    return { steps: wr.steps, toolResult: wr.toolResult, recorded };
  }

  ledger.record({ kind: 'error', tool: name, detail: `unknown tool "${name}"` });
  return { steps: [{ type: 'error', tool: name, error: `unknown tool "${name}"` }], toolResult: 'ERROR: unknown tool' };
}

/** 读循环（单步 tool-calling）：记忆命中先投机重放（前缀复用），否则逐步问模型；completed 才录制记忆。 */
export async function* runReadLoop(deps: LoopDeps, userMessage: string): AsyncGenerator<AgentStep> {
  const { llm, host, tools, systemPrompt, confirm, memory, worldModel, maxSteps } = deps;
  const ledger = new Ledger();
  const recorded: RecordedStep[] = [];
  const grantedScopes = new Set<string>(); // 本 run 内共享的作用域授权（scope: 'all'）
  const key = memory ? memoryKey(host.snapshot(), userMessage) : '';

  if (memory) {
    const entry = memory.lookup(key);
    if (entry) {
      const res = yield* runSpeculative(fromMemory(entry.steps, worldModel), {
        host,
        ledger,
        confirm,
        grantedScopes,
        worldModel,
      });
      if (res.done) return;
      // 部分重放：已验证前缀留在 ledger，漂移/失效处交下方 LLM 循环补尾（余下重新规划）。
      // 不续跑录制尾巴——页面已偏离，陈旧预测不可信（红线：记忆只加速不背书）。
    }
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  for (let i = 0; i < maxSteps; i++) {
    const turn = await llm.step(messages, tools);

    if (turn.toolCalls.length === 0) {
      const step = finishStep(turn.content, ledger);
      if (memory && step.type === 'finish' && step.outcome === 'completed') {
        memory.record(key, [...recorded, { tool: 'finish', answer: turn.content.trim() }]);
      }
      yield step;
      return;
    }

    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

    let finished = false;
    for (const call of turn.toolCalls) {
      if (call.name === 'finish') {
        const answer = String(call.arguments.answer ?? '').trim();
        const step = finishStep(answer, ledger);
        if (memory && step.type === 'finish' && step.outcome === 'completed') {
          memory.record(key, [...recorded, { tool: 'finish', answer }]);
        }
        yield step;
        finished = true;
        break;
      }
      const result = await processCall(call, host, ledger, confirm, grantedScopes, worldModel);
      for (const s of result.steps) yield s;
      if (result.recorded) recorded.push(result.recorded);
      messages.push({ role: 'tool', toolCallId: call.id, content: result.toolResult });
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
