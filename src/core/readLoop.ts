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
import { recordRef, resolveRecordedRef, type RecordedStep } from '../memory/pageMemory';
import { finishStep } from './finish';
import type { AgentStep, LoopDeps } from './loopTypes';

interface CallResult {
  steps: AgentStep[];
  toolResult: string;
  recorded?: RecordedStep;
}

/** 单个工具调用的派发：observe/read 走读路径，write 走"高危held→verify"写路径；每步记账。 */
async function processCall(
  call: LlmToolCall,
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
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
    // 复用唯一的写原语（verify-or-refuse + 高危 held 只此一处）。读循环无跨调用作用域，
    // 故传一次性空 scope 集——每次高危仍逐个确认，与历史行为一致。
    const wr = await executeWrite(host, ledger, confirm, new Set<string>(), {
      tool: name as 'setControl' | 'invokeAction',
      refId,
      value,
    });
    const recorded = wr.ref ? { tool: name, ref: recordRef(before, wr.ref), value } : undefined;
    return { steps: wr.steps, toolResult: wr.toolResult, recorded };
  }

  ledger.record({ kind: 'error', tool: name, detail: `unknown tool "${name}"` });
  return { steps: [{ type: 'error', tool: name, error: `unknown tool "${name}"` }], toolResult: 'ERROR: unknown tool' };
}

/** 记忆命中：按录制步零-LLM 重放；任一 ref 解析不出/写未验证 → 回退走 LLM；高危仍 held。 */
async function* attemptReplay(
  steps: RecordedStep[],
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
): AsyncGenerator<AgentStep, { done: boolean }> {
  for (const step of steps) {
    if (step.tool === 'finish') {
      yield finishStep(step.answer ?? '', ledger);
      return { done: true };
    }

    let refId: string | undefined;
    if (step.ref) {
      const ref = resolveRecordedRef(host.snapshot(), step.ref);
      if (!ref) return { done: false };
      refId = ref.id;
    }

    yield { type: 'replay', tool: step.tool, refId };

    const call: LlmToolCall = {
      id: `replay_${step.tool}`,
      name: step.tool,
      arguments: {
        ...(refId !== undefined ? { ref: refId } : {}),
        ...(step.value !== undefined ? { value: step.value } : {}),
      },
    };
    const { steps: produced } = await processCall(call, host, ledger, confirm);
    for (const s of produced) yield s;

    if (produced.some((s) => s.type === 'error')) return { done: false };
    if (produced.some((s) => s.type === 'action' && !s.verified)) return { done: false };
    if (produced.some((s) => s.type === 'cancelled')) {
      yield finishStep('', ledger);
      return { done: true };
    }
  }

  yield finishStep('', ledger);
  return { done: true };
}

/** 读循环（单步 tool-calling）：记忆命中先零-LLM 重放，否则逐步问模型；completed 才录制记忆。 */
export async function* runReadLoop(deps: LoopDeps, userMessage: string): AsyncGenerator<AgentStep> {
  const { llm, host, tools, systemPrompt, confirm, memory, maxSteps } = deps;
  const ledger = new Ledger();
  const recorded: RecordedStep[] = [];
  const key = memory ? memoryKey(host.snapshot(), userMessage) : '';

  if (memory) {
    const entry = memory.lookup(key);
    if (entry) {
      const result = yield* attemptReplay(entry.steps, host, ledger, confirm);
      if (result.done) return;
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
      const result = await processCall(call, host, ledger, confirm);
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
