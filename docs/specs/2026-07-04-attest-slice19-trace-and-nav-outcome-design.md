# 切片19 设计：trace.jsonl 产品化 + nav 类型归因（阶段1）

- 日期：2026-07-04
- 背景：CRM Hard（265-294）诊断复查发现 `computeOutcome` 的真实缺口——账本里只要有
  一次 verified 写、无懸而未决信号，就默认 `completed`，但这条写可能只是导航（点了
  一个模块/tab 链接），任务真正要求的动作从未执行。已加过一轮小修（askUser 悬而未决
  不默认 completed），但堵不住"导航类写冒充完成证据"这条。见
  `docs/bench/runs/crm-hard/report.md` 的更正段落。
- 定位：codex 提出的工程成熟度十条建议里，用户选定优先做 4 项（trace 产品化 / bench
  runner CLI / public adapter API / replay-regression），本设计是第一阶段，其余三项
  按此地基顺延排期（bench runner 复用 trace 格式；replay 直接吃 trace.jsonl；adapter
  API 文档待前三者接口稳定后补充）。PolicyEngine（可配置 allow/deny）与 npm 拆包两条
  明确搁置：前者和"高危动作永远 held、默认拒绝"红线有实质张力，需单独设计"只能收紧
  不能放宽"的边界；后者项目还没做过第一次 npm 发布，本末倒置。

## 一、trace.jsonl（结构化，不留原始消息全文）

**数据来源**：loop 本来就产出 `AgentStep[]` 序列（`src/core/loopTypes.ts`），trace.jsonl
就是这串东西逐行序列化（加序号+ISO 时间戳），外加收尾时的 `FinishFacts`。不新建独立
的"trace"概念，只是让已有的执行记录变成宿主可落盘、可重放消费的稳定格式。

**改动**：
1. `AgentStep` 的 `action` 变体加一个可选 `args?: unknown`——`execWrite.ts` 执行时本来
   就手握 `setControl`/`invokeAction` 的调用参数，顺手带出来，成本很低。
2. 新增 `serializeTrace(steps: AgentStep[], facts: FinishFacts): TraceEvent[]`（放
   `src/core/trace.ts`）：给每个 step 加 `seq: number` 和 `ts: string`（ISO），facts 序列化
   成最后一条 `{ type: 'finish', seq, ts, facts }`。**内核只返回可序列化的数组，不做
   文件 I/O**——写盘是宿主的事（bench runner / repl 各自决定路径），沿用切片9持久化的
   先例（`WorldModel.toJSON()`模式）。
3. `ts` 用什么时钟：内核里不能用 `Date.now()`（与本仓库风格一致——纯函数、不碰系统
   时钟），改为 `serializeTrace` 接受一个可选 `now: () => string` 参数（默认注入
   `() => new Date().toISOString()`），方便测试里传固定时钟。

**不做的事**：不捕获 LLM 原始 system prompt / messages 全文；不做隐私脱敏（页面内容
本来就会出现在 evidence/surface 文本里，属于既有行为，不因 trace 新增风险）。

**产出物**：`src/core/trace.ts` + 单测（给定一串 AgentStep + facts，产出预期的
TraceEvent[]，seq 递增、finish 事件在最后）。

## 二、`ActionNode.category` + nav 归因

**新字段**：`src/types.ts` 的 `ActionNode` 加 `category?: 'nav'`（可选，缺省不设，
不破坏任何现有字面量构造或测试）。

**打标规则**（纯结构信号，不看目标文本、不看叙述，两处实现）：

1. `src/contract/inferFromAxTree.ts`（AXTree/bench 路径）：
   - `visit()` 递归时新增一个 `insideNav: boolean` 参数（类似已有的 `lastText` 就近
     追踪写法）：进入 `role === 'navigation' | 'menubar' | 'tablist'` 的节点时置真，
     传给子递归。
   - 打 action 时：`role === 'tab'` → 一律 `category: 'nav'`；`role` 属于
     `link/menuitem/button` 且 `insideNav === true` → `category: 'nav'`。

