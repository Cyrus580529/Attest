# Attest 切片 4 设计：长程自主 + 跨回合引用 + 页面记忆

> 状态：设计稿，已审。日期：2026-06-29。
> 依赖：切片 1（契约/快照）、切片 2（读循环/refResolver/OpenAI）、切片 3（诚实层 verifier/ledger/held）。

## 0. 一句话
切片 4 让 Attest 自主跑完多步任务，并在重复时凭"页面记忆"近乎零-LLM 完成——长程（深度）× 记忆（机制）× 可验证（诚实）三合一。

## 1. 范围（原切片4 + 新机制）
- **CandidateSet**：跨回合引用"换一个/就它/随便选"，并供 planRunner 选候选。
- **planRunner**：subgoals/cursor/visited，进多个详情页读取后综合。
- **Page Memory**（新机制）：签名索引的 verified 轨迹 → 零-LLM 重放，verifier 兜底失效回退。
- **示范应用**：极小非 SkillFlow 埋点页，演示长程 + 记忆重放。
- **真实 LLM 验收**：多步任务 + Ledger 对账 + "第二次零 LLM"记忆 demo。
- **不做（留切片5）**：用记忆做前瞻规划/预测；完整 A*/BFS 规划器；复杂跨实例参数化泛化。

## 2. CandidateSet（跨回合引用）
按 domain 保存候选，解决跨回合指代。
```ts
interface CandidateSet {
  domain: string; presented: Ref[]; cursor: number;
  selected: Ref | null; rejected: Ref[]; sourceRoute: string;
}
```
ReferenceResolver 优先级（明确不猜）：当前页绑定对象 > route 参数 > CandidateSet 当前 cursor/最近 presented > 用户明确名称 > 要求澄清。支持 `这个/那个/第二个/换一个/就它/随便选`。纯结构解析，不重启旧 mission。

## 3. planRunner（长程自主）
```ts
interface PlanState {
  goal: string; subgoals: SubGoal[]; cursor: number;
  visited: string[]; synthesis: string[];
}
```
驱动 loop 跨多个对象："进 N 个详情页逐个读再综合"必须真的逐页 openObject→readSurface→记账，不能只读列表后反问。每步沿用切片 2/3 的 observe→act→verify→ledger。读型长程任务不走 action verifier，只引用只读证据。

## 4. Page Memory（本切片核心）
### 4.1 是什么
agent 把"在某种页面、为某目标、走通的 verified 轨迹"记下，下次同类命中直接重放，零 LLM。
### 4.2 索引键（可靠性关键）
`key = pageSignature(snapshot) + '|' + goalKey(goal)`
- `pageSignature` = route 模板 + 排序后的 object 类型集 + action 名集 + control 名集 + surface 名集（只取"形状"，不含具体 id/数据）。例 `/tasks|obj:task|act:apply,filter|ctrl:|surf:`。换数据（task:42→43）仍命中同签名。
- `goalKey` = 归一化目标串（v1 简单归一化，模糊命中由 verifier 兜底）。
### 4.3 记什么
```ts
interface RecordedStep { tool: string; refRole?: RefRole; value?: string; }
interface MemoryEntry { signature: string; goalKey: string; steps: RecordedStep[]; recordedAt: number; }
```
**refRole 跨实例重定位（可靠性核心）**：action/control/surface 的 ref 名跨实例稳定（`action:apply` 每页一样）→ 按名重放；object 的 id 变（task:42）→ 按"角色"重放（记"CandidateSet 选中的第 N 个/匹配目标的那个"），重放时由 ReferenceResolver/CandidateSet 在当前实例重新解析。
### 4.4 重放流程
```
查 memory[key]:
  命中 → 逐步重放：按 refRole 在当前 snapshot 重解析 ref（refResolver 校验）→ 执行 → verifier 对账
    任一步 ref 解析不出 / 验证与记忆不符 → 中止重放，从当前态回退正常 LLM 循环 + 重新记录
    全部通过 → finish（零 LLM），ledger 标 'replayed from memory'
  未命中 → 正常 LLM 循环，成功后记录新轨迹
```
### 4.5 可靠 & 诚实不变量
- verifier 永远是唯一真相：记忆只加速、从不背书；记错只触发回退（变慢），绝不谎报或乱动。
- 高危动作重放时仍走 held：记忆省"想"不省"确认"。
- 重放 ledger 与正常运行同构，可审计。
### 4.6 诚实边界
v1 泛化有限：结构差异大则重放失效回退（安全，非 bug）；goalKey 简单归一化靠 verifier 兜底；不做预测/前瞻。

## 5. 示范应用
极小非 SkillFlow 埋点页（迷你任务板/商店），含 `data-agent-*`，演示：长程读多详情、跨回合引用、高危 held、第二次零-LLM 重放。

## 6. 公共 API 增量
```ts
createAgent({ llm, host, confirm, memory?: PageMemory });
// 新 step: { type: 'replay'; source: 'memory'; tool; refId }
```

## 7. 测试与验收
- TDD：CandidateSet/ReferenceResolver、planRunner 推进、pageSignature、memory 记录/命中/失效回退，全用 FakeLlm+FakeHost。
- 诚实测试：记忆"记错"必须回退而非谎报；高危重放仍 held；重放 ledger 与正常同构。
- Live 验收闸（需 key）：① 长程多详情综合；② 换一个/就它；③ 同任务第二次零-LLM 重放（plannerSource llm→memory）；④ 改页面结构 → 记忆失效自动回退。

## 8. 执行拆分
v1 最大切片，拆两份计划各自可交付：
- **4a — 长程自主 + 引用 + 示范**：CandidateSet/ReferenceResolver/planRunner/示范应用。先让长程跑通（有东西可记）。
- **4b — 页面记忆**：pageSignature/PageMemory/重放+失效回退/replay step/记忆 demo。叠在 4a 上。

## 9. 开放问题
1. refRole 对 object 跨实例重定位是记忆可靠性关键，需 4b live 打磨。
2. goalKey 归一化（过松误命中/过严不命中）靠 verifier 回退兜底，需 live 调。
3. 示范应用领域选择：避免太像 SkillFlow，又能体现长程+高危+记忆。
