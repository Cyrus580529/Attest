# 切片17 叙述-诚实原则化：facts 由账本生成，narration 归模型

日期：2026-07-02。前置：切片16（goalMet 自评降级）。

## 动机

finish 的叙述混着两类内容：

1. **"我做了什么"**——执行了哪些动作、验证几个、谁被取消。账本里全有，可机制化生成。
2. **"我看到了什么 / 答案是什么"**——读取类任务的主体，只有模型能说。

现状：answer 全文由模型写，guardFinish 事后把 caveat **插进模型的话里**。执行事实的
声明权在模型手里，机制只能补丁。外部评审点的"部分机制靠 prompt 纪律维持"即指此处；
开放线 4（把 verify-or-refuse 推广到叙述）的兑现就是本切片。

## 设计原则（用户定调）

- **模型必须保有叙述自由度，不牵着鼻子走**。narration 一字不改、不审查、不重写。
- 机制是**并列对照**（facts 永远站在 narration 旁边），不是消音。
- prompt 用**告知**不用禁令："系统会附上账本生成的执行记录，你不必逐项复述统计"——
  模型想自然地说"已帮你解决 3 个工单"完全可以；说错了事实块自动拆穿。

## 形态：finish step 拆字段

```ts
{
  type: 'finish',
  facts: FinishFacts,    // 账本硬生成，模型碰不到
  narration: string,     // 模型原话：转述所见 + 回答用户
  answer: string,        // 兼容拼接 = narration + '\n' + facts.summary
  outcome: Outcome,      // 顶层保留（= facts.outcome）
  ledger: LedgerEntry[], // 原始凭证，原样保留
}

interface FinishFacts {
  outcome: Outcome;
  verified:    { tool: string; refId: string; evidence: string[] }[];
  unverified:  { tool: string; refId: string }[];
  cancelled:   { refId: string; label?: string }[];
  writeErrors: { tool: string; detail: string }[];
  summary: string;       // 人话骨架，由上述明细生成
}
```

## 要点

- **outcome 计算逻辑一行不动**（红线3 只加强）：读循环 `computeOutcome` + goalMet 降级、
  程序模式 partial 规则 + goalMet，全保留。`buildFacts(entries, outcome)` 只吃算好的
  outcome + entries，产出明细与 summary。
- **文案单源**：guardFinish 的 caveat、programFinish 的 notes、factualLedgerSummary 的
  计数句式，收编进 summary 生成一处（factualLedgerSummary 本身留给上下文压缩用）。
- **guardFinish 退役**：caveat 不再是"事后补丁"，是 facts.summary 的常规组成。
  goalMet 降级逻辑保留（narrationGuard 保留 `FinishClaim` 与降级函数）。
- **两模式统一**：finishStep / programFinish 都走 buildFacts。
- **工具与提示**：finish 的 answer 参数描述与系统提示改为"告知"式（见设计原则）。
- **联动**：facts 是未来可视 demo 证据面板的直接数据源。

## 兼容

answer 拼接顺序 narration 在前（回答用户）、summary 在后（执行记录）——与现状
"answer + 后置 caveat"同构，既有 `answer.toContain('未获确认')` 类断言按构造仍过。
宿主只读 answer/outcome 的零迁移成本。

## 测试与验收

TDD：buildFacts 各 outcome 形态单测；两循环 finish step 结构（facts/narration/answer）；
goalMet 仍生效；空账本警示照旧。行为变更 → 真模型 live 回归
（live-check + live-suite + live-goalmet，等 ATTEST_API_KEY）。

## 已知风险

模型可能在 narration 里仍复述统计——重复但不撒谎，靠告知式 prompt 引导，live 看效果再收。