2. `src/contract/inferContract.ts`（DOM 路径）：现有代码已经用
   `el.closest('nav, footer')` 排除导航里的 `<li>` 不当对象——比照这个前例，在识别
   action（`ACTION_ROLES` 命中）时补一条：`el.closest('nav, [role="navigation"],
   [role="menubar"], [role="tablist"]')` 命中，或 `el.getAttribute('role') === 'tab'`
   → `category: 'nav'`。

**`computeOutcome` 改动**（`src/honesty/ledger.ts`）：
1. `LedgerEntry` 的 `write` 变体加 `navLike?: boolean`。
2. `execWrite.ts` 记账时：如果这次写的目标 ref 解析出的 `ActionNode.category ===
   'nav'`，记 `navLike: true`（`ControlNode` 没有 category 概念，`setControl` 写永远
   `navLike` 不设/false——不在这轮改动范围内，见下方"已知覆盖边界"）。
3. `computeOutcome` 新规则：`const verifiedSubstantive = writes.some(w => w.verified
   && !w.navLike)`；`const verifiedAny = writes.some(w => w.verified)`；如果
   `verifiedAny && !verifiedSubstantive`（有 verified 写，但清一色是导航类）→
   `'failed'`。和现有的 `lastDoubt` 恢复规则同形：后面一旦出现非 nav 的 verified 写，
   `verifiedSubstantive` 自然变真，规则自动不再触发——不需要额外的位置追踪。
   **完全不动"空账本→completed"的既有默认**（`writes.length === 0` 时这条新规则不
   生效，走原有逻辑）。

**已知覆盖边界（本轮明确不追）**：这套规则能抓住"点导航/tab 链接后直接 finish"的
干净模式（今天诊断里的 267/276/292）。**抓不住** 272 复跑那种"搜索框+点开一条搜索
结果打开记录，然后就停"的模式——选中搜索结果不是导航打标，仍会被判"实质写"。这需
要更进一步的证据形状启发式（整页替换 vs 单对象定点变更），当前没有足够真实夹具能
验证清楚，留作命名的后续候选，不在本轮硬撑。

## 三、测试计划

- `test/core/trace.test.ts`：给定 AgentStep[] + facts + 固定 `now`，验证输出的
  TraceEvent[] 形状与顺序。
- `test/contract/inferFromAxTree.test.ts`（已有文件）：加夹具——顶部模块导航
  `role=navigation` 包裹的链接 → `category:'nav'`；记录详情页 Actions 下拉菜单里的
  "Delete"（`role=menuitem`，父级是普通 `role=menu` 非 `menubar`）→ 无 `category`
  （仍是普通 action）；`role=tab` → 一律 `category:'nav'`。
- `test/contract/inferContract.test.ts`（已有文件）：DOM 版同等夹具（`<nav>` 包裹的
  `<a>` vs 记录页 dropdown 里的按钮）。
- `test/honesty/ledger.test.ts`：新增用例——全部 verified 写都 `navLike:true` →
  `failed`；混合一条非 nav 的 verified 写 → `completed`（不受影响）；空账本不受影响
  （现有用例已覆盖，确认不回归）。
- 真实复验：用今天已经跑过的真实 SuiteCRM AXTree dump（`.scratch/ax235.json` 等，或
  重新 dump 一份含顶部模块导航的登录后页面）过一遍 `inferFromAxTree`，确认真实模块
  导航链接被打上 `category:'nav'`、Actions 菜单里的操作项不受影响——这是"两证齐全"
  纪律里的真实页面那一证（合成夹具是另一证）。
- 真模型抽样复验：重跑 267/276/292（导航后直接 finish 的模式）确认 outcome 从
  `completed` 变 `failed`；重跑一个正常能删除成功的任务（如 236 或本轮 Hard 里某个
  真正走完删除流程的题）确认不误伤。

## 四、风险与红线核对

- 红线1（模型只提议、harness 校验）：不涉及，`category` 是契约推断阶段产出的只读
  元数据，不影响 ref 解析逻辑本身。
- 红线3（verify-or-refuse，outcome 由账本裁决）：本改动**加严**而非放松——把一类此
  前被误判 completed 的情况改判 failed，方向与红线一致。
- 不引入任何模型自述影响 outcome 的新路径（narration 依旧不参与 outcome 计算）。
- 覆盖边界已在设计里写明、不过度承诺——避免"看起来修好了"但实际只堵住部分模式的
  误导。
