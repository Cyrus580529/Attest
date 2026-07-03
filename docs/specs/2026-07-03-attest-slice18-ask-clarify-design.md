# 切片18：主动澄清（ask/askUser）— spec + plan

## 为什么

Route B CRM Easy 批跑（`docs/bench/runs/2026-07-03-crm-easy/report.md`）残留主障碍是
`missing_params`（9 题）+ 同源 `hallucinated_information`（2 题）：agent 拿到参数不全的任务
（未给日期范围/时长/文件路径/字段映射）直接执行、甚至编造缺失值，而非先澄清。

当前 agent 对用户说话只有两个出口：`finish(answer)`（终结性）和 held→`confirm`→send_msg
（被动，仅写动作触发）。**没有主动的"中途向用户提问"能力。** 这是真实、全局良好的缺口，
与 Attest"不确定就问"哲学一脉相承——confirm 管**动作安全**的不确定，ask 管**任务信息**的
不确定，两个同构的宿主回调。

## 关键取舍（非显然，记档）

1. **宿主回调决定阻塞**：`AskFn` 与 `ConfirmFn` 同构。交互宿主（repl/真产品）返回真答案、
   agent 用答案继续；非交互宿主（bench）返回 `{}`（无人应答），agent 自行处置。内核不预设
   阻塞与否。

2. **无人应答时"留空不编造"，而非"编默认值继续"**（核实评测器后修正的关键点）：
   `InputHallucinationEvaluator` 判据=任何 fill/select 值不在 `only_fill` 白名单即违规。
   若无人应答时编造默认值填入（如默认时长 30 分），会**触发 hallucination，与要解的问题
   自相矛盾**。所以诚实行为=**只填任务明确给的值，缺失的可选字段留空交系统默认，绝不编造
   填入**。一条原则同时干净地解 missing_params（问了）+ hallucination（没编填）。

## 组件（读循环；程序模式暂不加，YAGNI）

- `src/honesty/types.ts`：`AskFn = (q:string)=>Promise<{answer?:string}>`；`LedgerEntry` 增
  `{kind:'clarify';question:string;answered:boolean}`。
- `src/core/tools.ts`：`ASK_USER_TOOL`（`askUser(question)`），入 `READ_LOOP_TOOLS`。读性质，
  不改页面、不进 verify-or-refuse。
- `src/core/loopTypes.ts`：`LoopDeps.ask:AskFn`；`AgentStep` 增 `clarify`。
- `src/core/readLoop.ts`（`processCall`）：派发 `askUser`→`ask(q)`→记 `clarify`。有答复
  `toolResult=用户回答：X`；无答复引导"只填任务明确给的值、缺失留空交系统默认、绝不编造"。
- `src/core/loop.ts`：`options.ask?`，默认 no-op（`async()=>({})`=无人应答，不炸）。
- `src/core/prompts.ts`：加一条通用原则（见下）。
- `src/core/finish.ts`：`FinishFacts` 体现澄清计数；`summary` 加一句。**outcome 计算不动**
  （clarify 非写）。
- `examples/bench-st/bridge.ts`：`ask = q => { execute(send_msg_to_user(q)); return {} }`。
- repl：`ask` 读 stdin 真答案（展示交互宿主对标 confirm）。

系统提示原则：
> 任务的关键参数缺失或有歧义时，先用 askUser 向用户澄清。任务未提供的值绝不编造填入——
> 继续时只用任务明确给的值，缺失的可选字段留空交由系统默认，并在最终回答里说清你做的假设。

## 红线核对

verify-or-refuse：askUser 是读、不碰 ✓；held/高危：不变 ✓；诚实账本：clarify 只增记录、
不改 outcome、facts 体现 ✓；§二·五 不词表：系统提示是通用原则、模型自主问什么、bench
透传不塞词 ✓。

## Plan（TDD，逐步）

1. types：`AskFn` + `LedgerEntry.clarify`。
2. tools：`ASK_USER_TOOL` 入读循环工具集（红：期望工具存在的测试）。
3. loopTypes：`LoopDeps.ask` + `AgentStep.clarify`。
4. readLoop：`processCall` 派发 askUser（红→绿：有/无答复两路 toolResult 与记账）。
5. loop：`options.ask` + 默认 no-op。
6. finish：facts 体现 clarify；computeOutcome 不受影响（加守卫测试）。
7. prompts：原则条。
8. bridge：ask 回调；repl：ask 读 stdin。
9. `npm test` + `typecheck` 全绿。
10. live 重跑 239/243/240：send_msg 出现、missing_params + hallucination 双消、CR 不倒退。
