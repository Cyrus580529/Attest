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

## 二、开发流程（每个切片）

```
brainstorm（动引擎前必做）→ spec → plan → TDD 实现 → 自我验证 → 合并
```

- **动核心运行时（loop/verifier/memory 等）前，必须先写 spec/plan 并经用户审阅**；引擎类切片尤其要先 brainstorm + 用户拍板。
- **TDD**：先写失败测试 → 看它红 → 最小实现 → 看它绿 → commit。每个 task 一个 commit，提交信息用 conventional commits。
- 切片别拆太细，3-4 个大切片为宜；纯函数工具可批量写、批量测。
- **YAGNI**：deferred 了混合覆盖、world-model、预测式规划——别为"看起来完整/更颠覆"加当前不需要的东西。赢的是**做透并 ship 的一个机制**，不是落不了地的宏图。

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

**已完成并经真模型验收**（master，125 测试绿）：
- 契约层 / 单 tool-calling 读循环 / 诚实三件套（verifier+ledger+narrationGuard+高危held，Intent Receipt 两阶段）/ 长程+引用 / 页面记忆（零-LLM 重放+失效回退）。
- **切片5 Code-as-Action（已 ship + live 验收）**：opt-in `codeAsAction` 开关 → "交清单"范式。模型一次交 JSON-AST 程序，**可挂起解释器**逐节点对实时快照校验执行；高危挂起式 held + **作用域授权**（y/a/N）；写写独立 verify；**三段式 plan→execute→reflect**（计划预览=高层里程碑 + 💭思考 + 看真实结果后复盘）；outcome 增 `partial`、finish 带证据小结。默认 ping-pong/记忆/读循环**零回归**。设计见 `docs/specs/…slice5…design.md`（§11 opt-in、§12 三段式）。
- live REPL（`/code` 切换）已验证：真用 runProgram、held 真停、scope 授权生效、completed/partial 与账本一致、复盘不谎报。

**两次 live 暴露并已修的诚实洞**（教训：洞都在"叙述/finish 边界"——内核只管经工具路由的动作，管不住模型用散文宣称没干过的事）：① 空账本谎报（直接 finish 编成功）→ 加注+守卫；② 部分取消被掩盖（混合批准/拒绝报 completed）→ partial outcome + 证据小结 + reflect。

**已知开放线**：
1. **记忆学会程序**：`codeAsAction` 路径当前**不接记忆**；接上录制+零-LLM 重放后，开关可转默认、ping-pong 写路径退休。
2. `CandidateSet`/`ReferenceResolver` 已单测但**未接进 live 循环**；与程序 `forEach`/`query` 打通"换一个/就它"。
3. **per-object 账本**：invoke 按动作名记账、不记"作用在哪个对象"，故复盘只能到动作级 tally；记上对象上下文 → 可精确归因（"102 被取消"）。
4. **多程序/重规划**：复盘后若未达成，允许再出一段（当前一段+一次复盘）。
5. **叙述-诚实的原则化**：两个洞都是 reactive 补的；更稳的做法是让用户可见的"结果陈述"由证据账本**生成**，模型只做受约束的措辞（把 verify-or-refuse 从"动作"推广到"叙述"）。
6. 记忆重放双行打印、全成功时冗余证据小结——轻微啰嗦，可收敛。

## 七、命令速查

```bash
npm install
npm test && npm run typecheck && npm run build
npm run repl   # 手动验收对话
```
管理员/业务账号、docker 等 SkillFlow 专属内容此项目不适用，已删去。
