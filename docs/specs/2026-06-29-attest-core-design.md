# Attest 内核设计 (v1)

> 状态：设计稿，待审。
> 日期：2026-06-29
> 来源：从 SkillFlow / FlowOps 提炼，干净重写内核。

---

## 0. 一句话

**Attest 是一个框架无关的网页 agent 内核：模型只提议动作，harness 校验页面真实暴露的 ref 后才执行；每个执行型动作必须留下可验证证据，留不出证据就不准声称成功。**

它把"自主完成多步任务"和"不撒谎、可审计"绑在一起——这是它和主流网页 agent 的根本区别。

---

## 1. 目标

- **为谁**：想把网页 agent 用在"真正要紧的动作"（提交、兑换、审批、付款）上的开发者；以及把本项目作为 AI agent 工程能力代表作的作者本人。
- **解决什么**：主流网页 agent（DOM/视觉抓取派）覆盖力强但**不可靠、不安全、会谎报成功**，无法用于有后果的动作。Attest 用"页面契约协作 + 校验 + 证据"换取在配合页面上的**可信自主执行**。
- **成功标准**：
  1. 一个框架无关的纯 TS 内核，公共 API ≤ 2 个接口（host、llm）。
  2. 在自带的极小示范应用上，跑通"多步自主任务 + 高危 held + 跨回合引用"，且产出一份可读的 Evidence Ledger。
  3. 跑真实 LLM 回合验收（非确定性探针），输出体验自然、不谎报。
  4. 代码本身经得起开源审视：模块单一职责、可单测、无 god file。

### 战略定位（已拍板，约束本设计）
- **产物边界**：纯前端 TS 引擎库（不是全栈 starter，不是协议标准）。
- **关注策略**：信誉优先，再放大声量。
- **招牌深度**：可靠与诚实三件套（verifier + held + ledger + narration guard）+ 微型契约协议外壳。
- **亮点轴**：**长程自主 × 可验证**（不在覆盖力上找亮点——那是最弱、对手最强的轴）。
- **架构定位**：ReAct 家族的现代形态——**单一原生 tool-calling 循环**，在其上加三层纪律 + 页面契约。**不是**新拓扑，差异化在加固层。
- **默认 LLM**：OpenAI（可换）。

---

## 2. 架构

### 2.1 分层

```
Host App (Vue/React/原生)
  · 页面用 data-agent-* 声明可操作对象
  · 实现一个薄 hostAdapter
        │  PageSnapshot ↑ / 执行 ref 动作 ↓
Attest Core (纯 TS, 无框架依赖)
  contract     → 解析 data-agent-* 为 PageSnapshot(带 ref)
  loop         → 单一 tool-calling 循环 (observe→decide→act/read→verify→record→continue)
  refResolver  → 校验 ref + 解析"这个/换一个/就它" (基于 candidateSet)
  candidateSet → 跨回合候选记忆
  planRunner   → 长程任务: subgoals / cursor / visited / 综合
  riskPolicy   → 高危动作 held 闸
  verifier     → 执行型动作的成功证据
  ledger       → Evidence Ledger, 每步回执 (一等输出)
  narrationGuard → 终答 completed/failed/cancelled 边界, 禁止谎报
        │  chat + tool-calling
llmAdapter (默认 OpenAI, 可换)
```

### 2.2 核心不变量（架构红线，从 FlowOps 继承）

1. **模型只提议，harness 裁决**：模型发 tool_call 带 `ref`；harness 用 `refResolver` 校验 ref 是否页面真实暴露，非法即返回 error，**绝不执行猜测的 ref/selector/route/id**。
2. **读循环不可写**：读路径无任何写工具；写工具单独存在，且高危仍 held。
3. **Verify-or-refuse**：执行型动作必须产出证据（route 变 / 对象可见 / 控件值 / 业务状态变）；产不出就不声称成功。
4. **叙述受 narration guard 约束**：终答不得把失败/held 叙述成成功。
5. **通用而非脚本**：实现契约的新页面零额外 TS 即可被驱动；禁止业务 mission 脚本作为主路径。
6. **高危 held 内建在循环**：提交/兑换/发消息/审批/付款必须暂停等确认，不是事后补丁。

