import type { LlmAdapter } from '../llm/types';
import type { HostAdapter } from '../host/types';
import type { ConfirmFn } from '../honesty/types';
import { READ_LOOP_TOOLS, ACT_TOOLS, PROGRAM_ACT_TOOLS } from './tools';
import { RecipeBook } from '../memory/recipeBook';
import type { WorldModel } from '../memory/worldModel';
import { defaultSystemPrompt, programSystemPrompt } from './prompts';
import { runReadLoop } from './readLoop';
import { runProgramLoop } from './programLoop';
import type { AgentStep, LoopDeps } from './loopTypes';

export type { AgentStep, FinishFacts } from './loopTypes';

export interface AgentOptions {
  llm: LlmAdapter;
  host: HostAdapter;
  confirm?: ConfirmFn;
  readOnly?: boolean;
  maxSteps?: number;
  systemPrompt?: string;
  /** opt-in：act 模式改用 Code-as-Action（[runProgram, finish]）。 */
  codeAsAction?: boolean;
  /** opt-in：codeAsAction 路径的配方先验——成功程序录入、同签名页面召回注入（不做 verbatim 重放）。 */
  recipes?: RecipeBook;
  /** opt-in：世界模型（谱系②）——验证写即学 动作→diff，作为下次同页任务的先验注入（LLM 仍主导）。 */
  worldModel?: WorldModel;
  /** 上下文 token 预算（估算，char/4）；读循环历史超此值即压缩。默认 24000。 */
  maxContextTokens?: number;
  /** 写后验证 settle 退避序列（毫秒）：慢异步渲染页面（如 Angular）可加长，默认 [25, 75]。 */
  settleDelaysMs?: number[];
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_CONTEXT_TOKENS = 24_000;
const DENY: ConfirmFn = () => Promise.resolve({ approved: false });

/** 组装运行上下文，按模式分派到读循环或 Code-as-Action 程序循环。 */
export function createAgent(options: AgentOptions) {
  const programMode = !options.readOnly && !!options.codeAsAction;
  const deps: LoopDeps = {
    llm: options.llm,
    host: options.host,
    tools: options.readOnly ? READ_LOOP_TOOLS : programMode ? PROGRAM_ACT_TOOLS : ACT_TOOLS,
    systemPrompt: options.systemPrompt ?? (programMode ? programSystemPrompt() : defaultSystemPrompt()),
    confirm: options.confirm ?? DENY,
    recipes: options.recipes,
    worldModel: options.worldModel,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    maxContextTokens: options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
    settleDelaysMs: options.settleDelaysMs,
  };

  function run(userMessage: string): AsyncGenerator<AgentStep> {
    return programMode ? runProgramLoop(deps, userMessage) : runReadLoop(deps, userMessage);
  }

  return { run };
}
