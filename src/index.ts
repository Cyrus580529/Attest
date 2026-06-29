// 契约层
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
export { RefMinter } from './contract/refs';

// host
export type { HostAdapter, HostResult } from './host/types';
export { createDomHostAdapter } from './adapters/domHostAdapter';
export type { DomHostAdapterOptions } from './adapters/domHostAdapter';

// llm
export type { LlmAdapter, LlmMessage, LlmToolCall, LlmTurn, ToolSchema, LlmRole } from './llm/types';
export { createOpenAiAdapter } from './llm/openaiAdapter';
export type { OpenAiAdapterOptions } from './llm/openaiAdapter';

// core
export { createAgent } from './core/loop';
export type { AgentStep, AgentOptions } from './core/loop';
export { resolveRef } from './core/refResolver';
export type { RefResolution } from './core/refResolver';
export { READ_LOOP_TOOLS, WRITE_TOOLS, ACT_TOOLS, REF_TOOL_KINDS, WRITE_REF_KINDS } from './core/tools';
export { serializeSnapshot } from './core/serialize';

// core 4a：跨回合引用 + 长程追踪
export { CandidateSet, candidatesFromSnapshot } from './core/candidateSet';
export { resolveReference } from './core/referenceResolver';
export type { Reference } from './core/referenceResolver';
export { PlanRunner } from './core/planRunner';

// honesty 诚实层
export type { Intent, Evidence, LedgerEntry, Outcome, ConfirmFn } from './honesty/types';
export { diffSnapshots } from './honesty/verifier';
export { actionRisk, isHighRisk } from './honesty/riskPolicy';
export { Ledger, computeOutcome } from './honesty/ledger';
export { guardFinish } from './honesty/narrationGuard';

// testing 双适配器（供库使用者写测试）
export { FakeLlmAdapter, toolCallTurn, textTurn } from './testing/fakeLlmAdapter';
export { FakeHostAdapter } from './testing/fakeHostAdapter';
