import type { RefKind } from '../types';
import type { LlmAdapter, LlmMessage, LlmToolCall } from '../llm/types';
import type { HostAdapter } from '../host/types';
import type { ConfirmFn, Intent, LedgerEntry, Outcome } from '../honesty/types';
import { READ_LOOP_TOOLS, ACT_TOOLS, REF_TOOL_KINDS, WRITE_REF_KINDS } from './tools';
import { resolveRef } from './refResolver';
import { serializeSnapshot } from './serialize';
import { diffSnapshots } from '../honesty/verifier';
import { isHighRisk } from '../honesty/riskPolicy';
import { Ledger } from '../honesty/ledger';
import { guardFinish } from '../honesty/narrationGuard';

export type AgentStep =
  | { type: 'observation'; tool: string; refId?: string; result: string }
  | { type: 'action'; tool: string; refId: string; verified: boolean; evidence: string[] }
  | { type: 'held'; tool: string; refId: string; intent: Intent }
  | { type: 'cancelled'; tool: string; refId: string; reason: string }
  | { type: 'error'; tool: string; refId?: string; error: string }
  | { type: 'finish'; answer: string; outcome: Outcome; ledger: LedgerEntry[] };

export interface AgentOptions {
  llm: LlmAdapter;
  host: HostAdapter;
  confirm?: ConfirmFn;
  readOnly?: boolean;
  maxSteps?: number;
  systemPrompt?: string;
}

const DEFAULT_MAX_STEPS = 12;
const DENY: ConfirmFn = () => Promise.resolve({ approved: false });

function defaultSystemPrompt(): string {
  return [
    '你是一个网页助手。你只能通过提供的工具观察和操作页面。',
    '只能引用工具结果里出现过的 ref id，不要编造 ref/id/selector。',
    '高风险操作会先暂停等待用户确认；完成时调用 finish 给出用户可见的回答。',
    '无法确认结果时如实说明，不要假装成功。',
  ].join('\n');
}

interface CallResult {
  steps: AgentStep[];
  toolResult: string;
}

async function processCall(
  call: LlmToolCall,
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
): Promise<CallResult> {
  const name = call.name;

  if (name === 'observePage') {
    const result = serializeSnapshot(host.snapshot());
    ledger.record({ kind: 'observe', tool: name, detail: result });
    return { steps: [{ type: 'observation', tool: name, result }], toolResult: result };
  }

  const readKind: RefKind | undefined = REF_TOOL_KINDS[name];
  if (readKind) {
    const refId = String(call.arguments.ref ?? '');
    const res = resolveRef(host.snapshot(), refId, readKind);
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
    const res = resolveRef(host.snapshot(), refId, writeKind);
    if (!res.ok) {
      ledger.record({ kind: 'error', tool: name, detail: res.error });
      return { steps: [{ type: 'error', tool: name, refId, error: res.error }], toolResult: `ERROR: ${res.error}` };
    }

    const steps: AgentStep[] = [];

    if (name === 'invokeAction' && isHighRisk(host.snapshot(), refId)) {
      const action = host.snapshot().actions.find((a) => a.ref.id === refId);
      const intent: Intent = {
        actionRef: refId,
        label: action?.label ?? refId,
        expectedEvidence: [`执行 ${action?.name ?? refId} 后页面应发生可观察变化`],
      };
      ledger.record({ kind: 'intent', refId, label: intent.label, expectedEvidence: intent.expectedEvidence });
      steps.push({ type: 'held', tool: name, refId, intent });

      const decision = await confirm(intent);
      ledger.record({ kind: 'grant', refId, approved: decision.approved });
      if (!decision.approved) {
        steps.push({ type: 'cancelled', tool: name, refId, reason: 'user declined' });
        return { steps, toolResult: 'ACTION CANCELLED: 用户拒绝了该高风险操作。' };
      }
    }

    const before = host.snapshot();
    const result =
      name === 'setControl'
        ? await host.setControl(res.ref, String(call.arguments.value ?? ''))
        : await host.invokeAction(res.ref);
    const evidence = diffSnapshots(before, result.snapshot);
    ledger.record({ kind: 'write', tool: name, refId, verified: evidence.changed, evidence: evidence.details });
    steps.push({ type: 'action', tool: name, refId, verified: evidence.changed, evidence: evidence.details });
    const toolResult = evidence.changed
      ? `done; 证据: ${evidence.details.join('; ')}`
      : '已执行，但未检测到可观察变化（未验证）。';
    return { steps, toolResult };
  }

  ledger.record({ kind: 'error', tool: name, detail: `unknown tool "${name}"` });
  return { steps: [{ type: 'error', tool: name, error: `unknown tool "${name}"` }], toolResult: 'ERROR: unknown tool' };
}

export function createAgent(options: AgentOptions) {
  const { llm, host } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const systemPrompt = options.systemPrompt ?? defaultSystemPrompt();
  const confirm = options.confirm ?? DENY;
  const tools = options.readOnly ? READ_LOOP_TOOLS : ACT_TOOLS;

  async function* run(userMessage: string): AsyncGenerator<AgentStep> {
    const ledger = new Ledger();
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    for (let i = 0; i < maxSteps; i++) {
      const turn = await llm.step(messages, tools);

      if (turn.toolCalls.length === 0) {
        const guarded = guardFinish(turn.content.trim(), ledger.entries);
        yield { type: 'finish', answer: guarded.answer, outcome: guarded.outcome, ledger: ledger.toJSON() };
        return;
      }

      messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

      let finished = false;
      for (const call of turn.toolCalls) {
        if (call.name === 'finish') {
          const guarded = guardFinish(String(call.arguments.answer ?? '').trim(), ledger.entries);
          yield { type: 'finish', answer: guarded.answer, outcome: guarded.outcome, ledger: ledger.toJSON() };
          finished = true;
          break;
        }
        const { steps, toolResult } = await processCall(call, host, ledger, confirm);
        for (const step of steps) yield step;
        messages.push({ role: 'tool', toolCallId: call.id, content: toolResult });
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

  return { run };
}
