import type { LlmAdapter, ToolSchema } from '../llm/types';
import type { HostAdapter } from '../host/types';
import type { ConfirmFn, Intent, LedgerEntry, Outcome } from '../honesty/types';
import type { PageMemory } from '../memory/pageMemory';
import type { RecipeBook } from '../memory/recipeBook';

/** agent 运行时逐个 yield 的步骤——读循环与程序循环共用的可观察词汇。 */
export type AgentStep =
  | { type: 'observation'; tool: string; refId?: string; result: string }
  | { type: 'action'; tool: string; refId: string; verified: boolean; evidence: string[] }
  | { type: 'held'; tool: string; refId: string; intent: Intent }
  | { type: 'cancelled'; tool: string; refId: string; reason: string }
  | { type: 'replay'; tool: string; refId?: string }
  | { type: 'thinking'; text: string }
  | { type: 'plan'; items: string[] }
  | { type: 'error'; tool: string; refId?: string; error: string }
  | { type: 'finish'; answer: string; outcome: Outcome; ledger: LedgerEntry[] };

/** 两个 loop（read / program）共享的运行上下文——createAgent 解析后显式传入。 */
export interface LoopDeps {
  llm: LlmAdapter;
  host: HostAdapter;
  tools: ToolSchema[];
  systemPrompt: string;
  confirm: ConfirmFn;
  memory?: PageMemory;
  recipes?: RecipeBook;
  maxSteps: number;
}
