// ── 契约层：实现契约（VOIX 或 data-agent-*）的页面零额外代码即可被驱动 ──
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

// ── 可插拔契约来源：内核信任核心跑在 PageSnapshot 上，契约格式可换 ──
export type { ContractSource } from './contract/contractSource';
// 骑 VOIX 标准（arXiv 2511.11287）：Attest 补它明确不做的 outcome 验证/信任/漂移
export { parseVoix } from './contract/voix';

// ── host 适配器 ──
export type { HostAdapter, HostResult } from './host/types';
export { createDomHostAdapter } from './adapters/domHostAdapter';
export type { DomHostAdapterOptions } from './adapters/domHostAdapter';
export { createVoixHostAdapter } from './adapters/voixHostAdapter';
export type { VoixHostAdapterOptions } from './adapters/voixHostAdapter';
// 真实浏览器后端（Playwright 等）：把信任核心接到实时页面（benchmark / 真实站）
export { createBrowserHostAdapter } from './adapters/browserHostAdapter';
export type { BrowserHostAdapterOptions, ParseWithElements } from './adapters/browserHostAdapter';
export type { BrowserPage } from './adapters/browserPage';
export { parseVoixWithElements } from './contract/voix';
export type { VoixParseResult } from './contract/voix';

// ── LLM 适配器 ──
export type { LlmAdapter, LlmMessage, LlmToolCall, LlmTurn, ToolSchema, LlmRole } from './llm/types';
export { createOpenAiAdapter, LlmRequestError } from './llm/openaiAdapter';
export type { OpenAiAdapterOptions } from './llm/openaiAdapter';

// ── 内核：创建并驱动 agent ──
export { createAgent } from './core/loop';
export type { AgentStep, AgentOptions, FinishFacts } from './core/loop';
export { serializeSnapshot } from './core/serialize';

// ── Code-as-Action：构造 / 校验 / 执行程序 ──
export { validateProgram } from './core/program/types';
export type { Program, Node, Query, Cond } from './core/program/types';
export { runProgram } from './core/program/interpreter';
export type { InterpreterDeps, ProgramResult } from './core/program/interpreter';

// ── 记忆 / 先验（opt-in，传给 createAgent）──
export { RecipeBook } from './memory/recipeBook';
export type { Recipe } from './memory/recipeBook';

// ── 投机执行（谱系②世界模型 opt-in；预测原语类型）——先验注入，LLM 仍主导 ──
export { WorldModel } from './memory/worldModel';
export type { DriftEvent, PriorLookup, WorldModelJSON } from './memory/worldModel';
export type { Prediction } from './core/speculation/prediction';

// ── 诚实层：检视 AgentStep 结果所需的类型 ──
export type { Intent, Evidence, LedgerEntry, Outcome, ConfirmFn } from './honesty/types';

// ── 测试双适配器（供库使用者写测试）──
export { FakeLlmAdapter, toolCallTurn, textTurn } from './testing/fakeLlmAdapter';
export { FakeHostAdapter } from './testing/fakeHostAdapter';
// ── 集成方工具：自定义 HostAdapter 的合规检查器（见 docs/integrating.md）──
export { checkHostContract } from './testing/hostChecks';
export type { HostCheckResult, HostCheckOptions } from './testing/hostChecks';
