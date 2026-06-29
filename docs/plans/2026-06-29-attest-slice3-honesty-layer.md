# Attest 切片 3：诚实层（verifier + Ledger + narrationGuard + held 写动作）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给读循环加上"可靠与诚实三件套"——写工具（setControl/invokeAction）、可观察变化 verifier、Evidence Ledger、high-risk held（Intent Receipt 两阶段提交）、由证据计算 outcome 的 narrationGuard。

**Architecture:** 写工具单独成组（保持"读循环不可写"）。高危 invokeAction 走 Intent Receipt：建 Intent → yield held → await confirm（默认拒绝）→ 批准才执行 → verifier 对比写前/写后快照 → Ledger 记 intent/grant/write 三段票根。finish 的 outcome 由 Ledger 计算（写未验证→failed，高危被拒→cancelled，否则 completed），不信模型自述。

**Tech Stack:** TypeScript (ESM, strict)、Vitest、happy-dom。沿用切片 1/2 模块。

---

## 范围

覆盖切片 3。不含 CandidateSet/长程引用/planRunner（切片 4，先 brainstorm）。Intent 的"预测证据"为按动作语义推导的期望（非真 dry-run），执行后由 verifier 核对期望 vs 实际。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/honesty/types.ts` | Intent / Evidence / LedgerEntry / Outcome / ConfirmFn |
| `src/honesty/riskPolicy.ts` | actionRisk / isHighRisk |
| `src/honesty/verifier.ts` | diffSnapshots（可观察变化） |
| `src/honesty/ledger.ts` | Ledger（append-only）+ computeOutcome |
| `src/honesty/narrationGuard.ts` | guardFinish（由 ledger 计算 outcome + 加注） |
| `src/core/tools.ts` | 加 WRITE_TOOLS / WRITE_REF_KINDS / ACT_TOOLS |
| `src/host/types.ts` | HostAdapter 加 setControl / invokeAction |
| `src/testing/fakeHostAdapter.ts` | 实现 setControl / invokeAction |
| `src/adapters/domHostAdapter.ts` | 实现 setControl / invokeAction（真实 DOM） |
| `src/core/loop.ts` | 集成写路径 / held / ledger / verify / narration |
| `src/index.ts` | 导出诚实层公共面 |
| `docs/LIVE-ACCEPTANCE.md` | 补 held/写动作验收场景 |

---

## Task 1：honesty/types + riskPolicy

**Files:**
- Create: `src/honesty/types.ts`
- Create: `src/honesty/riskPolicy.ts`
- Test: `test/honesty/riskPolicy.test.ts`

- [ ] **Step 1: 写 `src/honesty/types.ts`**

```ts
export interface Intent {
  actionRef: string;
  label: string;
  expectedEvidence: string[];
}

export interface Evidence {
  changed: boolean;
  details: string[];
}

export type LedgerEntry =
  | { kind: 'observe'; tool: string; detail: string }
  | { kind: 'intent'; refId: string; label: string; expectedEvidence: string[] }
  | { kind: 'grant'; refId: string; approved: boolean }
  | { kind: 'write'; tool: string; refId: string; verified: boolean; evidence: string[] }
  | { kind: 'error'; tool: string; detail: string };

export type Outcome = 'completed' | 'failed' | 'cancelled';

export type ConfirmFn = (intent: Intent) => Promise<{ approved: boolean }>;
```

- [ ] **Step 2: 写失败测试 `test/honesty/riskPolicy.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { actionRisk, isHighRisk } from '../../src/honesty/riskPolicy';

function snap() {
  document.body.innerHTML = `
    <button data-agent-action="apply">申请</button>
    <button data-agent-action="redeem" data-agent-risk="high">兑换</button>
  `;
  return parseContract(document.body, 'u');
}

