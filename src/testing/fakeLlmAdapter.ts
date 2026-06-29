import type { LlmAdapter, LlmMessage, LlmTurn, ToolSchema } from '../llm/types';

export function toolCallTurn(
  name: string,
  args: Record<string, unknown>,
  id = `call_${name}`,
): LlmTurn {
  return { content: '', toolCalls: [{ id, name, arguments: args }] };
}

export function textTurn(content: string): LlmTurn {
  return { content, toolCalls: [] };
}

export class FakeLlmAdapter implements LlmAdapter {
  private index = 0;
  public readonly calls: { messages: LlmMessage[]; tools: ToolSchema[] }[] = [];

  constructor(private readonly script: LlmTurn[]) {}

  step(messages: LlmMessage[], tools: ToolSchema[]): Promise<LlmTurn> {
    this.calls.push({ messages, tools });
    const turn = this.script[this.index];
    this.index += 1;
    return Promise.resolve(turn ?? { content: '', toolCalls: [] });
  }
}
