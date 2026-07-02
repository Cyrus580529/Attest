# Attest 开发规则

> 可信、自证的网页 agent 内核。从 SkillFlow/FlowOps 干净重写而来。
> 本文件是这个仓库的开发地基——只保留真正用得上的要领，砍掉重复冗杂。

## 一、架构红线（永不违反）

这些不变量定义了 Attest，是它区别于"抓取式 agent"的根本。任何改动都不得破坏：

1. **模型只提议，harness 校验后才执行**。模型给的 `ref` 必须命中页面真实暴露的对象，否则返回 error、**绝不执行**。不许猜 selector/id/route。
2. **读写分离**。读路径无写工具；写工具单独成组；**高危动作永远 held（默认拒绝）**。
3. **Verify-or-refuse**。每个写动作用"可观察变化"验证；`finish` 的 outcome（completed/failed/cancelled）**由 Evidence Ledger 的证据算出，不信模型自述**。
4. **页面契约是地基**。任何实现 `data-agent-object/action/control/surface` 的页面，零额外代码即可被驱动。**不许把某个业务页写成专用脚本作为主路径**。
5. **记忆只加速，不背书**。Page Memory 命中就零-LLM 重放，但 **verifier 始终是唯一真相**；记忆失效只回退、**绝不谎报或乱动**；高危动作重放时仍 held。
6. **协作式赌注**。Attest 服务"实现契约的页面"，不啃任意陌生站点。别把"无契约 DOM 降级/抓取"做成主路径（如要做，必须先 brainstorm 当独立切片）。

## 二、开发流程（按改动大小裁剪，别一刀切）

核心原则:**流程配得上改动的大小**。小改直接干,别为动几行码写一堆文档——那是负担,不是严谨。

- **小改 / 局部 / 纯函数 / 修 bug**:直接做。有逻辑/边界/会回归的走 TDD(红→绿→commit);改完跑 `npm test` 绿了就提交,**不写 spec/plan**。
- **只有两种情况值得先写下来**:① 改**核心不变量的语义**(loop/verifier/ledger/memory 的判定逻辑)且方案不显然——提交前用几句话(commit body 或一小段 note)说清"为什么这么改、碰了哪条红线";② **跨多回合的大切片**——才值一份简短 plan。其余一律省。
- **brainstorm 只在真有分叉时用**:有多条路要选、或要改架构红线的取舍时才坐下来对齐;不是每个切片的固定关卡。
- **红线不裁**(§一 永远守):verify-or-refuse 不松;**行为变更**在声称"完成"前仍要真模型 live 验收——纯重构例外(绿的既有套件即证行为未变);诚实报告、conventional commits 照旧。
- **YAGNI**:赢的是**做透并 ship 的一个机制**,不是落不了地的宏图。能用成熟库/现成方案就用,别造轮子。

## 三、测试与验收（最重要的教训）

> **"全绿但崩" 是这个项目最贵的一课。** 85 个 FakeLlm 测试全绿时，真模型一跑暴露出：无效写拖垮 outcome、模型省略 ref 前缀、高危 held 够不到、记忆从没记录。这些确定性测试一个都没抓到。

- **确定性测试只证明"机制对"，证明不了"体验好"**。它们用写死脚本的假模型，永远测不出真模型的理解/幻觉/叙述质量。
- **真实 LLM 验收是强制项**，在声称"完成"前必须跑。判定要看**用户可见文字 + 工具顺序 + 页面跳转 + held/failed/completed + 证据账本**；机械、串台、误导、瞎编，都算不通过——哪怕没崩。
- **诚实报告**："代码完成、测试全绿" ≠ "已验收"。永远把两者分开说。
- **先修 bug 再谈重构**。当 agent 显得"机械/范式僵"，先查是不是 bug 在 flail（无效写、ref 错误），别用大重构去掩盖小 bug。

### 怎么跑
```bash
npm test            # 确定性套件（FakeLlm + FakeHost）
npm run typecheck   # vue 无关，纯 tsc
npm run build       # 产出 dist/
npm run repl        # 交互式手动验收（真模型，对 mini-board 说话）
npx vitest run test/live   # 脚本化 live 场景
```
真模型用环境变量（OpenAI 兼容）：`ATTEST_API_KEY` / `ATTEST_BASE_URL` / `ATTEST_MODEL`。
- DeepSeek 实测可用：`https://api.deepseek.com` + `deepseek-*`。
- **Node 里别用 happy-dom 的 fetch 调 LLM**（它强制 CORS）——REPL 已用 Node 原生 fetch 绕开。真浏览器里直连第三方 LLM 会撞 CORS，正经做法是经自己后端中转。

## 四、效率铁律（我们真踩过的坑）

