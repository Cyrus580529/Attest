# Attest 切片 5：Code-as-Action（带信任不变量的程序化动作）设计

> 状态：已与用户在 brainstorm 中逐项拍板（2026-06-30）。本切片为**最小核心**，刻意为"日后往完整核心进化"留干净接缝。

## 0. 一句话

把 agent 的一次动作从「单步 ping-pong 工具调用」升级为「模型一次交出一段 ref 绑定的小程序，harness 逐节点校验+求值」——但**不引入任何新信任模型**，而是用同一套内核（refResolver / verifier / riskPolicy / Ledger / narrationGuard）去驱动这段程序。

## 1. 动机

现状（master）的 act 路径是 observe→act→observe 的单步乒乓：灵活性低、往返多、长程任务显机械。CLAUDE.md 把 Code-as-Action 列为候选 v2 范式。本切片实现它的**最小核心**，目标：

- **更少往返、更自然的长程**：循环/条件在一段程序里表达，而非多轮乒乓。
- **保住全部信任不变量**：模型仍只能引用真实 ref，写仍逐个 verify，高危仍 held，outcome 仍由证据账本算。
- **创新点**：业界 CodeAct（2024）让 agent 写代码当动作，但没有 grounding / verify / held。Attest 的差异组合是 **① 逐节点对实时快照校验、② 写写独立验证、③ 高危可在程序运行中途挂起（suspendable held）、④ 作用域授权、⑤ 程序级证据账本算 outcome**。这是对外叙述（README/博客）的钩子。

## 2. 关键决策（brainstorm 拍板）

| 维度 | 决策 | 备选与否决理由 |
|---|---|---|
| 程序载体 | **JSON AST**，单工具 `runProgram` 交出 | 文本 DSL 需写解析器 + 新增"语法幻觉"失败类，违背"小"与"绝不猜" |
| 解释器 | **async 递归树遍历**，挂起=一句 `await confirm` | 手写 PC+环境的可序列化续延，是记忆重放才需要的，现在做违反 YAGNI |
| 高危确认 | **作用域授权**：首次问 `[y]仅此次 [a]本程序全部该动作 [N]拒`，`a` 入 run 内 scope 集 | 逐个暂停太烦；执行前汇总需"干跑"，与写副作用/动态条件冲突，不健全 |
| 首切片范围 | **最小核心**：DSL+解释器+作用域授权+逐写verify+账本算outcome；**记忆重放程序、接 CandidateSet 全部 defer** | — |

## 3. 架构

```
旧 act:  LLM → 1 tool call → exec → observe → 回灌 → 重复 N 轮
新 act:  观察播种 → LLM → runProgram(JSON AST) → ProgramInterpreter 逐节点(校验+求值+held+verify) → finish(outcome 由账本算)
读循环:  保持不变（readOnly 仍走原 ping-pong 读路径）
```

**论点（安全性的根据）**：Code-as-Action 复用的是同一个内核。每个引用页面的节点在**求值时**对**实时快照** `resolveRef`；每个写节点跑 `diffSnapshots`；每个高危 `invoke` 走 `await confirm`；`finish` 调 `guardFinish`/`computeOutcome`。因此切片不是"放权给模型写代码"，而是"用程序编排被严格把关的原语"。

### 3.1 观察播种与 act 工具集

- 非 readOnly 时，`run()` 在调用 LLM 前先 `host.snapshot()` 并把 `serializeSnapshot` 结果作为初始页面上下文播种进消息（模型据此一次性写出程序；运行期的 `forEach`/`if`/`read` 负责 authoring 时未知的动态信息）。
- act 工具集 = `[runProgram, finish]`。模型要么直接 `finish`（读类/无需写的回答），要么交出一段程序。**写动作只能经程序表达**——这是本范式的本体。
- readOnly 工具集与读路径**完全不动**。

## 4. DSL（slice-1 最小节点集）

程序 = `{ body: Node[] }`。变量环境：`$var → 已解析 object ref id`。

| op | 形态 | 落到现有机制 | 读/写 |
|---|---|---|---|
| `observe` | `{op:"observe"}` | `serializeSnapshot`（少用，保平价） | 读 |
| `forEach` | `{op,query:{type?,status?,labelContains?},as,do:Node[]}` | 入口对**当前快照** objects 过滤，捕获 ref id 列表，逐个绑定 `$as` 执行 do | 读 |
| `if` | `{op,cond:{surface,contains},then:Node[],else?:Node[]}` | 对**实时**快照求 cond | 读 |
| `open` | `{op,on:"$t"}` | `host.openObject` | 读 |
| `read` | `{op,on:"$t"\|{surface:name}}` | `host.readSurface` | 读 |
| `setControl` | `{op,on:{control:name},value}` | `host.setControl` + verify | 写 |
| `invoke` | `{op,action:name}` | `host.invokeAction`，高危→held | 写 |
| `finish` | `{op,answer}` | 终止；outcome 由账本算 | — |

说明：
- 契约是**扁平**的（动作按名页面级、作用于"当前打开的对象"）。因此 `invoke` **不带 `on`**：动作按 name 对实时快照解析，正确性靠"先 `open $t` 再 `invoke`"的程序顺序保证——与今天 ping-pong 的"先 open 再 invoke"同构。
- ref id 由 `kind:key` 确定性生成（`object:ticket:101`、`action:resolve`、`surface:detail`），同页跨刷新稳定。`forEach` 捕获的 id 每次迭代对实时快照重解析；已被 resolve 而消失的对象→命中失败→该节点 error。
- **defer（写进"演进路径"）**：嵌套表达式、算术、`while`、自定义变量赋值、多 surface 比较、`invoke on 具体对象`（待契约支持 object-scoped action 时）。

