// ── 契约层：实现 data-agent-* 的页面零额外代码即可被驱动 ──
export type {
  Ref,
  RefKind,
  Risk,
  ObjectNode,
  ActionNode,
  ControlNode,
  SurfaceNode,
  PageSnapshot,
} from './types';
export { parseContract, parseContractWithElements } from './contract/parseContract';
export type { ContractParseResult } from './contract/parseContract';

// ── host 适配器 ──
export type { HostAdapter, HostResult } from './host/types';
export { createDomHostAdapter } from './adapters/domHostAdapter';
export type { DomHostAdapterOptions } from './adapters/domHostAdapter';

// ── LLM 适配器 ──
export type { LlmAdapter, LlmMessage, LlmToolCall, LlmTurn, ToolSchema, LlmRole } from './llm/types';
export { createOpenAiAdapter } from './llm/openaiAdapter';
export type { OpenAiAdapterOptions } from './llm/openaiAdapter';

// ── 内核：创建并驱动 agent ──
export { createAgent } from './core/loop';
export type { AgentStep, AgentOptions } from './core/loop';
export { serializeSnapshot } from './core/serialize';

// ── Code-as-Action：构造 / 校验 / 执行程序 ──
export { validateProgram } from './core/program/types';
export type { Program, Node, Query, Cond } from './core/program/types';
export { runProgram } from './core/program/interpreter';
export type { InterpreterDeps, ProgramResult } from './core/program/interpreter';

// ── 记忆（opt-in，传给 createAgent）──
export { PageMemory } from './memory/pageMemory';
export { RecipeBook } from './memory/recipeBook';
export type { Recipe } from './memory/recipeBook';

// ── 诚实层：检视 AgentStep 结果所需的类型 ──
export type { Intent, Evidence, LedgerEntry, Outcome, ConfirmFn } from './honesty/types';

// ── 测试双适配器（供库使用者写测试）──
export { FakeLlmAdapter, toolCallTurn, textTurn } from './testing/fakeLlmAdapter';
export { FakeHostAdapter } from './testing/fakeHostAdapter';
