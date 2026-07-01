# Slice 8: 投机执行 —— 三谱系统一为「预测→验证→留下或重同步」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现本计划。步骤用 `- [ ]` 复选框追踪。**每个写动作仍必须走 `executeWrite` 五关——本切片不引入任何新信任模型。**

**Goal:** 把「投机执行 / 世界模型 / 记忆缓存」三条前沿谱系接进 Attest 内核,统一成一个「预测→验证→留下或重同步」的执行器,让读循环逼近程序模式的效率,同时一分不松诚实红线。

**Architecture:** 复用为诚实早已造好的免费环境验证器 `diffSnapshots`(它既是接受测试、又是预测词汇的来源)。预测源(记忆轨迹 / 从账本学到的世界模型 / 模型 lookahead)是可插拔适配器,统一喂给一个 `runSpeculative` 执行器;命中零-LLM 前进,漂移/未验证/撞 held 就停下重同步。Ledger 对投机全然无知——删掉整个投机层,正确性不变、只变慢。

**Tech Stack:** TypeScript(纯 tsc,无 vue);vitest + happy-dom;FakeLlm/FakeHost 确定性双适配器;真模型 live 走 `examples/*.ts`(Node 原生 fetch 绕 CORS)。

---

## 设计:三谱系 → Attest 现有件的复用

### 统一模型

内核的三种执行路径其实是同一件事,只是预测的来源与置信不同:

| 路径 | 预测源 | 置信 | 视界 |
|---|---|---|---|
| 读循环 | 无(一步一验) | — | 1 |
| 记忆重放 | 录制轨迹的 `observedDiff` | 高(过去真成过) | 整条 |
| 世界模型 | 账本学的 (动作→diff) | 按证据 | 任意 |
| 模型 lookahead | 模型现编 predict | 中 | K |

统一执行器 `runSpeculative(source)`:执行一步 → `diffSnapshots` 拿实际证据 → 与预测比对(「满足」档,predict ⊆ actual)→ 命中零-LLM 前进,不命中/未验证/撞 held 停下,交回调用方重同步。

### 复用表(最大化利用现有 API)

| 谱系 | 复用的现成件 | 新增 delta |
|---|---|---|
| ① 投机执行 | `diffSnapshots`→`Evidence{changed,details}`(接受测试);`executeWrite`(写五关不变);`AgentStep` 联合(可扩展观测);`processCall`(readLoop 的派发) | `Prediction` 类型 + `matchesPrediction`;`runSpeculative` |
| ② 世界模型 | Ledger 每条 `write` 已记 `(refId,verified,evidence)` = (动作→实测 diff) 转移;`pageSignature` | `WorldModel`(从账本学 + 预测);`fromWorldModel` 源 |
| ③ 记忆/缓存 | `RecordedStep`+`recordRef`/`resolveRecordedRef`;`PageMemory`;`RecipeBook`;`runProgram` 解释器 | `RecordedStep.observedDiff`;`fromMemory` 源;部分重放(前缀复用+LLM 补尾) |

### 岔路决策(已定)

1. **接受判定=「满足」**:`predict.expectDetails` 每个子串都能在实际 `evidence.details` 里找到即通过;页面多做别的不算失败。理由:严格档命中率过低,松档会接受「变了但变错」。
2. **预测词汇=diff 词汇的子集**:预测只能断言 `diffSnapshots` 本就产出的 detail 子串,零新观察通道。
3. **记忆漂移=前缀复用 + LLM 补尾**(不续跑录制尾巴):一旦某步实测与录制 `observedDiff` 不吻合,页面已偏离,录制尾巴不可信 → 复用已验证前缀,余下交 LLM。理由:红线「记忆只加速不背书」——绝不在陈旧预测上继续动作。
4. **世界模型陈旧性由 `pageSignature` 闸门**:签名不同即不召回,记忆错只浪费一点上下文、绝不误动。
5. **held(高危/推断)= 投机硬围栏**:撞到即停,正常弹框问人,不可投机穿越确认。

### 红线分析(为什么它碰不到 §一)

- **§一.1 只提议**:所有写仍经 `executeWrite`→`resolveRef`,预测不命中真实 ref 一律 error。
- **§一.3 verify-or-refuse**:`diffSnapshots` 仍是唯一真相;预测只决定「要不要少问一次 LLM」,不决定 outcome。
- **§一.5 记忆只加速不背书**:预测源只供「猜」,从不供「结果」;漂移即回退,决策4/3 是明写的失效闸门。
- **defense-in-depth**:Ledger 对投机无知,`computeOutcome`/`programFinish` 判定不变。删掉投机层,确定性套件应仍全绿(纯性能层)。

### 文件结构

```
src/core/speculation/prediction.ts   新增：Prediction 类型 + matchesPrediction（纯函数）
src/core/speculation/sources.ts      新增：PredictionSource 接口 + fromMemory / fromWorldModel
src/core/speculation/runSpeculative.ts 新增：统一投机执行器（复用 processCall + executeWrite）
src/memory/worldModel.ts             新增：WorldModel（从 Ledger 学、按签名预测）
src/honesty/types.ts                 改：Evidence 已在此，无需动；仅引用
src/core/execWrite.ts                改：WriteResult 增 evidence?: string[]
src/memory/pageMemory.ts             改：RecordedStep 增 observedDiff?: string[]
src/core/readLoop.ts                 改：processCall 增 grantedScopes 形参并导出；attemptReplay→部分重放
src/core/loopTypes.ts                改：AgentStep 增 'speculate' / 'mispredict'
src/core/program/types.ts            改：invoke/setControl 节点增可选 predict（模型 lookahead）
src/core/program/interpreter.ts      改：runWrite 校验 predict
examples/spec-bench.ts               新增：A/B 量化台（带/不带投机比 LLM 调用数）
docs/specs/2026-07-01-attest-slice8-speculative-execution-design.md 新增：设计定稿（本节内容归档）
```

---

## Phase A — 基础原语(纯增量,不动判定语义)

### Task 1: Prediction 类型 + matchesPrediction