- **提交前先确认绿**。别用 `vitest | grep` 这类管道——它会掩盖 vitest 的非零退出码，导致带着红测试 commit（我们犯过一次）。先看到 "passed" 再 `git add`。
- **工具调用要小而干净**。一次发多个大 Write/Edit、或超长 old_string，容易被解析成 malformed、turn 空收。**一次一个、字符串短**。
- **Agent 报告"成功"必须验证**（grep/read/跑测试），别信报告。
- 长写文件用单个 Write；大段替换用小而唯一的锚点 Edit。

## 五、Git

- **纯本地，暂无远程**；只有用户明确要求才 push。
- 每切片/修复开特性分支，`--ff-only` 合回 master，删分支。
- commit 信息有意义、按 conventional commits；末尾加
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 文档/spec/plan 版本化保留，体现思维演进，不覆盖旧版。

## 六、现状与开放线（2026-06-30）

**已完成并经真模型验收**（master，139 测试绿）：
- 契约层 / 单 tool-calling 读循环 / 诚实三件套（verifier+ledger+narrationGuard+高危held）/ 长程+引用 / 页面记忆（零-LLM 重放+失效回退）/ **切片5 Code-as-Action**（三段式 plan→execute→reflect、`partial`、作用域授权 y/a/N、finish 带证据小结）。

**切片6 程序记忆=配方先验**（已 ship，确定性测试绿，**待真模型 live 验收**）：`codeAsAction` 成功程序按页面签名入 `RecipeBook`，同签名页面召回最近 3 条**注入上下文**作先验，模型仍走完整三段式自判吻合。**重构要点**：#1 原计划的"零-LLM verbatim 重放"被否——goal-string key 严格则永不命中、放松则退化关键字匹配可能召回不吻合的程序而乱动，且零-LLM 旁路了思考。改先验注入更忠于"记忆只加速不背书"；**签名即陈旧性闸门**，记忆错只浪费一点上下文、绝不误动。设计见 `docs/specs/…slice6…design.md`。

**切片7 架构拆分 + 收紧 API**（已 ship，行为零改动重构，绿套件即证）：`loop.ts` 420→50 行，拆成 `loopTypes / prompts / finish / readLoop / programLoop / loop` 六个职责单一单元，闭包边界变显式 `LoopDeps`；`index.ts` 公共面收敛到真用入口 + `test/index.test.ts` 守卫。

**已 ship 的内核优化**：渐进披露（播种 `maxPerType=20`，大页面只露轮廓，真模型 25 工单不编 ref）；写路径单源化（读循环改调 `executeWrite`，verify-or-refuse 只此一处）；复盘回喂 surface 文本（闭合读取类任务缺口）。

**切片8 投机执行 → 转向「LLM 全程主导 + lookahead」**（已 ship，确定性 161 绿，**读循环 lookahead+世界模型先验真模型 live 通过**）：核心洞察不变——为诚实造好的免费验证器 `diffSnapshots` 是"可投机"的许可证。但初版把它落成"记忆零-LLM 逐字重放",真模型 live 后判定"显蠢、架空模型"。**据用户定调「LLM 必须主导整个系统」转向**：① **删除**零-LLM 逐字重放整条子系统(含 slice4b `PageMemory`)、`runSpeculative`/`fromMemory`/`observedDiff`/`memoryKey`;② **读循环 lookahead 当主路**——模型每回合亲自规划、可一次提多步并给 `predict`,命中则连续执行、落空/未验证/取消即中断本轮回模型重规划(≥1 次 LLM/任务,全程 authored);③ **世界模型转做先验**——`worldModel.learn` 从账本证据学 (签名,动作)→diff,只注入上下文帮模型规划,绝不旁路。保留转正:`Prediction`/`matchesPrediction`、`WorldModel`、程序节点 `predict`、`WriteResult.evidence`。**红线守法**:verify-or-refuse/held/账本判定全不动;效率来源从"跳过模型"改为"让模型一次想更远"。真模型 live(deepseek-v4-pro):第一次 5 回合→第二次(带先验)4 回合,predict 命中 1→2,两次 completed 且诚实。设计+修订见 `docs/specs/…slice8…design.md`。

**切片14 写路径加固**（已 ship，确定性 202 绿，**真模型 live 回归通过**（2026-07-02，deepseek-v4-pro：S1-S3/导航/分页/嵌套/T1-T4 全过，settle 与新文案未扰动模型行为）；切片11-13=适配器硬化/上下文管理/浏览器桥，见 git log）：混沌套件（`test/core/chaos.test.ts` 故障注入：任何故障下 loop 必须走到 finish、outcome 与账本一致、绝不裸抛）暴露并修掉四洞——① **TOCTOU**：confirm 可等任意久，执行前重照快照重解析 ref（目标消失即拒），diff 基线取执行前一瞬（防等待期无关变化被归因成证据→假验证污染世界模型）；② **验证 settle**：写后无变化按 25/75ms 退避重照再 diff（页面异步渲染防假"未验证"），未验证文案明示"≠失败勿盲目重试"（防重复副作用）；③ host/confirm 抛异常 → 记账 error/按拒绝处理，不炸穿循环；④ `computeOutcome` 补规则：写工具 error 且其后无验证写（未恢复）→ failed（此前写尝试全 error 也判 completed）。红线只加严不放松。

