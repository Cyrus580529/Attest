# 切片6：程序记忆——配方先验（design）

> 2026-06-30。开放线 #1 的重构落地。范围只做①：把记忆接进 `codeAsAction` 路径。不转默认、不退休 ping-pong（独立后续切片）。

## 一、动机与重构

开放线 #1 原话是「录制 + **零-LLM 重放**」。brainstorm 时戳破了这个前提：

- 记忆 key 是 `pageSignature + goalKey(userMessage)`，`goalKey` 只小写化+压空格。这把记忆逼进两难：key 严格 → 逐字相同才命中，几乎没用；key 放松 → 退化成**关键字匹配**，可能命中语义不吻合的程序，然后零-LLM 把它当真执行——比没用更危险（会乱动）。
- 零-LLM 重放还把 plan→execute→reflect 三段式思考整个旁路，体验从 agent 退回宏录制。

**重构**：记忆不做 verbatim 重放，改做**先验/配方**——让模型变快变稳，思考与验证都不旁路。

## 二、设计

**新模块 `src/memory/recipeBook.ts`**（独立、单一职责；读循环 `PageMemory` 一行不动 → 零回归）：

```ts
interface Recipe { program: Program; goal: string; recordedAt: number; }
class RecipeBook {
  record(signature: string, recipe: Recipe): void;    // 按 AST 去重
  recall(signature: string, limit: number): Recipe[]; // 最近 N 条去重
}
```

- **Key = `pageSignature(snapshot)` 单独用**（复用现成函数，**不用 `memoryKey`**——目标从 key 拿掉）。逃出关键字圈套的那刀。
- **录制**（`runProgramMode` 收尾）：`outcome === 'completed' && !aborted` 时 `record(sig, {program, goal: userMessage, recordedAt})`；AST 相同不重复存。
- **召回+注入**（`runProgramMode` 开头，播种快照之后）：`recall(sig, 3)`，每条格式化成 **目标标签 + 紧凑 JSON 程序**，作为「本页已验证可用的配方」拼进 user 消息。
- **注入用 JSON-AST 而非里程碑**：里程碑给用户看计划；要让模型复用/改写，得给可再发的结构（action 名、query 类型）。
- **接线**：`AgentOptions` 加 opt-in `recipes?: RecipeBook`（与 `memory?` 并列）；REPL `/code` 注入一个实例，让会话内配方累积复用。

## 三、不变量（比 verbatim 重放严格更安全）

1. **签名即陈旧性闸门**。`pageSignature` 含 route + 对象类型 + action/control/surface 名。配方引用的名字只有仍存在时签名才相同 → 召回的配方永远引用当前契约真实存在的名字；契约一变签名变，旧配方召不回。
2. **记忆错了只浪费一点上下文，绝不误动**。配方只是参考；不吻合则模型弃用，或用了被解释器在该节点 error→abort，reflect 仍按真实账本诚实复盘。记忆从「可能背书谎报」降级成「可能给个没用的提示」——红线 #5 落地。
3. **诚实三件套零改动**。outcome 仍由 `programFinish` 按本次账本算，verifier 唯一真相，高危仍 held，partial/cancelled 判定不变。记忆碰不到 outcome 计算。

## 四、测试

**确定性（FakeLlm）**：① completed → 入库；② 同签名二次运行 → recipe 块出现在 messages；③ AST 去重；④ 召回上限 3；⑤ partial/cancelled/failed/aborted **不**入库；⑥ 不同签名 → 召回空；⑦ 注入配方**不改变** outcome（喂会被取消的场景，断言仍 partial）。

**Live（强制验收，§三）**：判据不是全绿，是真模型下注入配方后**真的更快收敛/合理复用**，且**绝不因配方误动或谎报**；同页连做两次同类任务，看第二次有无「见过世面」感而不机械。

## 五、范围外（后续切片）

- codeAsAction 转默认、ping-pong 写路径退休（开放线 #1 的②③）。
- 跨会话持久化（当前 RecipeBook 内存态，够 live 验收）。