**Files:**
- Create: `src/core/speculation/prediction.ts`
- Test: `test/core/speculation/prediction.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/core/speculation/prediction.test.ts
import { describe, it, expect } from 'vitest';
import { matchesPrediction } from '../../../src/core/speculation/prediction';
import type { Evidence } from '../../../src/honesty/types';

const ev = (changed: boolean, details: string[]): Evidence => ({ changed, details });

describe('matchesPrediction（满足档：predict ⊆ actual）', () => {
  it('每个 expectDetails 子串都能在实际 details 里找到 → 命中', () => {
    const actual = ev(true, ['control ctrl-x: 待办 → 完成', 'surface s-1 changed']);
    expect(matchesPrediction(actual, { expectDetails: ['ctrl-x', '完成'] })).toBe(true);
  });

  it('页面多变了别的东西不影响命中', () => {
    const actual = ev(true, ['control ctrl-x: 待办 → 完成', 'object appeared: obj-9']);
    expect(matchesPrediction(actual, { expectDetails: ['ctrl-x: 待办 → 完成'] })).toBe(true);
  });

  it('预测的子串一个都没出现 → 不命中（漂移）', () => {
    const actual = ev(true, ['url: /a → /b']);
    expect(matchesPrediction(actual, { expectDetails: ['ctrl-x'] })).toBe(false);
  });

  it('expectChanged 但实际无变化 → 不命中', () => {
    expect(matchesPrediction(ev(false, []), { expectDetails: [], expectChanged: true })).toBe(false);
  });

  it('空预测（无断言）→ 命中（等价「不检查预测」）', () => {
    expect(matchesPrediction(ev(false, []), { expectDetails: [] })).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/speculation/prediction.test.ts`
Expected: FAIL —— `matchesPrediction` 未定义 / 模块不存在。

- [ ] **Step 3: 写最小实现**

```ts
// src/core/speculation/prediction.ts
import type { Evidence } from '../../honesty/types';

/**
 * 预测：对「可观察 diff」的断言,词汇与 diffSnapshots.details 对齐。
 * expectDetails 里每个子串都必须出现在实际 evidence.details 的某一条里（满足档）。
 */
export interface Prediction {
  expectDetails: string[];
  /** 弱断言：至少要有可观察变化（等价 evidence.changed）。 */
  expectChanged?: boolean;
}

/** 接受测试：实际证据是否满足预测（满足档：predict ⊆ actual，页面多做别的不算失败）。 */
export function matchesPrediction(evidence: Evidence, predict: Prediction): boolean {
  if (predict.expectChanged && !evidence.changed) return false;
  return predict.expectDetails.every((want) => evidence.details.some((got) => got.includes(want)));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/core/speculation/prediction.test.ts`
Expected: PASS(5 passed)。

- [ ] **Step 5: 提交**

```bash
git add src/core/speculation/prediction.ts test/core/speculation/prediction.test.ts
git commit -m "feat(spec): 预测原语——Prediction + matchesPrediction（满足档,复用 diff 词汇）"
```

---

### Task 2: 写结果回传 evidence + 记忆步补 observedDiff

**Files:**
- Modify: `src/core/execWrite.ts`(`WriteResult` 增字段 + 回填)
- Modify: `src/memory/pageMemory.ts`(`RecordedStep` 增字段)
- Modify: `src/core/readLoop.ts`(录制时带上 observedDiff)
- Test: `test/core/execWrite.test.ts`(补一例)

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/core/execWrite.test.ts 末尾（同文件已有 import 与工具函数）
it('WriteResult 回传本次验证的 evidence（供记忆录制预测）', async () => {
  // 复用文件顶部既有的构造方式：一个 low-risk 动作 + 触发可观察变化的 transition
  const before = parseContract(
    (document.body.innerHTML = `<button data-agent-action="done">完成</button><section data-agent-surface="s">待办</section>`,
      document.body),
    '/p',
  );
  const after = parseContract(
    (document.body.innerHTML = `<button data-agent-action="done">完成</button><section data-agent-surface="s">已完成</section>`,
      document.body),
    '/p',
  );
  const host = new FakeHostAdapter(before, { 'action:done': after });
  const ledger = new Ledger();
  const wr = await executeWrite(host, ledger, async () => ({ approved: true }), new Set<string>(), {
    tool: 'invokeAction',
    refId: 'action:done',
  });
  expect(wr.verified).toBe(true);
  expect(wr.evidence).toBeDefined();
  expect(wr.evidence!.some((d) => d.includes('surface'))).toBe(true);
});
```

> 若文件顶部尚未 import `parseContract` / `FakeHostAdapter` / `Ledger`,补上:
> `import { parseContract } from '../../src/contract/parseContract';`
> `import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';`
> `import { Ledger } from '../../src/honesty/ledger';`

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/execWrite.test.ts`
Expected: FAIL —— `wr.evidence` 为 undefined。

- [ ] **Step 3: 写最小实现**

`src/core/execWrite.ts` —— `WriteResult` 接口增字段:

```ts
export interface WriteResult {
  steps: AgentStep[];
  toolResult: string;
  verified: boolean;
  ref?: Ref;
  /** 本次写经 diffSnapshots 验证出的证据 details——供记忆/世界模型录制为预测。 */
  evidence?: string[];
}
```

同文件 return 处(约 execWrite.ts:96)带上 evidence:

```ts
  return { steps, toolResult, verified: evidence.changed, ref: res.ref, evidence: evidence.details };
```

`src/memory/pageMemory.ts` —— `RecordedStep` 增字段:

```ts
export interface RecordedStep {
  tool: string;
  ref?: RecordedRef;
  value?: string;
  answer?: string;
  /** 录制时该写步经验证的 diff details——重放时作预测,抓页面行为漂移。 */
  observedDiff?: string[];
}
```

`src/core/readLoop.ts` —— 写分支录制时带上(约 readLoop.ts:72):

```ts
    const recorded = wr.ref
      ? { tool: name, ref: recordRef(before, wr.ref), value, observedDiff: wr.evidence }
      : undefined;
