# Attest

> 可信、自证的网页 agent 内核。模型只**提议**动作，harness 校验页面真实暴露的 `ref` 后才执行；每个执行型动作都留下可验证证据，**留不出证据就不准声称成功**。

不是又一个"抓取 DOM 操作任意网站"的 agent。Attest 走相反的赌注：让页面通过 `data-agent-*` 契约**主动配合** agent，换取**可靠、安全、可审计、可长程自主**的执行。

- **ref 绑定 + harness 校验**：模型给的 ref 必须命中页面真实暴露的对象，否则不执行（根除幻觉动作）。
- **verify-or-refuse**：执行后采集可观察变化作证据；终答的 `outcome` 由证据账本计算（`completed`/`failed`/`cancelled`），**不信模型自述**。
- **高危 held**：提交/兑换/审批等高风险动作先暂停等确认（Intent Receipt），默认拒绝。
- **页面记忆**：走通一次的轨迹按"页面形状 + 目标"记下，下次同类**零-LLM 重放**；verifier 兜底，记忆失效自动回退 LLM。

provider 无关，默认 OpenAI 兼容（DeepSeek / kamiapi / 任意兼容端点均可）。

---

## 安装

```bash
npm install
```

## 跑测试（看它真的成立）

```bash
npm test          # 85 个确定性测试（FakeLlm + FakeHost，无需联网/key）
npm run typecheck
npm run build     # 产出 dist/
```

## 跑真实 LLM（playground）

`test/live/playground.live.test.ts` 用真实模型在示范页 `examples/mini-board` 上跑三场景：长程读取、高危 held、零-LLM 记忆重放。**没设 key 时自动跳过。**

PowerShell：

```powershell
$env:ATTEST_API_KEY="<你的key>"
$env:ATTEST_BASE_URL="https://www.kamiapi.top/v1"   # OpenAI 兼容端点；OpenAI 官方则用 https://api.openai.com/v1
$env:ATTEST_MODEL="gpt-5.5"                          # 任意支持 function-calling 的模型
npx vitest run test/live
```

终端会打印每一步：`observe / action(verified) / held / ⚡replay / FINISH[outcome]` 以及证据账本。

---

## 在你自己的代码里用

```ts
import { createAgent, createDomHostAdapter, createOpenAiAdapter, PageMemory } from 'attest-agent';

const agent = createAgent({
  llm: createOpenAiAdapter({
    apiKey: process.env.ATTEST_API_KEY!,
    baseUrl: 'https://www.kamiapi.top/v1', // 可选，默认 OpenAI 官方
    model: 'gpt-5.5',
  }),
  host: createDomHostAdapter(),            // 浏览器里读 document 的 data-agent-* 契约
  memory: new PageMemory(),                // 可选：开启页面记忆
  confirm: async (intent) => ({            // 高危动作确认；默认拒绝
    approved: window.confirm(`确认执行「${intent.label}」？`),
  }),
});

for await (const step of agent.run('看看有哪些工单，挑一个看详情后告诉我')) {
  console.log(step); // observation / action / held / replay / finish ...
  if (step.type === 'finish') {
    console.log('结论：', step.answer, '| 状态：', step.outcome);
    console.log('证据账本：', step.ledger);
  }
}
```

> `createDomHostAdapter` 需要浏览器 DOM。Node 环境可用 `happy-dom` 提供 `document`，或用内置的 `FakeHostAdapter` 写测试。

## 页面怎么"对 agent 友好"（契约）

页面用 DOM 属性声明可操作对象，内核读取紧凑语义快照而非生 DOM：

```html
<li data-agent-object="ticket:101">登录页 500 错误</li>   <!-- 可引用/打开的对象 type:id -->
<button data-agent-action="open">打开</button>             <!-- 可触发的动作 -->
<button data-agent-action="resolve" data-agent-risk="high">标记已解决</button>  <!-- 高危=先 held -->
<input data-agent-control="note" />                        <!-- 可读写控件 -->
<section data-agent-surface="detail">…</section>           <!-- 可读取的区域 -->
```

实现了这套契约的**任何新页面**，零额外代码即可被 Attest 读取、引用、规划、执行。

## 核心概念

| 概念 | 作用 |
|------|------|
| `PageSnapshot` | 由 `data-agent-*` 解析出的对象/动作/控件/区域 + 稳定 `ref` |
| `refResolver` | 校验 ref 真实存在且 kind 匹配，非法即 error |
| `verifier` | 写动作后对比前后快照，可观察变化即证据 |
| `Ledger` | append-only 证据账本（observe/intent/grant/write） |
| `narrationGuard` | 由账本计算 `outcome`，禁止把失败/取消叙述成成功 |
| `PageMemory` | 轨迹记忆 + 零-LLM 重放 + 失效回退（verifier 兜底） |

## 状态

v1 核心完整（契约 / 读循环 / 诚实层 / 长程 + 引用 / 页面记忆），85 测试全绿。真实 LLM 端到端验收清单见 `docs/LIVE-ACCEPTANCE.md`。
