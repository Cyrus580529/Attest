# Attest 切片 5：Code-as-Action 实施计划

> REQUIRED SUB-SKILL: superpowers:executing-plans。Steps 用 `- [ ]`。
> Spec：`docs/specs/2026-06-30-attest-slice5-code-as-action-design.md`。**最小核心**，为日后完整核心留干净接缝。

**Goal:** act 路径从单步乒乓升级为「模型一次交出 JSON AST 小程序，解释器逐节点对实时快照校验+求值」，复用同一信任内核——只引用真实 ref、写写 verify、高危可中途挂起 held（作用域授权）、outcome 由证据账本算。readOnly 读循环不变；记忆/CandidateSet defer。

**Architecture:** 单工具 `runProgram` 交结构化程序；`ProgramInterpreter` async 递归求值，挂起=`await confirm`；写原语 `executeWrite` 从 loop 抽出共享；不变量逐条映射到现有 refResolver/diffSnapshots/riskPolicy/Ledger/guardFinish。

## 文件结构
- `src/core/program/types.ts`（Node/Query/Cond/Program + validateProgram）
- `src/core/execWrite.ts`（共享写原语）
- `src/core/program/interpreter.ts`（求值器）
- `src/honesty/types.ts`（ConfirmFn scope / grant.scope，向后兼容）
- `src/core/tools.ts`（runProgram schema；act 集 = [runProgram, finish]）
- `src/core/loop.ts`（act 分流到程序路径）
- `src/index.ts`（导出）

---

## Task 1：Program AST 类型 + 结构校验
**Files:** `src/core/program/types.ts`；`test/core/program/validate.test.ts`

测试（纯函数，先红）：① 合法程序（嵌套 forEach/if/invoke/finish）通过；② 未知 op→错误；③ forEach 缺 query/as→错误；④ invoke 缺 action→错误；⑤ if 缺 cond/then→错误；⑥ 非数组 body→错误。

实现：定义 `Node`（observe/forEach/if/open/read/setControl/invoke/finish 的可辨识联合）、`Query`、`Cond`、`Program = { body: Node[] }`；`validateProgram(p): string[]`（空数组=合法）。纯结构校验，不碰快照。

Commit: `feat(program): JSON AST 类型 + validateProgram 结构校验`

---

## Task 2：共享写原语 executeWrite + 作用域授权
**Files:** `src/honesty/types.ts`、`src/core/execWrite.ts`；`test/core/execWrite.test.ts`

先改类型（向后兼容）：`ConfirmFn` 返回 `{ approved: boolean; scope?: 'once' | 'all' }`；`grant` 账本项加可选 `scope?`。`computeOutcome` 不变。

`executeWrite(host, ledger, confirm, grantedScopes, { tool, refId, value? }): Promise<{ steps, toolResult, verified }>`：
- resolve(before, refId, writeKind) 失败→error step + ledger。
- invokeAction 且 isHighRisk：若 actionName ∈ grantedScopes→直接执行（confirmed=true，不再问）；否则记 intent、held step、`await confirm` → grant 入账本（含 scope）；`approved=false`→cancelled step；`scope==='all'`→grantedScopes.add(actionName)。
- 执行 host.setControl/invokeAction → diffSnapshots → ledger write（verified=changed）→ action step。confirmed 时 toolResult 注明"已由用户确认"。

测试（FakeHost + 脚本化 confirm）：① 低危写 verified；② 高危默认 DENY→cancelled、无 write 记账；③ 高危 approve(once)→执行 + verify；④ 高危 approve(all)→scope 入集、同名第二次不再调 confirm；⑤ 写无变化→verified:false；⑥ ref 未命中→error。

Commit: `feat(core): executeWrite 共享写原语 + 作用域授权（ConfirmFn scope/grant.scope）`

---

## Task 3：ProgramInterpreter
**Files:** `src/core/program/interpreter.ts`；`test/core/program/interpreter.test.ts`