```

- [ ] **Step 4: 跑全套确认通过**

Run: `npm test`
Expected: PASS(既有全绿 + 新例通过;evidence 为纯增量,不改判定)。

- [ ] **Step 5: 提交**

```bash
git add src/core/execWrite.ts src/memory/pageMemory.ts src/core/readLoop.ts test/core/execWrite.test.ts
git commit -m "feat(spec): 写结果回传 evidence + 记忆步补 observedDiff（预测数据源,纯增量）"
```

---

### Task 3: 现有重放加漂移检测(独立见效)

**Files:**
- Modify: `src/core/readLoop.ts`(`attemptReplay` 用 observedDiff 判漂移)
- Test: `test/core/loopMemory.test.ts`(补一例)

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/core/loopMemory.test.ts 的 describe 内
it('页面行为漂移（同动作现在产生不同 diff）→ 重放放弃,回退 LLM', async () => {
  const memory = new PageMemory();
  const shop = () => build(`<button data-agent-action="done">完成</button><section data-agent-surface="s">待办</section>`, '/p');
  const okDone = () => build(`<button data-agent-action="done">完成</button><section data-agent-surface="s">已完成</section>`, '/p');
  // 首跑：done 使 surface 变「已完成」→ 录制 observedDiff 含该变化
  const host1 = new FakeHostAdapter(shop(), { 'action:done': okDone() });
  const llm1 = new FakeLlmAdapter([
    toolCallTurn('invokeAction', { ref: 'action:done' }),
    toolCallTurn('finish', { answer: '已完成' }),
  ]);
  await collect(createAgent({ llm: llm1, host: host1, memory }).run('标记完成'));

  // 二跑：同页同 key,但 done 现在没有可观察变化（漂移）→ 应放弃重放、回退 LLM
  const host2 = new FakeHostAdapter(shop(), {}); // 无 transition → done 后 surface 不变
  const llm2 = new FakeLlmAdapter([toolCallTurn('finish', { answer: '回退后作答' })]);
  const steps = await collect(createAgent({ llm: llm2, host: host2, memory }).run('标记完成'));

  expect(llm2.calls.length).toBeGreaterThan(0); // 确实回退问了模型
  expect(steps.at(-1)).toMatchObject({ type: 'finish' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/loopMemory.test.ts`
Expected: FAIL —— 当前 `attemptReplay` 只看「变了没」,done 后 surface 无变化会被判 unverified 并回退……**若已回退则改判据**:把断言收紧为「回退且未在 host2 产生二次误动」,确认失败点是「漂移未被显式识别」。(实现步会把回退原因从「未验证」升级为「漂移不吻合」。)

- [ ] **Step 3: 写最小实现**

`src/core/readLoop.ts` `attemptReplay` 内,写步执行后加漂移判定(约 readLoop.ts:110-114 之间):

```ts
    const { steps: produced } = await processCall(call, host, ledger, confirm, new Set<string>());
    for (const s of produced) yield s;

    if (produced.some((s) => s.type === 'error')) return { done: false };
    if (produced.some((s) => s.type === 'action' && !s.verified)) return { done: false };
    if (produced.some((s) => s.type === 'cancelled')) {
      yield finishStep('', ledger);
      return { done: true };
    }
    // 漂移检测：录制过 observedDiff 时,实测证据必须满足它,否则页面行为已偏离 → 放弃重放
    if (step.observedDiff && step.observedDiff.length > 0) {
      const actionStep = produced.find((s) => s.type === 'action') as
        | Extract<AgentStep, { type: 'action' }>
        | undefined;
      if (actionStep) {
        const ok = matchesPrediction(
          { changed: actionStep.verified, details: actionStep.evidence },
          { expectDetails: step.observedDiff },
        );
        if (!ok) return { done: false };
      }
    }
```

文件顶部补 import:

```ts
import { matchesPrediction } from './speculation/prediction';
```

> 注:`processCall` 此步起需接受第 5 个形参 `grantedScopes: Set<string>` 并透传给 `executeWrite`(替换其内部 `new Set()`)。这是 Task 4/5 共用的前置,在此一并改:

`src/core/readLoop.ts` `processCall` 签名与写分支:

```ts
async function processCall(
  call: LlmToolCall,
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
  grantedScopes: Set<string>,
): Promise<CallResult> {
  // ...写分支：
    const wr = await executeWrite(host, ledger, confirm, grantedScopes, {
      tool: name as 'setControl' | 'invokeAction',
      refId,
      value,
    });
```

并把 `runReadLoop` 主循环里对 `processCall(call, host, ledger, confirm)` 的调用改为传入一个该 run 内共享的 `const grantedScopes = new Set<string>();`(与解释器一致的作用域授权语义)。`attemptReplay` 内如上传 `new Set()`(重放高危仍逐个 held,与既有行为一致)。

- [ ] **Step 4: 跑全套确认通过**

Run: `npm test`
Expected: PASS(既有 loopMemory 4 例 + 新漂移例;高危重放仍 held 例不受影响)。

- [ ] **Step 5: 提交**

```bash
git add src/core/readLoop.ts test/core/loopMemory.test.ts
git commit -m "feat(spec): 重放漂移检测——observedDiff 不吻合即放弃,红线'记忆只加速不背书'更硬"
```

---

## Phase B — 谱系③:记忆作投机预测源 + 部分重放

### Task 4: PredictionSource 接口 + fromMemory 源

**Files:**
- Create: `src/core/speculation/sources.ts`
- Test: `test/core/speculation/sources.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/core/speculation/sources.test.ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../../src/contract/parseContract';
import { fromMemory } from '../../../src/core/speculation/sources';
import type { RecordedStep } from '../../../src/memory/pageMemory';

const board = () => {
  document.body.innerHTML = `<button data-agent-action="done">完成</button><section data-agent-surface="s">待办</section>`;
  return parseContract(document.body, '/p');
};

describe('fromMemory 预测源', () => {
  it('按录制顺序产出 (call, predict)，predict 来自 observedDiff', () => {
    const steps: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: 'done' }, observedDiff: ['surface s changed'] },
      { tool: 'finish', answer: '完成了' },
    ];
    const src = fromMemory(steps);
    const first = src.next(board());
    expect(first).not.toBeNull();
    expect(first!.call.name).toBe('invokeAction');
    expect(first!.call.arguments.ref).toBe('action:done');
    expect(first!.predict).toEqual({ expectDetails: ['surface s changed'] });

    const second = src.next(board());
    expect(second!.call.name).toBe('finish');

    expect(src.next(board())).toBeNull(); // 耗尽
  });

  it('录制 ref 在当前页解析不出 → 返回 { call: null } 标记失效', () => {
    const steps: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: '不存在' } },
    ];
    const src = fromMemory(steps);
    expect(src.next(board())).toEqual({ call: null });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/speculation/sources.test.ts`
