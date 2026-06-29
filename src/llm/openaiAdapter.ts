import type { LlmAdapter, LlmMessage, LlmToolCall, LlmTurn, ToolSchema } from './types';

export interface OpenAiAdapterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface OpenAiResponse {
  choices: { message: { content: string | null; tool_calls?: OpenAiToolCall[] } }[];
}

function toOpenAiMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function createOpenAiAdapter(options: OpenAiAdapterOptions): LlmAdapter {
  const model = options.model ?? 'gpt-4o-mini';
  const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async step(messages: LlmMessage[], tools: ToolSchema[]): Promise<LlmTurn> {
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map(toOpenAiMessage),
          tools: tools.map((t) => ({ type: 'function', function: t })),
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI request failed: ${res.status}`);
      }
      const data = (await res.json()) as OpenAiResponse;
      const message = data.choices[0]?.message ?? { content: '' };
      const toolCalls: LlmToolCall[] = (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: parseArguments(c.function.arguments),
      }));
      return { content: message.content ?? '', toolCalls };
    },
  };
}
