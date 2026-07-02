import type { LlmAdapter, ToolSchema } from '../llm/types';
import type { HostAdapter } from '../host/types';
import type { ConfirmFn, Intent, LedgerEntry, Outcome } from '../honesty/types';
import type { RecipeBook } from '../memory/recipeBook';
import type { WorldModel } from '../memory/worldModel';

/** agent 运行时逐个 yield 的步骤——读循环与程序循环共用的可观察词汇。 */
export type AgentStep =
  | { type: 'observation'; tool: string; refId?: string; result: string }
  | { type: 'action'; tool: string; refId: string; verified: boolean; evidence: string[] }
  | { type: 'held'; tool: string; refId: string; intent: Intent }
  | { type: 'cancelled'; tool: string; refId: string; reason: string }
  | { type: 'replay'; tool: string; refId?: string }
  | { type: 'speculate'; tool: string; refId?: string; hit: boolean }
  | { type: 'mispredict'; tool: string; refId?: string; expected: string[]; actual: string[] }
  /** 世界模型判定页面行为漂移：已知动作连续未按已知效果发生（observed 空 = 不再有任何效果）。 */
  | { type: 'drift'; tool: string; refId?: string; expected: string[]; observed: string[] }
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
  recipes?: RecipeBook;
  /** opt-in：从账本学 动作→diff 因果，作为下次同页任务的先验注入（谱系②世界模型；LLM 仍主导）。 */
  worldModel?: WorldModel;
  maxSteps: number;
  /** 上下文 token 预算：读循环历史超此值即压缩（保 system+user+近期，中间以账本摘要替代）。 */
  maxContextTokens: number;
}