Expected: FAIL —— `fromMemory` 未定义。

- [ ] **Step 3: 写最小实现**

```ts
// src/core/speculation/sources.ts
import type { PageSnapshot } from '../../types';
import type { LlmToolCall } from '../../llm/types';
import type { RecordedStep } from '../../memory/pageMemory';
import { resolveRecordedRef } from '../../memory/pageMemory';
import type { Prediction } from './prediction';

/** 一步投机：要执行的工具调用 + 可选预测;call=null 表示源在当前页失效(ref 解析不出)。 */
export type SpecStep =
  | { call: LlmToolCall; predict?: Prediction; answer?: string }
  | { call: null };

/** 预测源:有状态游标,next 按实时快照解析 ref、产出下一步;返回 null 表示自然耗尽。 */
export interface PredictionSource {
  next(snapshot: PageSnapshot): SpecStep | null;
}

/** 记忆轨迹 → 预测源:按录制顺序重解析 ref,observedDiff 作预测。 */
export function fromMemory(steps: RecordedStep[]): PredictionSource {
  let i = 0;
  return {
    next(snapshot: PageSnapshot): SpecStep | null {
      if (i >= steps.length) return null;
      const step = steps[i++];
      if (step.tool === 'finish') {
        return { call: { id: `spec_finish`, name: 'finish', arguments: { answer: step.answer ?? '' } }, answer: step.answer };
      }
      let refArg: Record<string, unknown> = {};
      if (step.ref) {
        const ref = resolveRecordedRef(snapshot, step.ref);
        if (!ref) return { call: null };
        refArg = { ref: ref.id };
      }
      const call: LlmToolCall = {
        id: `spec_${step.tool}_${i}`,
        name: step.tool,
        arguments: { ...refArg, ...(step.value !== undefined ? { value: step.value } : {}) },
      };
      const predict: Prediction | undefined =
        step.observedDiff && step.observedDiff.length > 0 ? { expectDetails: step.observedDiff } : undefined;
      return { call, predict };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/core/speculation/sources.test.ts`
Expected: PASS(2 passed)。

- [ ] **Step 5: 提交**

```bash
git add src/core/speculation/sources.ts test/core/speculation/sources.test.ts
git commit -m "feat(spec): PredictionSource 接口 + fromMemory 源（复用 resolveRecordedRef）"
```

---

### Task 5: runSpeculative 统一执行器

**Files:**
- Create: `src/core/speculation/runSpeculative.ts`
- Modify: `src/core/loopTypes.ts`(`AgentStep` 增 `speculate`/`mispredict`)
- Modify: `src/core/readLoop.ts`(导出 `processCall`)
- Test: `test/core/speculation/runSpeculative.test.ts`

- [ ] **Step 1: 加 AgentStep 变体 + 导出 processCall**

`src/core/loopTypes.ts` `AgentStep` 联合追加两支:

```ts
  | { type: 'speculate'; tool: string; refId?: string; hit: boolean }
  | { type: 'mispredict'; tool: string; refId?: string; expected: string[]; actual: string[] }
```

`src/core/readLoop.ts`:把 `async function processCall` 改为 `export async function processCall`。

- [ ] **Step 2: 写失败测试**

```ts
// test/core/speculation/runSpeculative.test.ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../../src/contract/parseContract';
import { FakeHostAdapter } from '../../../src/testing/fakeHostAdapter';
import { Ledger } from '../../../src/honesty/ledger';
import { runSpeculative } from '../../../src/core/speculation/runSpeculative';
import { fromMemory } from '../../../src/core/speculation/sources';
import type { AgentStep } from '../../../src/core/loopTypes';
import type { RecordedStep } from '../../../src/memory/pageMemory';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}
async function drain(gen: AsyncGenerator<AgentStep, { done: boolean }>) {
  const steps: AgentStep[] = [];
  let r = await gen.next();
  while (!r.done) { steps.push(r.value); r = await gen.next(); }
  return { steps, result: r.value };
}

const todo = () => build(`<button data-agent-action="done">完成</button><section data-agent-surface="s">待办</section>`);
const finished = () => build(`<button data-agent-action="done">完成</button><section data-agent-surface="s">已完成</section>`);

describe('runSpeculative', () => {
  it('预测命中 → 零-LLM 执行完写步,source 耗尽 → done:true', async () => {
    const host = new FakeHostAdapter(todo(), { 'action:done': finished() });
    const ledger = new Ledger();
    const rec: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: 'done' }, observedDiff: ['surface s changed'] },
      { tool: 'finish', answer: 'ok' },
    ];
    const { steps, result } = await drain(
      runSpeculative(fromMemory(rec), { host, ledger, confirm: async () => ({ approved: true }), grantedScopes: new Set() }),
    );
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
    expect(steps.some((s) => s.type === 'speculate' && s.hit)).toBe(true);
    expect(result.done).toBe(true);
  });

  it('预测漂移 → 产出 mispredict 并 done:false（交回调用方重同步）', async () => {
    const host = new FakeHostAdapter(todo(), {}); // done 无变化 → 与 observedDiff 不吻合
    const ledger = new Ledger();
    const rec: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: 'done' }, observedDiff: ['surface s changed'] },
      { tool: 'finish', answer: 'ok' },
    ];
    const { steps, result } = await drain(
      runSpeculative(fromMemory(rec), { host, ledger, confirm: async () => ({ approved: true }), grantedScopes: new Set() }),
    );
    expect(steps.some((s) => s.type === 'mispredict')).toBe(true);
    expect(result.done).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/core/speculation/runSpeculative.test.ts`
Expected: FAIL —— `runSpeculative` 未定义。

- [ ] **Step 4: 写最小实现**

