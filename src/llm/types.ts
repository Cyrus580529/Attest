export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmTurn {
  content: string;
  toolCalls: LlmToolCall[];
}

export interface LlmAdapter {
  step(messages: LlmMessage[], tools: ToolSchema[]): Promise<LlmTurn>;
}