### 2.3 一个用户回合的流转

1. 用户发话 → loop 启动。模型上下文 = GoalFrame + 当前 PageSnapshot + CandidateSet 摘要 + Ledger 摘要 + 可用工具。
2. 模型发 tool_call。
3. harness 校验 ref（非法 → error，模型须重新 grounding 或要求澄清）。
4. 读型 → hostAdapter 执行 → 观察写入 ledger。
5. 写型 → riskPolicy：高危 → held 暂停等确认；否则执行 → verifier 收集证据 → 写入 ledger。
6. 循环至 `finish()` → narrationGuard 拿终答与 ledger 对账 → 输出用户可见文字。

---

## 3. 公共 API

```ts
const agent = createAgent({ llm, host, policy });

for await (const step of agent.run(userMessage)) {
  // step ∈ observation | action | verification | held | finish
  // 每个 step 均已进 ledger; finish 前过 narrationGuard
}
```

两个接口即全部解耦面：

```ts
interface HostAdapter {
  snapshot(): PageSnapshot;                 // 读取当前页 data-agent-* 契约
  execute(ref: Ref, op: Op, value?: unknown): Promise<ExecResult>;
  navigate(ref: Ref): Promise<NavResult>;
}

interface LlmAdapter {
  // provider 无关的 tool-calling 一轮
  step(messages: Message[], tools: ToolSchema[]): Promise<LlmTurn>;
}
```

---

## 4. 页面契约 (data-agent-*) — 微协议

页面通过 DOM 属性声明可操作对象，内核读取**紧凑语义快照**而非生 DOM。

| 属性 | 含义 | 产出 |
|------|------|------|
| `data-agent-object="<type>:<id>"` | 一个可被打开/引用的领域对象（task/product/message…） | object ref |
| `data-agent-action="<name>"` | 一个可触发的动作（apply/redeem/send…），可带 `data-agent-risk="high"` | action ref |
| `data-agent-control="<name>"` | 一个可读写的控件（输入/选择/开关） | control ref |
| `data-agent-surface="<name>"` | 一块可读取内容的区域（详情/摘要） | surface ref |

`ref` 由内核生成，绑定到上述声明；模型只能引用内核给出的 ref。**v1 只支持契约模式；无注解页面的 DOM 降级留 v2。**

---

## 5. 工具集（loop 的动作面）

读型（read loop）：
- `observePage()` — 当前页快照
- `readSurface(ref)` — 读一块区域内容
- `openObject(ref)` — 打开一个对象（进详情/选中）
- `rankCandidates(axis)` — 对当前候选按某轴排序/推荐
- `navigate(ref)` — 跳到受信 route

写型（act，单独门）：
- `setControl(ref, value)` — 写控件
- `invokeAction(ref)` — 触发动作（高危 → held）

终止：
- `finish(answer)` — 产出用户可见终答（过 narration guard）

---

## 6. 诚实机制（招牌深度）

- **verifier**：每个 act 工具声明期望证据类型；执行后采集实际证据比对，写入 ledger。
- **ledger**：append-only 回执流，每条 = `{ step, kind, ref?, observed, evidence?, outcome }`。可序列化、可渲染成"小票"。这是对外可视化资产。
- **narrationGuard**：终答前裁决——若声称"已完成"但 ledger 无对应 verified 证据 → 改写为 failed/uncertain。
- **riskPolicy / held**：高危动作返回 held 状态，暂停循环，等宿主确认后才继续。

---

## 7. 长程自主 (planRunner) — 亮点轴

- 表达 subgoals / cursor / visited / selected / rejected / retry / strategy-switch。
- 典型："进 N 个详情页逐个读取后综合汇报"必须真的逐页进入读取，不能只读列表后反问。
- 每一步 observe → decide → act/read → verify/record → continue。
- 自主任务结束时，连同 Ledger 一并交付——**自主执行 + 可信回执**就是亮点。

