import type { RefKind } from '../types';
import type { LlmAdapter, LlmMessage, LlmToolCall } from '../llm/types';
import type { HostAdapter } from '../host/types';
import { READ_LOOP_TOOLS, REF_TOOL_KINDS } from './tools';
import { resolveRef } from './refResolver';
import { serializeSnapshot } from './serialize';

export type AgentStep =
  | { type: 'observation'; tool: string; refId?: string; result: string }
  | { type: 'error'; tool: string; refId?: string; error: string }
  | { type: 'finish'; answer: string; outcome: 'completed' | 'failed' };

export interface AgentOptions {
  llm: LlmAdapter;
  host: HostAdapter;
  maxSteps?: number;
  systemPrompt?: string;
}

const DEFAULT_MAX_STEPS = 12;

function defaultSystemPrompt(): string {
  return [
    '你是一个网页助手。你只能通过提供的工具观察和操作页面。',
    '只能引用工具结果里出现过的 ref id，不要编造 ref/id/selector。',
    '完成时调用 finish 给出用户可见的回答；无法确认结果时如实说明，不要假装成功。',
  ].join('\n');
}

async function handleToolCall(call: LlmToolCall, host: HostAdapter): Promise<AgentStep> {
  const name = call.name;
  if (name === 'finish') {
    return { type: 'finish', answer: String(call.arguments.answer ?? '').trim(), outcome: 'completed' };
  }
  if (name === 'observePage') {
    return { type: 'observation', tool: name, result: serializeSnapshot(host.snapshot()) };
  }
  const expectedKind: RefKind | undefined = REF_TOOL_KINDS[name];
  if (!expectedKind) {
    return { type: 'error', tool: name, error: `unknown tool "${name}"` };
  }
  const refId = String(call.arguments.ref ?? '');
  const resolution = resolveRef(host.snapshot(), refId, expectedKind);
  if (!resolution.ok) {
    return { type: 'error', tool: name, refId, error: resolution.error };
  }
  if (name === 'readSurface') {
    return { type: 'observation', tool: name, refId, result: host.readSurface(resolution.ref) };
  }
  const result = name === 'openObject'
    ? await host.openObject(resolution.ref)
    : await host.navigate(resolution.ref);
  return { type: 'observation', tool: name, refId, result: serializeSnapshot(result.snapshot) };
}

function toolResultContent(step: AgentStep): string {
  if (step.type === 'error') return `ERROR: ${step.error}`;
  if (step.type === 'observation') return step.result;
  return step.answer;
}

export function createAgent(options: AgentOptions) {
  const { llm, host } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const systemPrompt = options.systemPrompt ?? defaultSystemPrompt();

  async function* run(userMessage: string): AsyncGenerator<AgentStep> {
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    for (let i = 0; i < maxSteps; i++) {
      const turn = await llm.step(messages, READ_LOOP_TOOLS);

      if (turn.toolCalls.length === 0) {
        yield { type: 'finish', answer: turn.content.trim(), outcome: 'completed' };
        return;
      }

      messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

      let finished = false;
      for (const call of turn.toolCalls) {
        const step = await handleToolCall(call, host);
        yield step;
        messages.push({ role: 'tool', toolCallId: call.id, content: toolResultContent(step) });
        if (step.type === 'finish') finished = true;
      }
      if (finished) return;
    }

    yield {
      type: 'finish',
      answer: '我没能在限定步数内完成这个任务，没有可确认的结果。',
      outcome: 'failed',
    };
  }

  return { run };
}
