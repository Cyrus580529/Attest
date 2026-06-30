# 切片7：loop.ts 架构拆分 + 收紧 API（plan）

> 2026-06-30。**行为不变**重构——目标:把 420 行编排器拆成职责单一单元,让内核够格当"简约可靠的基础小内核"。现有 136 测试 + typecheck 是契约,每步即测保持绿。

## 目标布局

```
src/core/
  loopTypes.ts    ← AgentStep 联合类型 + LoopDeps 上下文接口（叶子模块,防循环依赖）
  prompts.ts      ← defaultSystemPrompt, programSystemPrompt
  finish.ts       ← finishStep, factualLedgerSummary, formatRecipes,
                     programFinish(ledger,answer,aborted)→step  ← 诚实叙述聚一处
  readLoop.ts     ← processCall, attemptReplay, runReadLoop(deps, msg)
  programLoop.ts  ← runProgramLoop(deps, msg)
  loop.ts         ← 瘦身 createAgent:组 LoopDeps、选 loop;re-export AgentStep/AgentOptions（API 稳定）
```

**LoopDeps** = `{ llm, host, tools, systemPrompt, confirm, memory?, recipes?, maxSteps }`。两个 loop 现为 `createAgent` 闭包,抽成函数后依赖经此对象显式传入——把糊在一起的边界变成明确接口。loop.ts 420 → ~130 行。

## 执行顺序（每步一 commit,测试绿才进下一步）

1. `loopTypes.ts`:抽 AgentStep + 定义 LoopDeps;loop.ts re-export AgentStep。
2. `prompts.ts`:移两个 system prompt。
3. `finish.ts`:移 finishStep/factualLedgerSummary/formatRecipes + 把 runProgramMode 内联的 programFinish 抽成纯函数。
4. `readLoop.ts`:移 processCall/attemptReplay/run → runReadLoop(deps,msg)。
5. `programLoop.ts`:移 runProgramMode → runProgramLoop(deps,msg)。
6. loop.ts 瘦身为 createAgent 编排;`npm test && typecheck && build` 全绿。
7. 收紧 index.ts:撤下未真用的导出——RefMinter、recordRef/resolveRecordedRef、REF_TOOL_KINDS/WRITE_REF_KINDS、candidatesFromSnapshot、summarizeProgram、executeWrite,以及未接 live 的 CandidateSet/candidatesFromSnapshot/resolveReference/PlanRunner（代码与单测保留,仅停止导出）。

## 不变量

行为零改动:工具集、outcome 计算、verifier、高危 held、记忆/配方路径全不动。判据=136 测试仍全绿 + typecheck + build。纯结构重构,不借机改语义。