---

## 8. 适配器

- **hostAdapter**：宿主框架各写一个薄实现。v1 自带一个原生 DOM 参考实现 + 极小示范应用。
- **llmAdapter**：默认 OpenAI（tool-calling）。provider 无关，DeepSeek/Claude 可插。

---

## 9. v1 范围 (YAGNI)

**做**：契约模式可靠内核 + ledger + verifier + held + narrationGuard + planRunner（长程自主）+ candidateSet/refResolver（跨回合引用）+ 一个原生 DOM hostAdapter + 一个极小示范应用 + 完整测试。

**不做（留后续）**：
- 无注解页面的 DOM 降级"混合覆盖"（v2，看是否为覆盖付出稀释内核的代价）。
- 完整 benchmark 套件 + 揭露文章（v2 冲声量）。
- React/Vue 官方 adapter 包（v1.x）。
- 后端无状态 loop 服务（v1 前端驱动即可）。

---

## 10. 仓库结构（建议）

```
Attest/
  src/
    core/        loop, refResolver, candidateSet, planRunner
    contract/    data-agent-* 解析 → PageSnapshot
    honesty/     verifier, ledger, narrationGuard, riskPolicy
    adapters/    domHostAdapter, openaiLlmAdapter
    types.ts
    index.ts     公共 API (createAgent)
  examples/
    minimal-app/ 极小示范应用 (已埋 data-agent-*)
  test/
  docs/specs/
```

---

## 11. 测试与验收（按 FlowOps 铁律）

- **TDD**：verifier / narrationGuard 的"拒绝谎报"语义必须先有测试。
- **确定性探针不算验收**：纯函数探针只验路由/策略层，证明不了对话质量。
- **必须跑真实 LLM 回合**：真实 OpenAI 应答，断言 `plannerSource=llm`、无 fallback，人工检查输出体验（闲聊/导航/只读总结/推荐/引用跟进/高危 held）。
- **示范应用关键路径**：多步自主任务 + 一个 held + "换一个/就它"引用，并核对 Ledger 与实际轨迹一致（无"工具失败但回复声称成功"的矛盾）。

---

## 12. 性能

- 单 tool-calling 循环天然比旧 5 段流水线少 LLM 往返。
- PageSnapshot 序列化保持紧凑（只含语义 ref + 标签，不含生 DOM）。
- 每回合 LLM 往返设上界，避免 runaway。
- 目标：不比 SkillFlow 原版差。

---

## 13. 与其他架构的差异（对外叙事用）

| 架构 | 动作方式 | 命门 |
|------|------|------|
| ReAct（文本动作） | 文本里解析动作 | grounding 松、幻觉动作、不验证、叙述能撒谎 |
| DOM/视觉抓取 | 下标/坐标/selector | 漂移脆、无风险闸、无成功证据、token 重 |
| 后端 tool-calling | 调注册后端函数 | 不绑活页面控件、harness 直接信模型参数 |
| 多段 LLM 流水线（旧 FlowOps） | 固定阶段链 | token 贵、延迟高、阶段漂移 |
| **Attest** | **ref 绑定、harness 校验、verify-or-refuse、ledger 回执、页面契约** | 需页面配合（刻意的赌注，非缺陷） |

**定位**：主流优化覆盖力（操作任意站点），Attest 优化可信（配合站点上可靠+诚实+安全自主）。这是真实分叉，而"可信"恰是当前 agent 最被诟病、最没人系统解决的那端。

---

## 14. 开放问题 / 风险

1. **包名 `attest` 可能在 npm 已被占用**（如 @arktype/attest）——发布前需查，可能用 scope（`@<user>/attest`）或变体。仓库/品牌名仍用 Attest。
2. planRunner 的长程编排是最难的一块，需先 brainstorm 切片再动引擎。
3. verifier 证据类型的取舍需在真实 LLM 回合中迭代，不能纸面定死。
4. 示范应用要足够"非 SkillFlow"，以证明通用性，但又不能大到喧宾夺主。