## 5. 解释器执行模型

`ProgramInterpreter`：async 递归求值，节点处理器一一对应。三件关键事：

1. **实时解析**：`on:"$t"` / `action:name` / `query` 在**求值瞬间**对 `host.snapshot()` 解析。对象增删/陈旧→命中失败→节点 error。
2. **挂起式 held = 一句 `await confirm`**：`invoke` 且 `isHighRisk` → 记 `intent`、yield `held`、`await confirm(intent)`。期间整个递归调用栈（含 `forEach` 循环变量）自然挂起，确认后原地恢复。**零续延机器**。
3. **作用域授权**：解释器持有 `grantedScopes: Set<actionName>`。高危 invoke 时：若 action name 已在集中→直接执行（不再问）；否则 `await confirm` → 返回 `{approved, scope}`，`scope==='all'` 时把 action name 入集。grant 入账本 `{kind:'grant', refId, approved, scope?}`。**verify 始终逐个独立跑，与授权无关**。

### 5.1 节点预算
解释器带 `maxNodes`（默认如 200），求值节点计数超限→中止+failed，防恶性/无界循环。

## 6. 错误与中止语义

- 任一节点 error（ref 未命中 / 未知 op / 写未验证 verified=false）→ **中止整段程序** → 进入隐式 `finish` → outcome 由账本算（多半 `failed`）。
- 高危被拒（`approved=false`）→ 记 `grant{approved:false}` + yield `cancelled`；**程序继续后续节点**（拒一个 resolve 不该中止整批）。outcome 由账本算（无成功写且有拒绝→`cancelled`；有成功写→`completed`）。
- 程序未显式 `finish` 而自然走完 → 隐式 finish（answer 空，guardFinish 补注）。

## 7. 对现有类型/模块的改动

- `src/honesty/types.ts`：`ConfirmFn` 返回值 `{ approved: boolean }` → `{ approved: boolean; scope?: 'once' | 'all' }`（**可选、向后兼容**，旧 confirm 不返回 scope 视作 once）。`grant` 账本项加可选 `scope?: 'once' | 'all'`。
- `src/core/execWrite.ts`（新）：从 `loop.ts#processCall` 写分支抽出 `executeWrite(...)`——resolve + 高危held(含scope) + host 调用 + diffSnapshots + ledger 记账，返回 `{ steps, toolResult, verified, recorded? }`。供解释器复用，亦让单测直接覆盖信任原语。
- `src/core/program/types.ts`（新）：Node/Query/Cond/Program 类型 + `validateProgram`（结构校验，未知 op/缺字段→错误列表）。
- `src/core/program/interpreter.ts`（新）：`ProgramInterpreter`。
- `src/core/tools.ts`：新增 `runProgram` schema；act 工具集改为 `[runProgram, finish]`。
- `src/core/loop.ts`：非 readOnly 分流到程序路径（播种观察→llm→runProgram→interpreter）；readOnly 读循环不变。
- `src/index.ts`：导出程序公共面与类型。

## 8. 不变量逐条保住（验收清单）

| 红线 | 程序执行中如何保住 |
|---|---|
| ① 模型只引用真实 ref | 每个 on/action/query 求值时对实时快照解析，未命中即 error 中止 |
| ② 读写分离 | DSL 节点分读/写组；readOnly 拒绝写节点；写只经 executeWrite |
| ③ verify-or-refuse | 每个写节点跑 diffSnapshots，未变化→ledger verified:false→outcome failed |
| ④ 页面契约是地基 | 解释器只消费 PageSnapshot，不碰 DOM/selector |
| ⑤ 记忆只加速 | 本切片程序路径**不接**记忆（defer），不引入谎报面 |
| ⑥ 高危永远 held | invoke 高危走 await confirm，默认 DENY；scope 授权只省"重复问"，不绕过首次确认；readOnly 无写 |

## 9. 测试策略

- **确定性（TDD，先红后绿）**：`validateProgram`、`executeWrite`（held/verify/scope）、`ProgramInterpreter`（forEach/if/变量/实时解析/错误中止/maxNodes/挂起恢复/scope 授权/verify失败→failed），用 FakeHost + FakeLlm 产 program。
- **Live 验收（强制，声称完成前必跑）**：mini-board 真模型跑"把所有 urgent 工单都 resolve"——判定：held 真弹、作用域授权真生效（选 a 后不再问）、账本与 outcome 一致、用户可见文字不瞎编、工具顺序合理。**牢记项目最贵的教训：全绿 ≠ 验收。**

## 10. 演进路径（往完整核心，本切片刻意留的接缝）

1. **记忆重放程序**：录制整段 program → 同签名零-LLM 重放 → 失效回退。难点是带控制流的程序怎么稳定重放；`execWrite` 已共享，续延序列化届时再上（即 brainstorm 中否决的 PC+环境方案，到那时才有正当性）。
2. **接 CandidateSet / ReferenceResolver**：让 `forEach`/`query` 与跨回合引用（"换一个/就它"）打通。
3. **多程序 / 重规划**：程序跑完后若未达成，允许模型据结果再出一段（当前为一次性一段）。
4. **DSL 扩展**：object-scoped action、while、变量赋值、多 surface 条件——按真实需求逐项加，不预支。

> 每条演进都是独立切片，各自走 spec→plan→TDD→live 验收。本切片不为它们预留实现，只保证**接缝干净**（execWrite 共享、interpreter 与 loop 解耦、节点集开放扩展）。