`runProgram(program, { host, ledger, confirm, maxNodes }): AsyncGenerator<AgentStep, Outcome>`：
- async 递归求值，每节点计数，超 maxNodes→error 中止。
- `observe`→serialize；`forEach`→对当前快照过滤 query、捕获 ref id 列表、逐个绑定 env[as] 执行 do；`if`→对实时快照求 cond（surface contains）选 then/else；`open/read`→resolve $var 或 surface→host 调用；`setControl/invoke`→委托 executeWrite（传 grantedScopes）；`finish`→终止。
- 任一节点 error 或写 verified=false→中止；高危 cancelled→继续后续。
- 走完/finish→收尾，返回由 ledger 算的 outcome。

测试（FakeHost）：① forEach 遍历多对象、env 绑定正确；② if 真/假分支；③ 实时解析（do 内 open 后 surface 变，if 命中）；④ ref 未命中→中止；⑤ maxNodes 超限→中止 failed；⑥ 高危 held 挂起→approve 后恢复继续循环；⑦ scope=all 一次授权批量 resolve 不重复问；⑧ 写未验证→failed。

Commit: `feat(program): ProgramInterpreter（async 求值 + 挂起 held + 错误中止 + maxNodes）`

---

## Task 4：loop 集成（act → runProgram/finish）
**Files:** `src/core/tools.ts`、`src/core/loop.ts`；`test/core/loopHonesty.test.ts`（迁移）

- tools.ts：新增 `runProgram` schema（参数 `{ program }`）；`ACT_TOOLS = [runProgram_tool, finish_tool]`。READ_LOOP_TOOLS 不变。
- loop.ts：非 readOnly 时，run() 先播种 `serializeSnapshot(host.snapshot())` 进初始上下文；llm.step 返回 `runProgram`→交 ProgramInterpreter 驱动（yield 其 steps，用其 outcome finish）；返回 `finish`→直接收尾；readOnly 路径完全不变。系统提示补：act 模式用 runProgram 表达多步/写动作。
- 迁移 loopHonesty 测试：原先 FakeLlm 直接发 invokeAction/setControl 的写/held/outcome 用例，改为发 runProgram(程序) 表达，断言 held/verify/cancelled/completed/failed 与账本一致（验证不变量在新范式下不变）。

测试：① 程序完成→completed、账本一致；② 高危 held→默认拒→cancelled；③ approve→completed + 证据；④ 写未验证→failed；⑤ 直接 finish（无程序）正常；⑥ readOnly 读循环回归绿。

Commit: `feat(core): loop act 路径切到 runProgram + 解释器（读循环不变，honesty 测试迁移）`

---

## Task 5：导出 + Live 场景 + 全量验证
**Files:** `src/index.ts`；`docs/LIVE-ACCEPTANCE.md`；（可选）`test/live/playground.live.test.ts`

- 导出 Program 类型、validateProgram、ProgramInterpreter、executeWrite 及 scope 相关类型。
- Live 闸补：mini-board "把所有 urgent 工单 resolve" —— held 真弹、作用域授权（选 a 不再问）、账本/outcome 一致、文字不瞎编。
- 全量 `npm test && npm run typecheck && npm run build`（先看到 passed 再提交，勿用管道掩盖退出码）。

Commit: `feat(api): 导出 Code-as-Action 公共面 + Live 闸补程序场景`

---

## 验收
- npm test 全绿（切片 1–5）；typecheck 0；build 含 program/execWrite。
- 不变量：模型只引用真实 ref；写写 verify；高危默认 held、作用域授权不绕过首次确认；outcome 由账本算。
- **Live（需 key，强制）**：批量 resolve 走通——held 真弹、scope 真生效、账本与 outcome 一致、叙述不机械不瞎编。声称"完成"前必跑，且把"代码完成/测试全绿"与"已验收"分开报告。

## 自审
- Spec §4 节点集与 Task 1 类型一致；§5 三件事（实时解析/挂起held/作用域授权）在 Task 2+3 落地。
- 向后兼容：ConfirmFn scope 可选；旧 confirm 视作 once；computeOutcome 不变。
- 接缝（演进路径）：execWrite 共享、interpreter 与 loop 解耦、节点集开放——记忆重放/CandidateSet/多程序 defer，不预支实现。