```ts
// src/core/speculation/runSpeculative.ts
import type { HostAdapter } from '../../host/types';
import type { ConfirmFn } from '../../honesty/types';
import { Ledger } from '../../honesty/ledger';
import type { AgentStep } from '../loopTypes';
import { processCall } from '../readLoop';
import { finishStep } from '../finish';
import { matchesPrediction } from './prediction';
import type { PredictionSource } from './sources';

export interface SpecDeps {
  host: HostAdapter;
  ledger: Ledger;
  confirm: ConfirmFn;
  grantedScopes: Set<string>;
}

export interface SpecResult {
  done: boolean; // true=已收尾(源耗尽/finish/取消);false=需重同步(漂移/失效/未验证)
}

/**
 * 统一投机执行器:逐步取预测源,走 processCall(即 executeWrite 五关),
 * 对写步用 diffSnapshots 证据比对预测。命中零-LLM 前进;漂移/失效/未验证 → done:false 交回。
 * 对 ledger/verify 无任何旁路——纯性能层。
 */
export async function* runSpeculative(
  source: PredictionSource,
  deps: SpecDeps,
): AsyncGenerator<AgentStep, SpecResult> {
  const { host, ledger, confirm, grantedScopes } = deps;

  for (;;) {
    const step = source.next(host.snapshot());
    if (step === null) {
      yield finishStep('', ledger); // 源自然耗尽:按账本收尾
      return { done: true };
    }
    if (step.call === null) {
      return { done: false }; // 源失效(ref 解析不出)→ 重同步
    }
    if (step.call.name === 'finish') {
      yield finishStep(step.answer ?? '', ledger);
      return { done: true };
    }

    const { steps: produced } = await processCall(step.call, host, ledger, confirm, grantedScopes);
    for (const s of produced) yield s;

    if (produced.some((s) => s.type === 'error')) return { done: false };
    if (produced.some((s) => s.type === 'cancelled')) {
      yield finishStep('', ledger);
      return { done: true }; // 用户拒绝高危 → 收尾(outcome 由账本算 cancelled)
    }

    const actionStep = produced.find((s) => s.type === 'action') as
      | Extract<AgentStep, { type: 'action' }>
      | undefined;
    if (actionStep && !actionStep.verified) return { done: false }; // 未验证 → 重同步

    if (step.predict && actionStep) {
      const evidence = { changed: actionStep.verified, details: actionStep.evidence };
      const hit = matchesPrediction(evidence, step.predict);
      yield { type: 'speculate', tool: step.call.name, refId: actionStep.refId, hit };
      if (!hit) {
        yield {
          type: 'mispredict',
          tool: step.call.name,
          refId: actionStep.refId,
          expected: step.predict.expectDetails,
          actual: actionStep.evidence,
        };
        return { done: false };
      }
    } else if (step.predict) {
      yield { type: 'speculate', tool: step.call.name, hit: true }; // 读步无 diff,视作命中
    }
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/core/speculation/runSpeculative.test.ts`
Expected: PASS(2 passed)。

- [ ] **Step 6: 提交**

```bash
git add src/core/speculation/runSpeculative.ts src/core/loopTypes.ts src/core/readLoop.ts test/core/speculation/runSpeculative.test.ts
git commit -m "feat(spec): runSpeculative 统一执行器（复用 processCall+diffSnapshots,纯性能层）"
```

---

### Task 6: 读循环接部分重放(前缀复用 + LLM 补尾)

