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
  /**
   * 收尾：facts 由账本硬生成（模型碰不到）；narration 是模型原话（一字不改，不审查）；
   * answer = narration + 执行记录（兼容单字符串消费方）。机制是并列对照，不是消音。
   */
  | { type: 'finish'; facts: FinishFacts; narration: string; answer: string; outcome: Outcome; ledger: LedgerEntry[] };

/** 执行事实的权威版本——由证据账本生成，是叙述层的 verify-or-refuse。 */
export interface FinishFacts {
  outcome: Outcome;
  verified: { tool: string; refId: string; evidence: string[] }[];
  unverified: { tool: string; refId: string }[];
  cancelled: { refId: string; label?: string }[];
  writeErrors: { tool: string; detail: string }[];
  /** 人话骨架，由上述明细生成；answer 里以"执行记录"出现。 */
  summary: string;
}

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
  /** 写后验证 settle 退避序列（毫秒），透传 executeWrite；默认 [25, 75]。 */
  settleDelaysMs?: number[];
}
