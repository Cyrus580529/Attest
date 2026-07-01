# 切片8 设计定稿：投机执行——三谱系统一为「预测→验证→留下或重同步」

> 状态：已 ship（确定性套件绿），待真模型 live 验收。实现计划见
> `docs/plans/2026-07-01-attest-slice8-speculative-execution.md`。

## 一、动机

读循环一步一问 LLM，长任务往返啰嗦。前沿有三条独立谱系各自缓解：投机执行（跳调用）、
世界模型（行动前预测状态）、记忆/计划缓存（复用过去的功）。Attest 的独特位置在于：
**它为「诚实」早就造好了一个独立于 LLM 的免费环境验证器 `diffSnapshots`。**
一个免费且可信的验证器，就是「可以对模型激进投机」的许可证——猜错了裁判必抓、抓到就回退。

## 二、统一模型

内核的执行路径其实是同一件事，只是预测来源与置信不同：

| 路径 | 预测源 | 置信 | 视界 |
|---|---|---|---|
| 读循环 | 无（一步一验） | — | 1 |
| 记忆重放 | 录制轨迹的 `observedDiff` | 高（过去真成过） | 整条 |
| 世界模型 | 账本学的 (动作→diff) | 按证据 | 任意 |
| 模型 lookahead | 程序节点上的 `predict` | 中 | 整段程序 |

统一动作：执行一步 → `diffSnapshots` 拿实际证据 → `matchesPrediction`（满足档，predict ⊆ actual）
→ 命中零-LLM 前进；漂移/失效/未验证/撞 held → 停下、交回重同步。

## 三、三谱系 → Attest 现有件的复用

| 谱系 | 复用 | 新增 |
|---|---|---|
| ① 投机执行 | `diffSnapshots`/`Evidence`、`executeWrite`、`processCall`、`AgentStep` | `Prediction`+`matchesPrediction`；`runSpeculative` |
| ② 世界模型 | Ledger 的 `write`(refId,verified,evidence)、`pageSignature` | `WorldModel`（learn/predict） |
| ③ 记忆/缓存 | `RecordedStep`/`recordRef`/`resolveRecordedRef`、`PageMemory`、`runProgram` | `RecordedStep.observedDiff`；`fromMemory`；部分重放 |

新增文件仅 4 个小单元 + 若干字段；`attemptReplay` 退役归并进 `runSpeculative`（净减一条特判路）。

## 四、岔路决策

1. **接受判定=「满足」**（predict ⊆ actual）：页面多做别的不算失败。严格档命中率过低、松档接受错变。
2. **预测词汇=diff 词汇子集**：只能断言 `diffSnapshots` 本就产出的 detail 子串，零新观察通道。
3. **记忆漂移=前缀复用 + LLM 补尾**（不续跑录制尾巴）：页面偏离后录制尾巴不可信。红线「记忆只加速不背书」。
4. **世界模型陈旧性由 `pageSignature` 闸门**：签名不同即不召回，错也只浪费一点上下文、绝不误动。
5. **held（高危/推断）= 投机硬围栏**：撞到即停，正常弹框问人，不可投机穿越确认。

## 五、红线分析（为什么碰不到 §一）

- §一.1 只提议：所有写仍经 `executeWrite`→`resolveRef`，预测不命中真实 ref 一律 error。
- §一.3 verify-or-refuse：`diffSnapshots` 仍是唯一真相；预测只决定「要不要少问一次 LLM」，不决定 outcome。
- §一.5 记忆只加速不背书：预测源只供「猜」、从不供「结果」；漂移即回退（决策 3/4 是明写的失效闸门）。
- **defense-in-depth**：Ledger 对投机全然无知，`computeOutcome`/`programFinish` 判定不变。
  **删掉整个投机层，确定性套件仍全绿——它是纯性能层。** `programFinish` 里 `predict` 落空不改 outcome
  已由 `interpreter.test.ts` 显式守卫（mispredict 时 write 仍 verified、outcome 仍 completed）。

## 六、量化（净收益生死线）

投机唯一的成败取决于：`命中率 × 省下的往返 > 预测本身的 token 成本`。
确定性 A/B（`test/core/speculation/bench.test.ts` + `examples/spec-bench.ts`）：
冷跑建记忆用 2 次 LLM，热跑 10 次命中投机 10/10、LLM 调用合计 0——记忆/世界模型路径净收益为正。
模型 lookahead 路径的 token 净收益需真模型 live 量化（接第一开放线的 A/B）。

## 六·补 修订（2026-07-01，同日）：转向「LLM 全程主导」

初版把**记忆零-LLM 逐字重放**当谱系③的落点。真模型 live 后用户判定"显蠢——投机重放直接放宏、LLM 被架空"。据此定调:**一定要有智能感,LLM 必须主导整个系统。** 遂转向:

- **删除**零-LLM 逐字重放整条子系统(含 slice4b 的 `PageMemory` 老功能)、`runSpeculative`/`fromMemory`/`observedDiff`/`memoryKey`。效率不再来自"跳过 LLM"。
- **读循环上 lookahead 当主路**:模型每回合亲自规划,可一次提多步并给 `predict`;命中则连续执行本回合后续步,落空/未验证/取消→中断本轮、把真实结果喂回让模型重规划。**至少 1 次 LLM/任务,模型全程 authored。**
- **世界模型转做先验**:`worldModel.learn` 仍从账本证据学 (签名,动作)→diff,但只**注入上下文**帮模型规划/写 predict,绝不旁路。
- 效率来源从"跳过模型"变为"让模型一次想更远"。真模型 live:第一次 5 回合、第二次(带先验)4 回合,predict 命中 1→2,两次 completed 且诚实。
- 保留并转正:`Prediction`/`matchesPrediction`、`WorldModel`(先验)、程序节点 `predict`、`WriteResult.evidence`。

**教训**:免费 verifier 确实是"可投机"的许可证,但"投机=跳过 LLM"会牺牲智能感;正解是"投机=校验模型的前瞻",让 LLM 始终在驾驶位。

## 七、开放线

- 模型 lookahead 的真模型 live 净收益量化（predict 的 token 成本 vs 省下的往返）。
- 世界模型跨会话持久化（当前进程内 Map）。
- 部分重放的「尾巴续投机」仅对模型 lookahead 源成立，不对固定录像成立（已按决策 3 保守处理）。