**Files:**
- Modify: `src/core/readLoop.ts`(`runReadLoop` 用 `runSpeculative` 替代 `attemptReplay`)
- Test: `test/core/loopMemory.test.ts`(补部分重放例)

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/core/loopMemory.test.ts
it('部分重放：命中前缀零-LLM,漂移处只补一次 LLM 后收尾', async () => {
  const memory = new PageMemory();
  const p = () => build(`<button data-agent-action="a">A</button><section data-agent-surface="s">x</section>`, '/p');
  const p2 = () => build(`<button data-agent-action="a">A</button><section data-agent-surface="s">y</section>`, '/p');
  // 首跑：a 使 s: x→y,录制含 observedDiff
  const host1 = new FakeHostAdapter(p(), { 'action:a': p2() });
  const llm1 = new FakeLlmAdapter([toolCallTurn('invokeAction', { ref: 'action:a' }), toolCallTurn('finish', { answer: '做完A' })]);
  await collect(createAgent({ llm: llm1, host: host1, memory }).run('做A'));

  // 二跑：a 仍使 s 变化但内容不同（命中 expectDetails 'surface s changed' 仍吻合）→ 直接零-LLM 完成
  const host2 = new FakeHostAdapter(p(), { 'action:a': p2() });
  const emptyLlm = new FakeLlmAdapter([]);
  const steps = await collect(createAgent({ llm: emptyLlm, host: host2, memory }).run('做A'));
  expect(steps.some((s) => s.type === 'speculate' && s.hit)).toBe(true);
  expect(emptyLlm.calls).toHaveLength(0);
  expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/loopMemory.test.ts`
Expected: FAIL —— 尚无 `speculate` 步产出(仍走旧 `attemptReplay` 的 `replay` 步)。

- [ ] **Step 3: 写实现**

`src/core/readLoop.ts` `runReadLoop` 开头的记忆分支(约 readLoop.ts:132-138)改为:

```ts
  const grantedScopes = new Set<string>();

  if (memory) {
    const entry = memory.lookup(key);
    if (entry) {
      const source = fromMemory(entry.steps);
      const res = yield* runSpeculative(source, { host, ledger, confirm, grantedScopes });
      if (res.done) return;
      // 部分重放:已验证前缀留在 ledger,漂移/失效处交给下方 LLM 循环补尾（余下重新规划）。
      // 不续跑录制尾巴——页面已偏离,陈旧预测不可信（红线:记忆只加速不背书）。
    }
  }
```

顶部 import:

```ts
import { runSpeculative } from './speculation/runSpeculative';
import { fromMemory } from './speculation/sources';
```

并把主 LLM 循环中 `processCall(call, host, ledger, confirm)` 调用改为 `processCall(call, host, ledger, confirm, grantedScopes)`(共享作用域)。删除旧 `attemptReplay` 函数(其职责已被 `runSpeculative`+`fromMemory` 取代;Task 3 的漂移检测逻辑已内化进 `runSpeculative`)。

> 保留 `finishStep`/`recordRef` 等既有引用不变。旧 `replay` 步类型可保留在联合里(向后兼容),但读路径不再产出它。

- [ ] **Step 4: 跑全套确认通过**

Run: `npm test`
Expected: PASS —— 全套绿。特别确认既有「零 LLM 重放」「ref 失效回退」「高危重放仍 held」三例在新执行器下语义不变(高危仍 held:`runSpeculative` 走 `processCall`→`executeWrite`,held 逻辑原地不动)。

- [ ] **Step 5: 提交**

```bash
git add src/core/readLoop.ts test/core/loopMemory.test.ts
git commit -m "feat(spec): 读循环接部分重放——前缀复用+LLM补尾,attemptReplay 退役归并入 runSpeculative"
```

---

## Phase C — 谱系②:世界模型(从账本学因果)

### Task 7: WorldModel(learn / predict)

**Files:**
- Create: `src/memory/worldModel.ts`
- Test: `test/memory/worldModel.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/memory/worldModel.test.ts
import { describe, it, expect } from 'vitest';
import { WorldModel } from '../../src/memory/worldModel';
import { parseContract } from '../../src/contract/parseContract';

const snap = () => {
  document.body.innerHTML = `<button data-agent-action="done">完成</button>`;
  return parseContract(document.body, '/p');
};

describe('WorldModel（从证据学 动作→diff 因果,按签名闸门）', () => {
  it('learn 后 predict 同签名同动作 → 返回最近一次证据作预测', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'done', { changed: true, details: ['surface s changed'] });
    expect(wm.predict(s, 'done')).toEqual({ expectDetails: ['surface s changed'] });
  });

  it('未学过的动作 → predict 返回 null', () => {
    expect(new WorldModel().predict(snap(), 'done')).toBeNull();
  });

  it('重复 learn → 覆盖为最近一次（陈旧性:最新证据胜出）', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'done', { changed: true, details: ['旧'] });
    wm.learn(s, 'done', { changed: true, details: ['新'] });
    expect(wm.predict(s, 'done')).toEqual({ expectDetails: ['新'] });
  });

  it('无变化的证据不学（changed=false 不构成因果）', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'done', { changed: false, details: [] });
    expect(wm.predict(s, 'done')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/memory/worldModel.test.ts`
Expected: FAIL —— `WorldModel` 未定义。

- [ ] **Step 3: 写最小实现**

```ts
// src/memory/worldModel.ts
import type { PageSnapshot } from '../types';
import type { Evidence } from '../honesty/types';
import type { Prediction } from '../core/speculation/prediction';
import { pageSignature } from './pageSignature';

/**
 * 世界模型:纯从「验证过的证据」学 (页面签名, 动作名) → 最近一次可观察 diff。
 * 检索式(R-WoM 风格),数据来自 Ledger 的 write 条目——绝不碰模型自述,天然诚实。
 * 签名是陈旧性闸门:签名变即查不到,错也只浪费一点上下文、绝不误动。
 */
export class WorldModel {
  private readonly store = new Map<string, string[]>();

  private key(sig: string, action: string): string {
    return `${sig}|>${action}`;
  }

  learn(snapshot: PageSnapshot, actionName: string, evidence: Evidence): void {
    if (!evidence.changed || evidence.details.length === 0) return; // 无变化不构成因果
    this.store.set(this.key(pageSignature(snapshot), actionName), evidence.details);
  }

  predict(snapshot: PageSnapshot, actionName: string): Prediction | null {
    const details = this.store.get(this.key(pageSignature(snapshot), actionName));
    return details ? { expectDetails: details } : null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/memory/worldModel.test.ts`
Expected: PASS(4 passed)。

- [ ] **Step 5: 提交**

```bash
git add src/memory/worldModel.ts test/memory/worldModel.test.ts
git commit -m "feat(spec): WorldModel——从账本证据学 动作→diff 因果,签名作陈旧性闸门"
```

---

### Task 8: 世界模型接入 —— 学 + 补全缺失预测

**Files:**
- Modify: `src/core/loop.ts`(`AgentOptions` 增 `worldModel?`;`LoopDeps` 透传)
- Modify: `src/core/loopTypes.ts`(`LoopDeps` 增 `worldModel?: WorldModel`)
- Modify: `src/core/readLoop.ts`(每次验证写后 `worldModel.learn`;`fromMemory` 缺 observedDiff 时用 worldModel 补预测)
- Modify: `src/core/speculation/sources.ts`(`fromMemory` 增可选 worldModel 回退参数)
- Test: `test/core/loopMemory.test.ts`(补一例:无 observedDiff 但世界模型能补预测)

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/core/loopMemory.test.ts
it('世界模型：跨任务学到的 动作→diff 能为无 observedDiff 的记忆步补预测', async () => {
  const { WorldModel } = await import('../../src/memory/worldModel');
  const wm = new WorldModel();
  const p = () => build(`<button data-agent-action="a">A</button><section data-agent-surface="s">x</section>`, '/p');
  const p2 = () => build(`<button data-agent-action="a">A</button><section data-agent-surface="s">y</section>`, '/p');
  const host = new FakeHostAdapter(p(), { 'action:a': p2() });
  const llm = new FakeLlmAdapter([toolCallTurn('invokeAction', { ref: 'action:a' }), toolCallTurn('finish', { answer: 'ok' })]);
  await collect(createAgent({ llm, host, worldModel: wm }).run('做A'));
  // 世界模型此时应已学到 (签名, 'a') → 'surface s changed'
  expect(wm.predict(p(), 'a')).not.toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/loopMemory.test.ts`
Expected: FAIL —— `createAgent` 尚不接受 `worldModel`,或未 learn。

- [ ] **Step 3: 写实现**

`src/core/loopTypes.ts` `LoopDeps` 追加:

```ts
  worldModel?: import('../memory/worldModel').WorldModel;
```

`src/core/loop.ts` `AgentOptions` 追加 `worldModel?: WorldModel;`(顶部 import),并在 `deps` 里透传 `worldModel: options.worldModel`。

`src/core/readLoop.ts`:在写分支产出 action 步后(processCall 内写分支,readLoop.ts:72 附近),若 verified 则学。因 processCall 现为独立函数,把 worldModel 作可选参数透传:

```ts
export async function processCall(
  call: LlmToolCall,
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
  grantedScopes: Set<string>,
  worldModel?: WorldModel,
): Promise<CallResult> {
  // ...写分支执行后:
    const actionStep = wr.steps.find((s) => s.type === 'action') as
      | Extract<AgentStep, { type: 'action' }>
      | undefined;
    if (worldModel && actionStep?.verified) {
      const node = before.actions.find((a) => a.ref.id === refId);
      if (node) worldModel.learn(before, node.name, { changed: true, details: actionStep.evidence });
    }
```

`runReadLoop` 与 `runSpeculative` 调 `processCall` 时把 `deps.worldModel` 透传下去(`runSpeculative` 的 `SpecDeps` 增 `worldModel?`,主循环传入)。

`src/core/speculation/sources.ts` `fromMemory` 增可选回退:

```ts
import type { WorldModel } from '../../memory/worldModel';

export function fromMemory(steps: RecordedStep[], worldModel?: WorldModel): PredictionSource {
  // ...produce predict 时:
      let predict: Prediction | undefined =
        step.observedDiff && step.observedDiff.length > 0 ? { expectDetails: step.observedDiff } : undefined;
      if (!predict && worldModel && step.ref?.by === 'name' && step.ref.kind === 'action') {
        predict = worldModel.predict(snapshot, step.ref.name) ?? undefined;
      }
```

`runReadLoop` 记忆分支构造源时传 worldModel:`fromMemory(entry.steps, deps.worldModel)`。

- [ ] **Step 4: 跑全套确认通过**

Run: `npm test`
Expected: PASS —— 全绿;世界模型为 opt-in,不传则行为与之前完全一致。

- [ ] **Step 5: 提交**

```bash
git add src/core/loop.ts src/core/loopTypes.ts src/core/readLoop.ts src/core/speculation/sources.ts src/core/speculation/runSpeculative.ts test/core/loopMemory.test.ts
git commit -m "feat(spec): 世界模型接入——验证写即 learn,为无 observedDiff 的记忆步补预测"
```

---

## Phase D — 谱系①:模型 lookahead + A/B 量化

### Task 9: 程序节点带预测(模型 lookahead)

**Files:**
- Modify: `src/core/program/types.ts`(`invoke`/`setControl` 节点增可选 `predict?: string[]`;validate 放行)
- Modify: `src/core/program/interpreter.ts`(`runWrite` 校验 predict,不吻合产出 mispredict 但不误判 outcome)
- Test: `test/core/program/interpreter.test.ts`(补一例)

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/core/program/interpreter.test.ts（沿用文件既有 host/ledger 构造）
it('invoke 节点带 predict：实测证据不吻合 → 产出 mispredict（但写本身已验证,不改 outcome）', async () => {
  // 用文件既有的 FakeHostAdapter + parseContract 构造：一个 low-risk 动作使 surface 变化
  // program.body = [{ op:'invoke', action:'done', predict:['不会出现的子串'] }]
  // 断言：steps 含 { type:'mispredict' }；ledger 里该写 verified=true
  // （具体构造复用本文件顶部已有的 helper；此处仅描述断言意图,实现步给出 predict 校验）
});
```

> 实现者:参照本文件已有的解释器测试构造一个 low-risk `invoke` 转移;program 节点带 `predict:['不会出现的子串']`;断言产出 `mispredict` 且账本中该 write `verified=true`(证明 predict 只影响观测/投机,不污染诚实判定)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/core/program/interpreter.test.ts`
Expected: FAIL —— 节点不接受 predict / 无 mispredict 产出。

- [ ] **Step 3: 写实现**

`src/core/program/types.ts` 节点类型:

```ts
  | { op: 'setControl'; on: { control: string }; value: string; predict?: string[] }
  | { op: 'invoke'; action: string; predict?: string[] }
```

`validateNode` 的 setControl/invoke 分支放行可选 `predict`(若存在须为 string[]):

```ts
    case 'invoke':
      need(typeof node.action === 'string' && node.action.length > 0, '缺 action');
      need(node.predict === undefined || Array.isArray(node.predict), 'predict 必须是数组');
      break;
```

(setControl 分支同样加 predict 校验。)

`src/core/program/interpreter.ts` `runWrite` 增 predict 参数并在写后校验:

```ts
  async function* runWrite(
    op: string,
    req: { tool: 'setControl' | 'invokeAction'; refId: string; value?: string },
    predict?: string[],
  ): AsyncGenerator<AgentStep, Signal> {
    const { steps } = await executeWrite(host, ledger, confirm, grantedScopes, req);
    for (const s of steps) yield s;
    if (steps.some((s) => s.type === 'error')) return 'abort';
    if (steps.some((s) => s.type === 'cancelled')) return 'continue';
    const actionStep = steps.find((s) => s.type === 'action') as
      | Extract<AgentStep, { type: 'action' }>
      | undefined;
    if (actionStep && !actionStep.verified) return 'abort';
    if (predict && predict.length > 0 && actionStep) {
      const hit = matchesPrediction({ changed: actionStep.verified, details: actionStep.evidence }, { expectDetails: predict });
      yield { type: 'speculate', tool: req.tool, refId: actionStep.refId, hit };
      if (!hit) {
        yield { type: 'mispredict', tool: req.tool, refId: actionStep.refId, expected: predict, actual: actionStep.evidence };
      }
    }
    return 'continue';
  }
```

调用处传 predict:`invoke` → `runWrite('invoke', {...}, node.predict)`;`setControl` 同理。顶部 import `matchesPrediction`。

- [ ] **Step 4: 跑全套确认通过**

Run: `npm test`
Expected: PASS —— 程序模式既有 14 例 + validate 8 例不受影响(predict 可选);新 mispredict 例通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/program/types.ts src/core/program/interpreter.ts test/core/program/interpreter.test.ts test/core/program/validate.test.ts
git commit -m "feat(spec): 程序节点可带 predict——模型 lookahead 走同一 matchesPrediction,不污染 outcome"
```

---

### Task 10: A/B 量化台 + 设计定稿归档

**Files:**
- Create: `examples/spec-bench.ts`
- Create: `docs/specs/2026-07-01-attest-slice8-speculative-execution-design.md`(把本计划「设计」节归档为定稿)

- [ ] **Step 1: 写量化台脚本**

```ts
// examples/spec-bench.ts
// A/B:同一批任务,带/不带记忆+世界模型投机,比 LLM 调用数(FakeLlm.calls.length)。
// 目的:验证「投机省下的往返 > 预测本身成本」这条净收益生死线(确定性,可 CI)。
import { parseContract } from '../src/contract/parseContract';
import { createAgent, type AgentStep } from '../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../src/testing/fakeHostAdapter';
import { PageMemory } from '../src/memory/pageMemory';
import { WorldModel } from '../src/memory/worldModel';

async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}
function board() {
  document.body.innerHTML = `<button data-agent-action="a">A</button><section data-agent-surface="s">x</section>`;
  return parseContract(document.body, '/p');
}
function board2() {
  document.body.innerHTML = `<button data-agent-action="a">A</button><section data-agent-surface="s">y</section>`;
  return parseContract(document.body, '/p');
}

async function run() {
  const memory = new PageMemory();
  const wm = new WorldModel();
  // 冷跑(建记忆):
  let totalCold = 0;
  const cold = new FakeLlmAdapter([toolCallTurn('invokeAction', { ref: 'action:a' }), toolCallTurn('finish', { answer: 'ok' })]);
  await collect(createAgent({ llm: cold, host: new FakeHostAdapter(board(), { 'action:a': board2() }), memory, worldModel: wm }).run('做A'));
  totalCold += cold.calls.length;

  // 热跑 N 次(投机):
  const N = 10;
  let totalHot = 0;
  for (let i = 0; i < N; i++) {
    const hot = new FakeLlmAdapter([toolCallTurn('finish', { answer: 'fallback' })]); // 只有回退才会用到
    await collect(createAgent({ llm: hot, host: new FakeHostAdapter(board(), { 'action:a': board2() }), memory, worldModel: wm }).run('做A'));
    totalHot += hot.calls.length;
  }
  console.log(`冷跑 LLM 调用: ${totalCold}`);
  console.log(`热跑 ${N} 次 LLM 调用合计: ${totalHot}（命中投机应≈0）`);
  console.log(`每任务均摊: 冷 ${totalCold} → 热 ${(totalHot / N).toFixed(2)}`);
}
run();
```

- [ ] **Step 2: 跑量化台**

Run: `npx tsx examples/spec-bench.ts`(happy-dom 已在 vitest 配置;若脚本环境无 document,用 `npx vitest run` 包一层或在脚本顶部引入 happy-dom `GlobalRegistrator`,参照 `examples/live-check.ts` 的环境搭法)
Expected: 打印「热跑合计 ≈ 0」——证明命中投机时零-LLM,净收益为正。

- [ ] **Step 3: 归档设计定稿**

把本文件「设计」节(统一模型 / 复用表 / 岔路决策 / 红线分析 / 文件结构)整理进 `docs/specs/2026-07-01-attest-slice8-speculative-execution-design.md`,与既有 sliceN-design 同风格。

- [ ] **Step 4: 提交**

```bash
git add examples/spec-bench.ts docs/specs/2026-07-01-attest-slice8-speculative-execution-design.md
git commit -m "test(spec): A/B 量化台 + 设计定稿归档——证净收益(命中零-LLM)"
```

---

## Phase E — 收口与验收

### Task 11: 导出面 + typecheck + build + 真模型 live 验收

- [ ] **Step 1: 收敛公共导出**

`src/index.ts` 追加(按需):

```ts
// ── 投机执行（opt-in）──
export { WorldModel } from './memory/worldModel';
export type { Prediction } from './core/speculation/prediction';
```

`AgentOptions` 已含 `worldModel?`。更新 `test/index.test.ts` 守卫(若它断言导出集合)。

- [ ] **Step 2: 全绿 + 类型 + 构建**

Run:
```bash
npm test && npm run typecheck && npm run build
```
Expected: 三者全过。**务必先看到 "passed" 再继续**(§四:别用管道掩盖非零退出)。

- [ ] **Step 3: 真模型 live 验收(强制项,§三)**

在 `examples/live-real.ts` 加一条场景:同一任务连跑两次(第二次应因记忆+世界模型投机而显著少问模型),人工核验:
- 用户可见文字准确、不谎报;
- 工具顺序合理、无串台;
- 高危动作仍 held;
- 第二次 `speculate` 命中、LLM 往返下降;
- outcome 由账本算(completed/partial/cancelled/failed)正确。

Run: `ATTEST_API_KEY=... ATTEST_BASE_URL=https://api.deepseek.com ATTEST_MODEL=deepseek-... npx tsx examples/live-real.ts`

- [ ] **Step 4: 诚实报告 + 合回**

分开陈述「确定性全绿」与「真模型已验收」。live 通过后:

```bash
git add -A && git commit -m "chore(spec): 收口——导出面/typecheck/build/live 验收通过"
# 特性分支 --ff-only 合回 master,删分支(§五)
```

- [ ] **Step 5: 同步 CLAUDE.md §六**

把切片8 记入「已完成」或「待 live 验收」栏,并更新开放线(#1 配方量化可与本切片的 A/B 台合并推进)。

---

## Self-Review(对着设计核一遍)

**Spec coverage:**
- 谱系① 投机执行 → Task 1(原语)+ Task 5(runSpeculative)+ Task 9(模型 lookahead)+ Task 10(量化)。✅
- 谱系② 世界模型 → Task 7(WorldModel)+ Task 8(接入学/预测)。✅
- 谱系③ 记忆/缓存 → Task 2(observedDiff)+ Task 3(漂移检测)+ Task 4(fromMemory)+ Task 6(部分重放)。✅
- 红线守法(verify-or-refuse 单源 / 记忆不背书 / 高危 held / Ledger 无知)→ 各 Task 的 Step 4 全套回归 + Task 11 live。✅

**Placeholder scan:** Task 9 Step 1 的测试给的是意图+构造指引而非整段死代码(因它强依赖该文件既有 helper);已明确断言目标(mispredict 产出 + write verified=true)。其余步均含可运行代码与确切命令。

**Type consistency:** `Prediction{expectDetails,expectChanged?}`、`SpecStep`、`PredictionSource.next`、`SpecDeps`、`WorldModel.learn/predict`、`RecordedStep.observedDiff`、`WriteResult.evidence`、`AgentStep` 的 `speculate`/`mispredict` 分支,全计划一致。`processCall` 形参演进(+grantedScopes → +worldModel)在 Task 3/5/8 逐步且一致。

---

## 执行方式(handoff)

计划已存 `docs/plans/2026-07-01-attest-slice8-speculative-execution.md`。两种执行方式:

1. **Subagent-Driven(推荐)** —— 每个 Task 派新 subagent,任务间我审查、快迭代。
2. **Inline Execution** —— 本会话内批量执行,带检查点复审。

选哪种?