**切片15 漂移检测**（已 ship，确定性 214 绿，**真模型 live 通过**（2026-07-02，`examples/live-drift.ts` 同签名改版场景：R2 落空→suspect+模型忠于新行为、R3 DRIFT 上报+自愈、模型引用 suspect 警示且澄清"对象非本次新增"，全程诚实））：验证信号的第四吃（安全闸/投机许可证/学习信号之外），兑现 VOIX 定位第三柱"漂移"。同签名下已知动作不再产生已知效果=漂移的确定性证据：写时裁定（每次执行落账即裁定先验，不留给模型）、两级阈值（落空1→suspect 注入带警示，连续2→`DriftEvent`+AgentStep `drift` 上报+自愈采纳新行为/逐出）、形状比较（剥实例 id 比结构，task:9 vs task:10 不误报）、负样本（≥2 次无效果→"勿依赖"反先验）、持久化 v2 兼容 v1。研究谱系（DDM/STALE/SkillGuard/Library Drift/WMA）见 `docs/specs/…slice15…design.md`。

**真模型验收脚本**：`examples/live-check.ts`（玩具看板 S1/S2/S3）、`examples/live-real.ts`（真实工作台 T1-T4）、`examples/live-pages.ts`（导航/分页/嵌套）。绕 happy-dom CORS 用原生 fetch；vitest 的 `test/live` 在 happy-dom 下会撞 CORS，真验收走这两个脚本。

**开放线（优先级序）**：
0. **切片8 收尾**：读循环 lookahead + 世界模型先验已真模型 live 通过(5→4 回合、predict 命中 1→2、诚实)。**未 live 的**：程序模式(codeAsAction)节点 `predict` 的真模型净收益;lookahead 的 token 成本 vs 省下往返需更大样本量化。
0b. **切片9 持久化（已 ship，确定性绿）**：`WorldModel`/`RecipeBook` 加 `toJSON()/fromJSON()`——内核只序列化、不做 I/O（宿主决定存哪）;repl 接入存盘/读盘(`examples/.attest-worldmodel.json`)，跨会话延续先验。让"越用越聪明"跨会话真实存在。
0c. **切片10 骑 VOIX 标准（已 ship，确定性 184 绿 + 真模型 live 通过）**：战略转向——不自造 `data-agent-*` 跟标准打架，改**骑 VOIX**(arXiv 2511.11287/github svenschultze/VOIX)，Attest 定位为**补 VOIX 论文自认不做的三样(outcome 验证/信任/漂移)的信任层**。落点：`ContractSource` 可插拔契约层(parseContract/parseVoix 皆其实现)；`parseVoix`(`<tool>`/`<context>`/`<prop>`带类型参数)；`createVoixHostAdapter`(忠于 VOIX 运行时:`call`/`return` 事件、带 `return` 的 tool 等回传)；`invokeAction(ref,args?)` 贯穿 args(读循环+程序模式)；`ActionNode.params`+serialize 展示。**真模型 live(deepseek-v4-pro)**：T1 带参 add_task 传对 args+verify+completed；T2 高危 clear_all→harness held→拒绝→cancelled+任务未清空+诚实叙述。设计动机见与前沿对比(VOIX/VeriGuard/AAL 已占同方向，Attest 靠"骑标准+补它承认的洞+账本裁决叙述"求小而精的关注度)。
1. **配方"有用"未量**：只证无害（S3 不串味），没做带/不带配方 A/B 比收敛/token。切片8 已搭确定性 A/B 台（`spec-bench.ts`）可复用。量了再决定转默认、ping-pong 退休。
2. **发布工程件**：README / exports map / 版本仍缺——"当库发布"的硬门槛（记忆持久化已由切片9 的 `toJSON/fromJSON` 打通序列化，宿主自接存储）。
3. 多模型验收（现仅 deepseek-v4-pro）；更多真实页面（导航/分页/嵌套）。
4. **叙述-诚实原则化**：结果陈述由账本生成，模型只受约束措辞（把 verify-or-refuse 推广到叙述）。
5. `CandidateSet`/`ReferenceResolver` 接 live（已撤出导出，接进再导出）；per-object 账本；多程序重规划。

## 七、命令速查

```bash
npm install
npm test && npm run typecheck && npm run build
npm run repl   # 手动验收对话
```
管理员/业务账号、docker 等 SkillFlow 专属内容此项目不适用，已删去。