describe('riskPolicy', () => {
  it('默认动作 low，high-risk 动作 high', () => {
    const s = snap();
    expect(actionRisk(s, 'action:apply')).toBe('low');
    expect(actionRisk(s, 'action:redeem')).toBe('high');
  });

  it('isHighRisk 仅对 high 返回 true', () => {
    const s = snap();
    expect(isHighRisk(s, 'action:redeem')).toBe(true);
    expect(isHighRisk(s, 'action:apply')).toBe(false);
  });

  it('未知 ref 视为 low', () => {
    expect(actionRisk(snap(), 'action:nope')).toBe('low');
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/honesty/riskPolicy.test.ts`
Expected: FAIL（找不到模块）。

- [ ] **Step 4: 写 `src/honesty/riskPolicy.ts`**

```ts
import type { PageSnapshot, Risk } from '../types';

export function actionRisk(snapshot: PageSnapshot, actionRefId: string): Risk {
  return snapshot.actions.find((a) => a.ref.id === actionRefId)?.risk ?? 'low';
}

export function isHighRisk(snapshot: PageSnapshot, actionRefId: string): boolean {
  return actionRisk(snapshot, actionRefId) === 'high';
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/honesty/riskPolicy.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 6: Commit**

```bash
git add src/honesty/types.ts src/honesty/riskPolicy.ts test/honesty/riskPolicy.test.ts
git commit -m "feat(honesty): honesty 类型 + riskPolicy（动作风险评估）"
```

---

## Task 2：verifier（可观察变化）

**Files:**
- Create: `src/honesty/verifier.ts`
- Test: `test/honesty/verifier.test.ts`

- [ ] **Step 1: 写失败测试 `test/honesty/verifier.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { diffSnapshots } from '../../src/honesty/verifier';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

describe('diffSnapshots', () => {
  it('无变化 → changed=false', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`);
    const b = build(`<div data-agent-object="task:1">A</div>`);
    expect(diffSnapshots(a, b)).toEqual({ changed: false, details: [] });
  });

  it('url 变化被记录', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`, '/list');
    const b = build(`<div data-agent-object="task:1">A</div>`, '/done');
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('/list') && d.includes('/done'))).toBe(true);
  });

  it('控件值变化被记录', () => {
    const a = build(`<input data-agent-control="amount" value="100" />`);
    const b = build(`<input data-agent-control="amount" value="200" />`);
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('control:amount'))).toBe(true);
  });

  it('对象出现/消失被记录', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`);
    const b = build(`<div data-agent-object="task:2">B</div>`);
    const ev = diffSnapshots(a, b);
    expect(ev.details.some((d) => d.includes('appeared') && d.includes('object:task:2'))).toBe(true);
    expect(ev.details.some((d) => d.includes('gone') && d.includes('object:task:1'))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/honesty/verifier.test.ts`
Expected: FAIL（找不到模块）。

- [ ] **Step 3: 写 `src/honesty/verifier.ts`**

```ts
import type { PageSnapshot } from '../types';
import type { Evidence } from './types';

export function diffSnapshots(before: PageSnapshot, after: PageSnapshot): Evidence {
  const details: string[] = [];

  if (before.url !== after.url) {
    details.push(`url: ${before.url} → ${after.url}`);
  }

  const beforeObj = new Set(before.objects.map((o) => o.ref.id));
  const afterObj = new Set(after.objects.map((o) => o.ref.id));
  for (const id of afterObj) if (!beforeObj.has(id)) details.push(`object appeared: ${id}`);
  for (const id of beforeObj) if (!afterObj.has(id)) details.push(`object gone: ${id}`);

  const beforeCtrl = new Map(before.controls.map((c) => [c.ref.id, c.value]));
  for (const c of after.controls) {
    if (beforeCtrl.has(c.ref.id) && beforeCtrl.get(c.ref.id) !== c.value) {
      details.push(`control ${c.ref.id}: ${beforeCtrl.get(c.ref.id)} → ${c.value}`);
    }
  }

  const beforeSurf = new Map(before.surfaces.map((s) => [s.ref.id, s.text]));
  for (const s of after.surfaces) {
    if (beforeSurf.has(s.ref.id) && beforeSurf.get(s.ref.id) !== s.text) {
      details.push(`surface ${s.ref.id} changed`);
    }
  }

  return { changed: details.length > 0, details };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/honesty/verifier.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/honesty/verifier.ts test/honesty/verifier.test.ts
git commit -m "feat(honesty): verifier diffSnapshots（可观察变化判定）"
```

---

## Task 3：Ledger + computeOutcome

**Files:**
- Create: `src/honesty/ledger.ts`
- Test: `test/honesty/ledger.test.ts`

- [ ] **Step 1: 写失败测试 `test/honesty/ledger.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { Ledger, computeOutcome } from '../../src/honesty/ledger';

describe('Ledger', () => {
  it('append-only 记录并可导出', () => {
    const l = new Ledger();
    l.record({ kind: 'observe', tool: 'observePage', detail: 'x' });
    l.record({ kind: 'write', tool: 'invokeAction', refId: 'action:apply', verified: true, evidence: ['url changed'] });
    expect(l.toJSON()).toHaveLength(2);
    expect(l.entries[0]?.kind).toBe('observe');
  });
});

describe('computeOutcome', () => {
  it('无写动作 → completed', () => {
    expect(computeOutcome([{ kind: 'observe', tool: 'observePage', detail: 'x' }])).toBe('completed');
  });

  it('写动作已验证 → completed', () => {
    expect(
      computeOutcome([{ kind: 'write', tool: 'invokeAction', refId: 'a', verified: true, evidence: ['c'] }]),
    ).toBe('completed');
  });

  it('写动作未验证 → failed', () => {
    expect(
      computeOutcome([{ kind: 'write', tool: 'invokeAction', refId: 'a', verified: false, evidence: [] }]),
    ).toBe('failed');
  });

  it('高危被拒且无成功写 → cancelled', () => {
    expect(
      computeOutcome([
        { kind: 'intent', refId: 'a', label: 'x', expectedEvidence: [] },
        { kind: 'grant', refId: 'a', approved: false },
      ]),
    ).toBe('cancelled');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/honesty/ledger.test.ts`
Expected: FAIL（找不到模块）。

- [ ] **Step 3: 写 `src/honesty/ledger.ts`**

```ts
import type { LedgerEntry, Outcome } from './types';

export class Ledger {
  private readonly _entries: LedgerEntry[] = [];

  record(entry: LedgerEntry): void {
    this._entries.push(entry);
  }

  get entries(): readonly LedgerEntry[] {
    return this._entries;
  }

  toJSON(): LedgerEntry[] {
    return [...this._entries];
  }
}

export function computeOutcome(entries: readonly LedgerEntry[]): Outcome {
  const writes = entries.filter(
    (e): e is Extract<LedgerEntry, { kind: 'write' }> => e.kind === 'write',
  );
  const deniedGrant = entries.some((e) => e.kind === 'grant' && !e.approved);

  if (writes.some((w) => !w.verified)) return 'failed';
  if (deniedGrant && !writes.some((w) => w.verified)) return 'cancelled';
  return 'completed';
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/honesty/ledger.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/honesty/ledger.ts test/honesty/ledger.test.ts
git commit -m "feat(honesty): Evidence Ledger + computeOutcome（由证据计算 outcome）"
```

---

## Task 4：narrationGuard

**Files:**
- Create: `src/honesty/narrationGuard.ts`
- Test: `test/honesty/narrationGuard.test.ts`

- [ ] **Step 1: 写失败测试 `test/honesty/narrationGuard.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { guardFinish } from '../../src/honesty/narrationGuard';

describe('guardFinish', () => {
  it('completed 原样返回', () => {
    const r = guardFinish('已完成', [{ kind: 'write', tool: 'invokeAction', refId: 'a', verified: true, evidence: ['c'] }]);
    expect(r).toEqual({ answer: '已完成', outcome: 'completed' });
  });

  it('未验证写 → failed 且加注', () => {
    const r = guardFinish('已帮你提交', [
      { kind: 'write', tool: 'invokeAction', refId: 'a', verified: false, evidence: [] },
    ]);
    expect(r.outcome).toBe('failed');
    expect(r.answer).toContain('未能确认');
  });

  it('高危被拒 → cancelled 且加注', () => {
    const r = guardFinish('好的', [
      { kind: 'intent', refId: 'a', label: 'x', expectedEvidence: [] },
      { kind: 'grant', refId: 'a', approved: false },
    ]);
    expect(r.outcome).toBe('cancelled');
    expect(r.answer).toContain('未获确认');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/honesty/narrationGuard.test.ts`
Expected: FAIL（找不到模块）。

- [ ] **Step 3: 写 `src/honesty/narrationGuard.ts`**

```ts
import type { LedgerEntry, Outcome } from './types';
import { computeOutcome } from './ledger';

export function guardFinish(
  answer: string,
  entries: readonly LedgerEntry[],
): { answer: string; outcome: Outcome } {
  const outcome = computeOutcome(entries);
  if (outcome === 'completed') return { answer, outcome };

  const caveat =
    outcome === 'cancelled'
      ? '（注意：高风险操作未获确认，未执行。）'
      : '（注意：部分操作未能确认完成。）';
  return { answer: `${answer}\n${caveat}`.trim(), outcome };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/honesty/narrationGuard.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/honesty/narrationGuard.ts test/honesty/narrationGuard.test.ts
git commit -m "feat(honesty): narrationGuard（由 ledger 计算 outcome 并加注）"
```

---

## Task 5：写工具 schema + HostAdapter 写方法

**Files:**
- Modify: `src/core/tools.ts`
- Modify: `src/host/types.ts`
- Modify: `src/testing/fakeHostAdapter.ts`
- Modify: `src/adapters/domHostAdapter.ts`
- Test: `test/host/writeHost.test.ts`

- [ ] **Step 1: 在 `src/core/tools.ts` 末尾追加写工具**

```ts
export const WRITE_TOOLS: ToolSchema[] = [
  {
    name: 'setControl',
    description: '设置一个控件的值。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'control 的 ref id' },
        value: { type: 'string', description: '要设置的值' },
      },
      required: ['ref', 'value'],
      additionalProperties: false,
    },
  },
  { name: 'invokeAction', description: '触发一个动作（高危需确认）。', parameters: refParam('action 的 ref id') },
];

export const WRITE_REF_KINDS: Record<string, RefKind> = {
  setControl: 'control',
  invokeAction: 'action',
};

export const ACT_TOOLS: ToolSchema[] = [...READ_LOOP_TOOLS, ...WRITE_TOOLS];
```

- [ ] **Step 2: 在 `src/host/types.ts` 的 HostAdapter 接口加两个写方法**

把 HostAdapter 接口改为：

```ts
export interface HostAdapter {
  snapshot(): PageSnapshot;
  readSurface(ref: Ref): string;
  openObject(ref: Ref): Promise<HostResult>;
  navigate(ref: Ref): Promise<HostResult>;
  setControl(ref: Ref, value: string): Promise<HostResult>;
  invokeAction(ref: Ref): Promise<HostResult>;
}
```

- [ ] **Step 3: 在 `src/testing/fakeHostAdapter.ts` 实现写方法**

在 `navigate` 方法之后、`private transition` 之前插入：

```ts
  setControl(ref: Ref, value: string): Promise<HostResult> {
    this.log.push({ kind: `setControl=${value}`, refId: ref.id });
    const next = this.transitions.get(ref.id);
    if (next) this.current = next;
    return Promise.resolve({ ok: true, snapshot: this.current });
  }

  invokeAction(ref: Ref): Promise<HostResult> {
    return this.transition('invoke', ref);
  }
```

- [ ] **Step 4: 在 `src/adapters/domHostAdapter.ts` 实现写方法**

在返回对象里 `navigate` 之后追加：

```ts
    setControl(ref: Ref, value: string): Promise<HostResult> {
      const el = elements.get(ref.id);
      if (!el) return Promise.resolve({ ok: false, snapshot: current, note: `element for ${ref.id} not found` });
      if ('value' in el) {
        (el as HTMLInputElement).value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return Promise.resolve({ ok: true, snapshot: refresh() });
    },
    invokeAction(ref: Ref): Promise<HostResult> {
      return Promise.resolve(clickRef(ref));
    },
```

- [ ] **Step 5: 写测试 `test/host/writeHost.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';
import { parseContract } from '../../src/contract/parseContract';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import { WRITE_TOOLS, ACT_TOOLS, READ_LOOP_TOOLS } from '../../src/core/tools';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('write tools schema', () => {
  it('WRITE_TOOLS = setControl + invokeAction', () => {
    expect(WRITE_TOOLS.map((t) => t.name).sort()).toEqual(['invokeAction', 'setControl']);
  });
  it('ACT_TOOLS = 读工具 + 写工具', () => {
    expect(ACT_TOOLS).toHaveLength(READ_LOOP_TOOLS.length + WRITE_TOOLS.length);
  });
});

describe('domHostAdapter 写方法', () => {
  it('setControl 写入 input 值', async () => {
    document.body.innerHTML = `<input data-agent-control="amount" value="0" id="amt" />`;
    const adapter = createDomHostAdapter();
    adapter.snapshot();
    await adapter.setControl({ kind: 'control', id: 'control:amount' }, '300');
    expect((document.getElementById('amt') as HTMLInputElement).value).toBe('300');
  });

  it('invokeAction 点击动作元素', async () => {
    document.body.innerHTML = `<button data-agent-action="apply" id="ap">申请</button>`;
    let clicked = false;
    document.getElementById('ap')!.addEventListener('click', () => {
      clicked = true;
    });
    const adapter = createDomHostAdapter();
    adapter.snapshot();
    await adapter.invokeAction({ kind: 'action', id: 'action:apply' });
    expect(clicked).toBe(true);
  });
});

describe('FakeHostAdapter 写方法', () => {
  it('invokeAction 按 ref 转移快照', async () => {
    document.body.innerHTML = `<button data-agent-action="apply">A</button>`;
    const before = parseContract(document.body, '/p');
    document.body.innerHTML = `<section data-agent-surface="ok">已申请</section>`;
    const after = parseContract(document.body, '/done');
    const host = new FakeHostAdapter(before, { 'action:apply': after });
    const r = await host.invokeAction({ kind: 'action', id: 'action:apply' });
    expect(r.snapshot.url).toBe('/done');
    expect(host.log).toEqual([{ kind: 'invoke', refId: 'action:apply' }]);
  });
});
```

- [ ] **Step 6: 运行确认通过 + 类型检查**

Run: `npx vitest run test/host/writeHost.test.ts && npm run typecheck`
Expected: PASS（5 passed），typecheck 0 错误。

- [ ] **Step 7: Commit**

```bash
git add src/core/tools.ts src/host/types.ts src/testing/fakeHostAdapter.ts src/adapters/domHostAdapter.ts test/host/writeHost.test.ts
git commit -m "feat(host): 写工具 schema + HostAdapter setControl/invokeAction（Fake+DOM）"
```

---

## Task 6：loop 集成（held / ledger / verify / narration）

**Files:**
- Modify: `src/core/loop.ts`
- Modify: `test/core/loop.test.ts`（2 处旧断言改 toMatchObject）
- Test: `test/core/loopHonesty.test.ts`

- [ ] **Step 1: 把 `test/core/loop.test.ts` 中两处对 finish 的严格断言改为 toMatchObject**

把：
```ts
    expect(steps.at(-1)).toEqual({ type: 'finish', answer: '当前有 1 个任务：登录任务', outcome: 'completed' });
```
改为：
```ts
    expect(steps.at(-1)).toMatchObject({ type: 'finish', answer: '当前有 1 个任务：登录任务', outcome: 'completed' });
```

把：
```ts
    expect(steps).toEqual([{ type: 'finish', answer: '你好，我能帮你查看任务。', outcome: 'completed' }]);
```
改为：
```ts
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'finish', answer: '你好，我能帮你查看任务。', outcome: 'completed' });
```

- [ ] **Step 2: 写失败测试 `test/core/loopHonesty.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

async function collect(gen: AsyncGenerator<AgentStep>): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for await (const s of gen) steps.push(s);
  return steps;
}

describe('loop honesty', () => {
  it('低危写 setControl：执行并验证可观察变化', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const after = build(`<input data-agent-control="amount" value="300" />`, '/p');
    const llm = new FakeLlmAdapter([
      toolCallTurn('setControl', { ref: 'control:amount', value: '300' }),
      toolCallTurn('finish', { answer: '已填写金额 300' }),
    ]);
    const host = new FakeHostAdapter(before, { 'control:amount': after });
    const steps = await collect(createAgent({ llm, host }).run('填 300'));

    const act = steps.find((s) => s.type === 'action');
    expect(act).toMatchObject({ type: 'action', tool: 'setControl', verified: true });
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('高危 invokeAction + 批准：held → 执行 → completed', async () => {
    const before = build(`<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`, '/shop');
    const after = build(`<section data-agent-surface="ok">兑换成功</section>`, '/done');
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:redeem' }),
      toolCallTurn('finish', { answer: '已为你兑换' }),
    ]);
    const host = new FakeHostAdapter(before, { 'action:redeem': after });
    const steps = await collect(
      createAgent({ llm, host, confirm: async () => ({ approved: true }) }).run('兑换'),
    );

    expect(steps.some((s) => s.type === 'held')).toBe(true);
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('高危 invokeAction + 拒绝（默认）：held → cancelled，不执行，outcome=cancelled', async () => {
    const before = build(`<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`, '/shop');
    const after = build(`<section data-agent-surface="ok">不该发生</section>`, '/done');
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:redeem' }),
      toolCallTurn('finish', { answer: '已为你兑换' }),
    ]);
    const host = new FakeHostAdapter(before, { 'action:redeem': after });
    const steps = await collect(createAgent({ llm, host }).run('兑换')); // 无 confirm = 默认拒绝

    expect(steps.some((s) => s.type === 'held')).toBe(true);
    expect(steps.some((s) => s.type === 'cancelled')).toBe(true);
    expect(steps.some((s) => s.type === 'action')).toBe(false);
    expect(host.log).toEqual([]); // 未执行
    const finish = steps.at(-1);
    expect(finish).toMatchObject({ type: 'finish', outcome: 'cancelled' });
    expect(finish?.type === 'finish' && finish.answer).toContain('未获确认');
  });

  it('写后页面无变化：verified=false → outcome=failed 且加注', async () => {
    const same = build(`<button data-agent-action="apply">申请</button>`, '/p');
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:apply' }),
      toolCallTurn('finish', { answer: '已提交申请' }),
    ]);
    const host = new FakeHostAdapter(same); // 无转移 = 写后快照不变
    const steps = await collect(createAgent({ llm, host }).run('申请'));

    expect(steps.some((s) => s.type === 'action' && !s.verified)).toBe(true);
    const finish = steps.at(-1);
    expect(finish).toMatchObject({ type: 'finish', outcome: 'failed' });
    expect(finish?.type === 'finish' && finish.answer).toContain('未能确认');
  });

  it('finish 携带 ledger 票根', async () => {
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: 'hi' })]);
    const host = new FakeHostAdapter(build(`<div data-agent-object="task:1">A</div>`));
    const steps = await collect(createAgent({ llm, host }).run('hi'));
    const finish = steps.at(-1);
    expect(finish?.type === 'finish' && Array.isArray(finish.ledger)).toBe(true);
  });
});
```

- [ ] **Step 3: 重写 `src/core/loop.ts`**

```ts
import type { RefKind } from '../types';
import type { LlmAdapter, LlmMessage, LlmToolCall } from '../llm/types';
import type { HostAdapter } from '../host/types';
import type { ConfirmFn, Intent, LedgerEntry, Outcome } from '../honesty/types';
import { READ_LOOP_TOOLS, ACT_TOOLS, REF_TOOL_KINDS, WRITE_REF_KINDS } from './tools';
import { resolveRef } from './refResolver';
import { serializeSnapshot } from './serialize';
import { diffSnapshots } from '../honesty/verifier';
import { isHighRisk } from '../honesty/riskPolicy';
import { Ledger } from '../honesty/ledger';
import { guardFinish } from '../honesty/narrationGuard';

export type AgentStep =
  | { type: 'observation'; tool: string; refId?: string; result: string }
  | { type: 'action'; tool: string; refId: string; verified: boolean; evidence: string[] }
  | { type: 'held'; tool: string; refId: string; intent: Intent }
  | { type: 'cancelled'; tool: string; refId: string; reason: string }
  | { type: 'error'; tool: string; refId?: string; error: string }
  | { type: 'finish'; answer: string; outcome: Outcome; ledger: LedgerEntry[] };

export interface AgentOptions {
  llm: LlmAdapter;
  host: HostAdapter;
  confirm?: ConfirmFn;
  readOnly?: boolean;
  maxSteps?: number;
  systemPrompt?: string;
}

const DEFAULT_MAX_STEPS = 12;
const DENY: ConfirmFn = () => Promise.resolve({ approved: false });

function defaultSystemPrompt(): string {
  return [
    '你是一个网页助手。你只能通过提供的工具观察和操作页面。',
    '只能引用工具结果里出现过的 ref id，不要编造 ref/id/selector。',
    '高风险操作会先暂停等待用户确认；完成时调用 finish 给出用户可见的回答。',
    '无法确认结果时如实说明，不要假装成功。',
  ].join('\n');
}

interface CallResult {
  steps: AgentStep[];
  toolResult: string;
}

async function processCall(
  call: LlmToolCall,
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
): Promise<CallResult> {
  const name = call.name;

  if (name === 'observePage') {
    const result = serializeSnapshot(host.snapshot());
    ledger.record({ kind: 'observe', tool: name, detail: result });
    return { steps: [{ type: 'observation', tool: name, result }], toolResult: result };
  }

  const readKind: RefKind | undefined = REF_TOOL_KINDS[name];
  if (readKind) {
    const refId = String(call.arguments.ref ?? '');
    const res = resolveRef(host.snapshot(), refId, readKind);
    if (!res.ok) {
      ledger.record({ kind: 'error', tool: name, detail: res.error });
      return { steps: [{ type: 'error', tool: name, refId, error: res.error }], toolResult: `ERROR: ${res.error}` };
    }
    let result: string;
    if (name === 'readSurface') {
      result = host.readSurface(res.ref);
    } else {
      const r = name === 'openObject' ? await host.openObject(res.ref) : await host.navigate(res.ref);
      result = serializeSnapshot(r.snapshot);
    }
    ledger.record({ kind: 'observe', tool: name, detail: result });
    return { steps: [{ type: 'observation', tool: name, refId, result }], toolResult: result };
  }

  const writeKind: RefKind | undefined = WRITE_REF_KINDS[name];
  if (writeKind) {
    const refId = String(call.arguments.ref ?? '');
    const res = resolveRef(host.snapshot(), refId, writeKind);
    if (!res.ok) {
      ledger.record({ kind: 'error', tool: name, detail: res.error });
      return { steps: [{ type: 'error', tool: name, refId, error: res.error }], toolResult: `ERROR: ${res.error}` };
    }

    const steps: AgentStep[] = [];

    if (name === 'invokeAction' && isHighRisk(host.snapshot(), refId)) {
      const action = host.snapshot().actions.find((a) => a.ref.id === refId);
      const intent: Intent = {
        actionRef: refId,
        label: action?.label ?? refId,
        expectedEvidence: [`执行 ${action?.name ?? refId} 后页面应发生可观察变化`],
      };
      ledger.record({ kind: 'intent', refId, label: intent.label, expectedEvidence: intent.expectedEvidence });
      steps.push({ type: 'held', tool: name, refId, intent });

      const decision = await confirm(intent);
      ledger.record({ kind: 'grant', refId, approved: decision.approved });
      if (!decision.approved) {
        steps.push({ type: 'cancelled', tool: name, refId, reason: 'user declined' });
        return { steps, toolResult: 'ACTION CANCELLED: 用户拒绝了该高风险操作。' };
      }
    }

    const before = host.snapshot();
    const result =
      name === 'setControl'
        ? await host.setControl(res.ref, String(call.arguments.value ?? ''))
        : await host.invokeAction(res.ref);
    const evidence = diffSnapshots(before, result.snapshot);
    ledger.record({ kind: 'write', tool: name, refId, verified: evidence.changed, evidence: evidence.details });
    steps.push({ type: 'action', tool: name, refId, verified: evidence.changed, evidence: evidence.details });
    const toolResult = evidence.changed
      ? `done; 证据: ${evidence.details.join('; ')}`
      : '已执行，但未检测到可观察变化（未验证）。';
    return { steps, toolResult };
  }

  ledger.record({ kind: 'error', tool: name, detail: `unknown tool "${name}"` });
  return { steps: [{ type: 'error', tool: name, error: `unknown tool "${name}"` }], toolResult: 'ERROR: unknown tool' };
}

export function createAgent(options: AgentOptions) {
  const { llm, host } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const systemPrompt = options.systemPrompt ?? defaultSystemPrompt();
  const confirm = options.confirm ?? DENY;
  const tools = options.readOnly ? READ_LOOP_TOOLS : ACT_TOOLS;

  async function* run(userMessage: string): AsyncGenerator<AgentStep> {
    const ledger = new Ledger();
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    for (let i = 0; i < maxSteps; i++) {
      const turn = await llm.step(messages, tools);

      if (turn.toolCalls.length === 0) {
        const guarded = guardFinish(turn.content.trim(), ledger.entries);
        yield { type: 'finish', answer: guarded.answer, outcome: guarded.outcome, ledger: ledger.toJSON() };
        return;
      }

      messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

      let finished = false;
      for (const call of turn.toolCalls) {
        if (call.name === 'finish') {
          const guarded = guardFinish(String(call.arguments.answer ?? '').trim(), ledger.entries);
          yield { type: 'finish', answer: guarded.answer, outcome: guarded.outcome, ledger: ledger.toJSON() };
          finished = true;
          break;
        }
        const { steps, toolResult } = await processCall(call, host, ledger, confirm);
        for (const step of steps) yield step;
        messages.push({ role: 'tool', toolCallId: call.id, content: toolResult });
      }
      if (finished) return;
    }

    const guarded = guardFinish('我没能在限定步数内完成这个任务，没有可确认的结果。', ledger.entries);
    yield {
      type: 'finish',
      answer: guarded.answer,
      outcome: guarded.outcome === 'completed' ? 'failed' : guarded.outcome,
      ledger: ledger.toJSON(),
    };
  }

  return { run };
}
```

- [ ] **Step 4: 运行确认通过（新诚实测试 + 旧 loop 测试）**

Run: `npx vitest run test/core/loopHonesty.test.ts test/core/loop.test.ts`
Expected: PASS（loopHonesty 5 + loop 5 = 10 passed）。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/core/loop.ts test/core/loop.test.ts test/core/loopHonesty.test.ts
git commit -m "feat(core): loop 集成诚实层（held/Intent + verify + ledger + 由证据算 outcome）"
```

---

## Task 7：导出 + 全量验证 + Live 验收闸更新

**Files:**
- Modify: `src/index.ts`
- Modify: `docs/LIVE-ACCEPTANCE.md`

- [ ] **Step 1: 在 `src/index.ts` 更新 tools 导出并追加诚实层**

把 core 区的 tools 那行改为：

```ts
export { READ_LOOP_TOOLS, WRITE_TOOLS, ACT_TOOLS, REF_TOOL_KINDS, WRITE_REF_KINDS } from './core/tools';
```

在文件末尾追加：

```ts
// honesty 诚实层
export type { Intent, Evidence, LedgerEntry, Outcome, ConfirmFn } from './honesty/types';
export { diffSnapshots } from './honesty/verifier';
export { actionRisk, isHighRisk } from './honesty/riskPolicy';
export { Ledger, computeOutcome } from './honesty/ledger';
export { guardFinish } from './honesty/narrationGuard';
```

- [ ] **Step 2: 全量测试 + 类型检查 + 构建**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部 PASS（切片 1/2/3），typecheck 0 错误，dist 含 honesty 模块。

- [ ] **Step 3: 在 `docs/LIVE-ACCEPTANCE.md` 末尾追加写/held 场景**

```markdown

## 切片 3 追加场景（写动作 + held）
5. 低危写（"把出价填成 300"）：应 setControl 并报告 verified 的可观察变化。
6. 高危写（"帮我兑换这个礼品"）：必须先出现 held（Intent），confirm 拒绝 → outcome=cancelled 且不执行；confirm 批准 → 执行后 verifier 给出 evidence，outcome=completed。
7. 诚实性反例（写后页面无变化）：outcome 必须是 failed 并加注"未能确认"，绝不能说"已完成"。

## 切片 3 通过标准
- 高危动作 100% 先 held，默认不执行。
- outcome 与 ledger 证据一致（completed/failed/cancelled 由证据算出，非模型自述）。
- finish 携带的 ledger 含 intent/grant/write 三段票根，与实际轨迹一致。
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts docs/LIVE-ACCEPTANCE.md
git commit -m "feat(api): 导出诚实层公共面 + Live 验收闸补 held/写场景"
```

---

## 切片 3 验收

- [ ] `npm test` 全绿（切片 1/2/3）。
- [ ] `npm run typecheck` 0 错误。
- [ ] `npm run build` 产出含 honesty 模块的 dist。
- [ ] Live 验收闸（需 OpenAI key）：高危必 held、outcome 与证据一致、ledger 三段票根——未跑前标"代码完成、待 live 验收"。

---

## 自审记录

- **Spec 覆盖**：对应 spec §2.2（不变量 3 verify-or-refuse、4 narration guard、6 高危 held）、§5（写工具）、§6（verifier/ledger/narrationGuard/riskPolicy）。§7 planRunner、CandidateSet 仍在切片 4。
- **占位扫描**：无 TBD/TODO；每步完整代码。
- **类型一致性**：Intent / LedgerEntry 五态 / Outcome 三值 / ConfirmFn / HostAdapter 六方法 / AgentStep 六态（finish 带 ledger）/ processCall 返回 {steps,toolResult} / createAgent 选项含 confirm/readOnly；computeOutcome/guardFinish/diffSnapshots/isHighRisk 签名一致。
- **破坏性变更**：finish 新增 ledger 字段破坏切片 2 两处 toEqual——T6 Step 1 已改为 toMatchObject。
- **不变量保持**：读/写工具分组，readOnly 只给读工具；高危默认 DENY。
