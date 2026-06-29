# Attest 切片 2：读循环 + OpenAI 适配 + refResolver 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Attest 的单一 tool-calling 读循环——模型提议工具调用，harness 用 refResolver 校验 ref 后经 HostAdapter 执行/读取，直到 finish；接入 provider 无关的 LlmAdapter（默认 OpenAI Chat Completions）。

**Architecture:** createAgent({llm, host}).run(msg) 产出异步 step 流。读循环工具 = observePage / readSurface / openObject / navigate / finish（无写工具）。refResolver 只做结构校验。单测全用确定性 FakeLlmAdapter + FakeHostAdapter；openaiAdapter 用 mock fetch 测；真实 LLM 验收单列为手工闸。

**Tech Stack:** TypeScript (ESM, strict)、Vitest、happy-dom。零运行时依赖（OpenAI 走 fetch）。

---

## 范围

覆盖切片 2。不含写动作/verifier/ledger/held（切片 3）、CandidateSet/长程引用/planRunner（切片 4，planRunner 先 brainstorm）。navigate 与 openObject 均接 object ref；v1 DOM host 上都落到"按 ref 找元素→click→重新 snapshot"，证据差异留切片 3。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/llm/types.ts` | LlmMessage / LlmToolCall / ToolSchema / LlmTurn / LlmAdapter |
| `src/testing/fakeLlmAdapter.ts` | 脚本化 LlmAdapter + toolCallTurn/textTurn 助手 |
| `src/core/refResolver.ts` | resolveRef(snapshot, refId, expectedKind) 结构校验 |
| `src/core/tools.ts` | READ_LOOP_TOOLS schema + REF_TOOL_KINDS |
| `src/host/types.ts` | HostAdapter 接口（扩展）+ HostResult |
| `src/testing/fakeHostAdapter.ts` | 脚本化 HostAdapter（快照转移） |
| `src/core/serialize.ts` | serializeSnapshot 紧凑文本 |
| `src/core/loop.ts` | createAgent / run / AgentStep |
| `src/contract/parseContract.ts` | 加 parseContractWithElements（ref→element 注册表） |
| `src/adapters/domHostAdapter.ts` | 实现 readSurface/openObject/navigate |
| `src/llm/openaiAdapter.ts` | Chat Completions 实现（薄，fetch） |
| `src/index.ts` | 导出新公共面 |
| `docs/LIVE-ACCEPTANCE.md` | 真实 LLM 验收手工闸说明 |

---

## Task 1：LLM 类型 + FakeLlmAdapter

**Files:**
- Create: `src/llm/types.ts`
- Create: `src/testing/fakeLlmAdapter.ts`
- Test: `test/testing/fakeLlmAdapter.test.ts`

- [ ] **Step 1: 写 `src/llm/types.ts`**

```ts
export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmTurn {
  content: string;
  toolCalls: LlmToolCall[];
}

export interface LlmAdapter {
  step(messages: LlmMessage[], tools: ToolSchema[]): Promise<LlmTurn>;
}
```

- [ ] **Step 2: 写失败测试 `test/testing/fakeLlmAdapter.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { FakeLlmAdapter, toolCallTurn, textTurn } from '../../src/testing/fakeLlmAdapter';

describe('FakeLlmAdapter', () => {
  it('按脚本顺序返回 turn 并记录调用', async () => {
    const fake = new FakeLlmAdapter([toolCallTurn('observePage', {}), textTurn('done')]);
    const t1 = await fake.step([{ role: 'user', content: 'hi' }], []);
    const t2 = await fake.step([], []);

    expect(t1.toolCalls[0]?.name).toBe('observePage');
    expect(t2.content).toBe('done');
    expect(fake.calls).toHaveLength(2);
  });

  it('脚本用尽返回空 turn', async () => {
    const fake = new FakeLlmAdapter([]);
    const t = await fake.step([], []);
    expect(t).toEqual({ content: '', toolCalls: [] });
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/testing/fakeLlmAdapter.test.ts`
Expected: FAIL（找不到模块）。

- [ ] **Step 4: 写 `src/testing/fakeLlmAdapter.ts`**

```ts
import type { LlmAdapter, LlmMessage, LlmTurn, ToolSchema } from '../llm/types';

export function toolCallTurn(
  name: string,
  args: Record<string, unknown>,
  id = `call_${name}`,
): LlmTurn {
  return { content: '', toolCalls: [{ id, name, arguments: args }] };
}

export function textTurn(content: string): LlmTurn {
  return { content, toolCalls: [] };
}

export class FakeLlmAdapter implements LlmAdapter {
  private index = 0;
  public readonly calls: { messages: LlmMessage[]; tools: ToolSchema[] }[] = [];

  constructor(private readonly script: LlmTurn[]) {}

  step(messages: LlmMessage[], tools: ToolSchema[]): Promise<LlmTurn> {
    this.calls.push({ messages, tools });
    const turn = this.script[this.index];
    this.index += 1;
    return Promise.resolve(turn ?? { content: '', toolCalls: [] });
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/testing/fakeLlmAdapter.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 6: Commit**

```bash
git add src/llm/types.ts src/testing/fakeLlmAdapter.ts test/testing/fakeLlmAdapter.test.ts
git commit -m "feat(llm): LlmAdapter 类型 + FakeLlmAdapter（确定性脚本）"
```

---

## Task 2：refResolver（结构校验）

**Files:**
- Create: `src/core/refResolver.ts`
- Test: `test/core/refResolver.test.ts`

- [ ] **Step 1: 写失败测试 `test/core/refResolver.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { resolveRef } from '../../src/core/refResolver';

function snap() {
  document.body.innerHTML = `
    <div data-agent-object="task:42">T</div>
    <section data-agent-surface="detail">D</section>
  `;
  return parseContract(document.body, 'u');
}

describe('resolveRef', () => {
  it('ref 存在且 kind 匹配 → ok', () => {
    const r = resolveRef(snap(), 'object:task:42', 'object');
    expect(r).toEqual({ ok: true, ref: { kind: 'object', id: 'object:task:42' } });
  });

  it('ref 不存在 → error', () => {
    const r = resolveRef(snap(), 'object:task:999', 'object');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not found');
  });

  it('ref 存在但 kind 不符 → error 指出实际 kind', () => {
    const r = resolveRef(snap(), 'surface:detail', 'object');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('is a surface');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/core/refResolver.test.ts`
Expected: FAIL（找不到 resolveRef）。

- [ ] **Step 3: 写 `src/core/refResolver.ts`**

```ts
import type { PageSnapshot, Ref, RefKind } from '../types';

export type RefResolution = { ok: true; ref: Ref } | { ok: false; error: string };

export function resolveRef(
  snapshot: PageSnapshot,
  refId: string,
  expectedKind: RefKind,
): RefResolution {
  const all: Ref[] = [
    ...snapshot.objects.map((n) => n.ref),
    ...snapshot.actions.map((n) => n.ref),
    ...snapshot.controls.map((n) => n.ref),
    ...snapshot.surfaces.map((n) => n.ref),
  ];
  const found = all.find((r) => r.id === refId);
  if (!found) {
    return { ok: false, error: `ref "${refId}" not found in current page` };
  }
  if (found.kind !== expectedKind) {
    return { ok: false, error: `ref "${refId}" is a ${found.kind}, expected ${expectedKind}` };
  }
  return { ok: true, ref: found };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/core/refResolver.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/core/refResolver.ts test/core/refResolver.test.ts
git commit -m "feat(core): refResolver 结构校验（ref 存在 + kind 匹配）"
```

---

## Task 3：读循环工具 schema

**Files:**
- Create: `src/core/tools.ts`
- Test: `test/core/tools.test.ts`

- [ ] **Step 1: 写失败测试 `test/core/tools.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { READ_LOOP_TOOLS, REF_TOOL_KINDS } from '../../src/core/tools';

describe('read-loop tools', () => {
  it('暴露五个工具且无写工具', () => {
    const names = READ_LOOP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['finish', 'navigate', 'observePage', 'openObject', 'readSurface']);
    expect(names).not.toContain('invokeAction');
    expect(names).not.toContain('setControl');
  });

  it('ref 工具声明期望 kind', () => {
    expect(REF_TOOL_KINDS).toEqual({ readSurface: 'surface', openObject: 'object', navigate: 'object' });
  });

  it('finish 要求 answer 参数', () => {
    const finish = READ_LOOP_TOOLS.find((t) => t.name === 'finish');
    expect((finish?.parameters as { required?: string[] }).required).toEqual(['answer']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/core/tools.test.ts`
Expected: FAIL（找不到模块）。

- [ ] **Step 3: 写 `src/core/tools.ts`**

```ts
import type { RefKind } from '../types';
import type { ToolSchema } from '../llm/types';

const refParam = (desc: string) => ({
  type: 'object',
  properties: { ref: { type: 'string', description: desc } },
  required: ['ref'],
  additionalProperties: false,
});

export const READ_LOOP_TOOLS: ToolSchema[] = [
  {
    name: 'observePage',
    description: '读取当前页面的契约快照（对象/动作/控件/区域）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  { name: 'readSurface', description: '读取某个 surface 区域的文本内容。', parameters: refParam('surface 的 ref id') },
  { name: 'openObject', description: '打开/选中一个对象以查看更多。', parameters: refParam('object 的 ref id') },
  { name: 'navigate', description: '跳转到某个对象的详情/位置。', parameters: refParam('object 的 ref id') },
  {
    name: 'finish',
    description: '结束并给出用户可见的最终回答。',
    parameters: {
      type: 'object',
      properties: { answer: { type: 'string', description: '给用户的最终回答' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
];

export const REF_TOOL_KINDS: Record<string, RefKind> = {
  readSurface: 'surface',
  openObject: 'object',
  navigate: 'object',
};
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/core/tools.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/core/tools.ts test/core/tools.test.ts
git commit -m "feat(core): 读循环工具 schema + REF_TOOL_KINDS（无写工具）"
```

---

## Task 4：HostAdapter 接口扩展 + FakeHostAdapter

**Files:**
- Create: `src/host/types.ts`
- Create: `src/testing/fakeHostAdapter.ts`
- Test: `test/testing/fakeHostAdapter.test.ts`

- [ ] **Step 1: 写 `src/host/types.ts`**

```ts
import type { PageSnapshot, Ref } from '../types';

export interface HostResult {
  ok: boolean;
  snapshot: PageSnapshot;
  note?: string;
}

export interface HostAdapter {
  snapshot(): PageSnapshot;
  readSurface(ref: Ref): string;
  openObject(ref: Ref): Promise<HostResult>;
  navigate(ref: Ref): Promise<HostResult>;
}
```

- [ ] **Step 2: 写失败测试 `test/testing/fakeHostAdapter.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';

function listSnap() {
  document.body.innerHTML = `<div data-agent-object="task:1">列表项</div>`;
  return parseContract(document.body, '/list');
}
function detailSnap() {
  document.body.innerHTML = `<section data-agent-surface="detail">详情正文</section>`;
  return parseContract(document.body, '/detail');
}

describe('FakeHostAdapter', () => {
  it('openObject 按 ref 转移到目标快照并记录', async () => {
    const detail = detailSnap();
    const host = new FakeHostAdapter(listSnap(), { 'object:task:1': detail });
    const r = await host.openObject({ kind: 'object', id: 'object:task:1' });

    expect(r.ok).toBe(true);
    expect(host.snapshot().url).toBe('/detail');
    expect(host.log).toEqual([{ kind: 'open', refId: 'object:task:1' }]);
  });

  it('readSurface 从当前快照读文本', () => {
    const host = new FakeHostAdapter(detailSnap());
    expect(host.readSurface({ kind: 'surface', id: 'surface:detail' })).toBe('详情正文');
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run test/testing/fakeHostAdapter.test.ts`
Expected: FAIL（找不到 FakeHostAdapter）。

- [ ] **Step 4: 写 `src/testing/fakeHostAdapter.ts`**

```ts
import type { PageSnapshot, Ref } from '../types';
import type { HostAdapter, HostResult } from '../host/types';

export class FakeHostAdapter implements HostAdapter {
  private current: PageSnapshot;
  private readonly transitions: Map<string, PageSnapshot>;
  public readonly log: { kind: string; refId: string }[] = [];

  constructor(initial: PageSnapshot, transitions: Record<string, PageSnapshot> = {}) {
    this.current = initial;
    this.transitions = new Map(Object.entries(transitions));
  }

  snapshot(): PageSnapshot {
    return this.current;
  }

  readSurface(ref: Ref): string {
    return this.current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '';
  }

  openObject(ref: Ref): Promise<HostResult> {
    return this.transition('open', ref);
  }

  navigate(ref: Ref): Promise<HostResult> {
    return this.transition('navigate', ref);
  }

  private transition(kind: string, ref: Ref): Promise<HostResult> {
    this.log.push({ kind, refId: ref.id });
    const next = this.transitions.get(ref.id);
    if (next) this.current = next;
    return Promise.resolve({ ok: true, snapshot: this.current });
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/testing/fakeHostAdapter.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 6: Commit**

```bash
git add src/host/types.ts src/testing/fakeHostAdapter.ts test/testing/fakeHostAdapter.test.ts
git commit -m "feat(host): HostAdapter 接口扩展 + FakeHostAdapter（快照转移）"
```

---

## Task 5：serializeSnapshot

**Files:**
- Create: `src/core/serialize.ts`
- Test: `test/core/serialize.test.ts`

- [ ] **Step 1: 写失败测试 `test/core/serialize.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { serializeSnapshot } from '../../src/core/serialize';

describe('serializeSnapshot', () => {
  it('输出紧凑文本，标记 high-risk', () => {
    document.body.innerHTML = `
      <div data-agent-object="task:7">写测试</div>
      <button data-agent-action="redeem" data-agent-risk="high">兑换</button>
      <section data-agent-surface="detail">x</section>
    `;
    const text = serializeSnapshot(parseContract(document.body, '/p'));
    expect(text).toContain('url: /p');
    expect(text).toContain('object object:task:7 — 写测试');
    expect(text).toContain('action action:redeem [high-risk] — 兑换');
    expect(text).toContain('surface surface:detail — detail');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/core/serialize.test.ts`
Expected: FAIL（找不到模块）。

- [ ] **Step 3: 写 `src/core/serialize.ts`**

```ts
import type { PageSnapshot } from '../types';

export function serializeSnapshot(s: PageSnapshot): string {
  const lines: string[] = [`url: ${s.url}`];
  for (const o of s.objects) lines.push(`object ${o.ref.id} — ${o.label}`);
  for (const a of s.actions) {
    lines.push(`action ${a.ref.id}${a.risk === 'high' ? ' [high-risk]' : ''} — ${a.label}`);
  }
  for (const c of s.controls) lines.push(`control ${c.ref.id} = ${c.value ?? ''} — ${c.label}`);
  for (const su of s.surfaces) lines.push(`surface ${su.ref.id} — ${su.name}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/core/serialize.test.ts`
Expected: PASS（1 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/core/serialize.ts test/core/serialize.test.ts
git commit -m "feat(core): serializeSnapshot 紧凑文本快照"
```

---

## Task 6：读循环 loop.ts（核心）

**Files:**
- Create: `src/core/loop.ts`
- Test: `test/core/loop.test.ts`

- [ ] **Step 1: 写失败测试 `test/core/loop.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn, textTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';

function listSnap() {
  document.body.innerHTML = `<div data-agent-object="task:1">登录任务</div>`;
  return parseContract(document.body, '/list');
}
function detailSnap() {
  document.body.innerHTML = `<section data-agent-surface="detail">需要修复登录</section>`;
  return parseContract(document.body, '/detail');
}

async function collect(gen: AsyncGenerator<AgentStep>): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for await (const s of gen) steps.push(s);
  return steps;
}

describe('read loop', () => {
  it('observePage → finish：产出观察与完成终答', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('observePage', {}),
      toolCallTurn('finish', { answer: '当前有 1 个任务：登录任务' }),
    ]);
    const host = new FakeHostAdapter(listSnap());
    const steps = await collect(createAgent({ llm, host }).run('有什么任务'));

    expect(steps[0]).toMatchObject({ type: 'observation', tool: 'observePage' });
    expect(steps[0]?.type === 'observation' && steps[0].result).toContain('登录任务');
    expect(steps.at(-1)).toEqual({ type: 'finish', answer: '当前有 1 个任务：登录任务', outcome: 'completed' });
  });

  it('非法 ref → error step，且不执行 host', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: 'object:task:999' }),
      toolCallTurn('finish', { answer: '找不到那个任务' }),
    ]);
    const host = new FakeHostAdapter(listSnap());
    const steps = await collect(createAgent({ llm, host }).run('打开任务'));

    expect(steps[0]).toMatchObject({ type: 'error', tool: 'openObject', refId: 'object:task:999' });
    expect(host.log).toEqual([]);
  });

  it('openObject 进详情后 readSurface 跨页读取', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: 'object:task:1' }),
      toolCallTurn('readSurface', { ref: 'surface:detail' }),
      toolCallTurn('finish', { answer: '任务详情：需要修复登录' }),
    ]);
    const host = new FakeHostAdapter(listSnap(), { 'object:task:1': detailSnap() });
    const steps = await collect(createAgent({ llm, host }).run('看任务1详情'));

    expect(host.log[0]).toEqual({ kind: 'open', refId: 'object:task:1' });
    const read = steps.find((s) => s.type === 'observation' && s.tool === 'readSurface');
    expect(read && read.type === 'observation' && read.result).toBe('需要修复登录');
  });

  it('纯文本回复（无 tool_call）当作完成终答', async () => {
    const llm = new FakeLlmAdapter([textTurn('你好，我能帮你查看任务。')]);
    const host = new FakeHostAdapter(listSnap());
    const steps = await collect(createAgent({ llm, host }).run('你好'));
    expect(steps).toEqual([{ type: 'finish', answer: '你好，我能帮你查看任务。', outcome: 'completed' }]);
  });

  it('超过 maxSteps → 诚实的 failed 终答', async () => {
    const llm = new FakeLlmAdapter(Array(20).fill(toolCallTurn('observePage', {})));
    const host = new FakeHostAdapter(listSnap());
    const steps = await collect(createAgent({ llm, host, maxSteps: 3 }).run('循环'));

    const last = steps.at(-1);
    expect(last).toMatchObject({ type: 'finish', outcome: 'failed' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/core/loop.test.ts`
Expected: FAIL（找不到 createAgent）。

- [ ] **Step 3: 写 `src/core/loop.ts`**

```ts
import type { RefKind } from '../types';
import type { LlmAdapter, LlmMessage, LlmToolCall } from '../llm/types';
import type { HostAdapter } from '../host/types';
import { READ_LOOP_TOOLS, REF_TOOL_KINDS } from './tools';
import { resolveRef } from './refResolver';
import { serializeSnapshot } from './serialize';

export type AgentStep =
  | { type: 'observation'; tool: string; refId?: string; result: string }
  | { type: 'error'; tool: string; refId?: string; error: string }
  | { type: 'finish'; answer: string; outcome: 'completed' | 'failed' };

export interface AgentOptions {
  llm: LlmAdapter;
  host: HostAdapter;
  maxSteps?: number;
  systemPrompt?: string;
}

const DEFAULT_MAX_STEPS = 12;

function defaultSystemPrompt(): string {
  return [
    '你是一个网页助手。你只能通过提供的工具观察和操作页面。',
    '只能引用工具结果里出现过的 ref id，不要编造 ref/id/selector。',
    '完成时调用 finish 给出用户可见的回答；无法确认结果时如实说明，不要假装成功。',
  ].join('\n');
}

async function handleToolCall(call: LlmToolCall, host: HostAdapter): Promise<AgentStep> {
  const name = call.name;
  if (name === 'finish') {
    return { type: 'finish', answer: String(call.arguments.answer ?? '').trim(), outcome: 'completed' };
  }
  if (name === 'observePage') {
    return { type: 'observation', tool: name, result: serializeSnapshot(host.snapshot()) };
  }
  const expectedKind: RefKind | undefined = REF_TOOL_KINDS[name];
  if (!expectedKind) {
    return { type: 'error', tool: name, error: `unknown tool "${name}"` };
  }
  const refId = String(call.arguments.ref ?? '');
  const resolution = resolveRef(host.snapshot(), refId, expectedKind);
  if (!resolution.ok) {
    return { type: 'error', tool: name, refId, error: resolution.error };
  }
  if (name === 'readSurface') {
    return { type: 'observation', tool: name, refId, result: host.readSurface(resolution.ref) };
  }
  const result = name === 'openObject'
    ? await host.openObject(resolution.ref)
    : await host.navigate(resolution.ref);
  return { type: 'observation', tool: name, refId, result: serializeSnapshot(result.snapshot) };
}

function toolResultContent(step: AgentStep): string {
  if (step.type === 'error') return `ERROR: ${step.error}`;
  if (step.type === 'observation') return step.result;
  return step.answer;
}

export function createAgent(options: AgentOptions) {
  const { llm, host } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const systemPrompt = options.systemPrompt ?? defaultSystemPrompt();

  async function* run(userMessage: string): AsyncGenerator<AgentStep> {
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    for (let i = 0; i < maxSteps; i++) {
      const turn = await llm.step(messages, READ_LOOP_TOOLS);

      if (turn.toolCalls.length === 0) {
        yield { type: 'finish', answer: turn.content.trim(), outcome: 'completed' };
        return;
      }

      messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

      let finished = false;
      for (const call of turn.toolCalls) {
        const step = await handleToolCall(call, host);
        yield step;
        messages.push({ role: 'tool', toolCallId: call.id, content: toolResultContent(step) });
        if (step.type === 'finish') finished = true;
      }
      if (finished) return;
    }

    yield {
      type: 'finish',
      answer: '我没能在限定步数内完成这个任务，没有可确认的结果。',
      outcome: 'failed',
    };
  }

  return { run };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/core/loop.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/core/loop.ts test/core/loop.test.ts
git commit -m "feat(core): 单 tool-calling 读循环（observe/read/open/navigate/finish + 校验 + 超步 failed）"
```

---

## Task 7：契约 element 注册表 + domHostAdapter 执行

**Files:**
- Modify: `src/contract/parseContract.ts`
- Modify: `src/adapters/domHostAdapter.ts`
- Test: `test/adapters/domHostAdapter.exec.test.ts`

- [ ] **Step 1: 在 `parseContract.ts` 末尾追加 `parseContractWithElements`**

在文件末尾（parseContract 函数之后）追加。注意：domHostAdapter 直接持有此 map，按 ref 取元素，因此无需担心索引错位。

```ts
export interface ContractParseResult {
  snapshot: PageSnapshot;
  elements: Map<string, Element>;
}

export function parseContractWithElements(root: ParentNode, url: string): ContractParseResult {
  const snapshot = parseContract(root, url);
  const elements = new Map<string, Element>();

  const bind = (selector: string, nodes: readonly { ref: { id: string } }[]) => {
    const els = Array.from(root.querySelectorAll(selector));
    nodes.forEach((node, i) => {
      const el = els[i];
      if (el && !elements.has(node.ref.id)) elements.set(node.ref.id, el);
    });
  };
  bind('[data-agent-object]', snapshot.objects);
  bind('[data-agent-action]', snapshot.actions);
  bind('[data-agent-control]', snapshot.controls);
  bind('[data-agent-surface]', snapshot.surfaces);

  return { snapshot, elements };
}
```

- [ ] **Step 2: 写失败测试 `test/adapters/domHostAdapter.exec.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('domHostAdapter 执行', () => {
  it('openObject 点击对应元素并返回新快照', async () => {
    document.body.innerHTML = `<button data-agent-object="task:5" id="t5">任务5</button>`;
    let clicked = false;
    document.getElementById('t5')!.addEventListener('click', () => {
      clicked = true;
    });
    const adapter = createDomHostAdapter();
    adapter.snapshot();
    const r = await adapter.openObject({ kind: 'object', id: 'object:task:5' });

    expect(clicked).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('readSurface 读取 surface 文本', () => {
    document.body.innerHTML = `<section data-agent-surface="detail">正文内容</section>`;
    const adapter = createDomHostAdapter();
    adapter.snapshot();
    expect(adapter.readSurface({ kind: 'surface', id: 'surface:detail' })).toBe('正文内容');
  });
});
```

- [ ] **Step 3: 重写 `src/adapters/domHostAdapter.ts`（按 ref 绑定）**

```ts
import type { PageSnapshot, Ref } from '../types';
import type { HostAdapter, HostResult } from '../host/types';
import { parseContractWithElements } from '../contract/parseContract';

export interface DomHostAdapterOptions {
  root?: ParentNode;
  getUrl?: () => string;
}

const EMPTY: PageSnapshot = { url: '', objects: [], actions: [], controls: [], surfaces: [] };

export function createDomHostAdapter(options: DomHostAdapterOptions = {}): HostAdapter {
  const getUrl = options.getUrl ?? (() => location.href);
  let elements = new Map<string, Element>();
  let current: PageSnapshot = EMPTY;

  function refresh(): PageSnapshot {
    const root = options.root ?? document.body;
    const parsed = parseContractWithElements(root, getUrl());
    current = parsed.snapshot;
    elements = parsed.elements;
    return current;
  }

  function clickRef(ref: Ref): HostResult {
    const el = elements.get(ref.id);
    if (!el) return { ok: false, snapshot: current, note: `element for ${ref.id} not found` };
    (el as HTMLElement).click();
    return { ok: true, snapshot: refresh() };
  }

  return {
    snapshot(): PageSnapshot {
      return refresh();
    },
    readSurface(ref: Ref): string {
      return current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '';
    },
    openObject(ref: Ref): Promise<HostResult> {
      return Promise.resolve(clickRef(ref));
    },
    navigate(ref: Ref): Promise<HostResult> {
      return Promise.resolve(clickRef(ref));
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/adapters/domHostAdapter.exec.test.ts test/adapters/domHostAdapter.test.ts`
Expected: PASS（4 passed：切片 1 的 2 个 snapshot 测试仍通过，因 snapshot() 行为不变）。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/contract/parseContract.ts src/adapters/domHostAdapter.ts test/adapters/domHostAdapter.exec.test.ts
git commit -m "feat(host): ref→element 注册表 + domHostAdapter 执行（open/navigate/readSurface）"
```

---

## Task 8：openaiAdapter（Chat Completions，mock fetch 测）

**Files:**
- Create: `src/llm/openaiAdapter.ts`
- Test: `test/llm/openaiAdapter.test.ts`

- [ ] **Step 1: 写失败测试 `test/llm/openaiAdapter.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createOpenAiAdapter } from '../../src/llm/openaiAdapter';
import { READ_LOOP_TOOLS } from '../../src/core/tools';

describe('openaiAdapter', () => {
  it('解析 tool_calls 为 LlmTurn', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'observePage', arguments: '{}' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl });
    const turn = await adapter.step([{ role: 'user', content: 'hi' }], READ_LOOP_TOOLS);

    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'observePage', arguments: {} }]);
    expect(turn.content).toBe('');
  });

  it('构造请求：带 model、tools、Authorization', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '好的' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', model: 'gpt-x', fetchImpl });
    const turn = await adapter.step([{ role: 'user', content: 'hi' }], READ_LOOP_TOOLS);

    expect(turn).toEqual({ content: '好的', toolCalls: [] });
    expect(captured!.url).toContain('/chat/completions');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.model).toBe('gpt-x');
    expect(body.tools).toHaveLength(READ_LOOP_TOOLS.length);
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('非 2xx 抛错', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'bad', fetchImpl });
    await expect(adapter.step([], [])).rejects.toThrow('401');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/llm/openaiAdapter.test.ts`
Expected: FAIL（找不到 createOpenAiAdapter）。

- [ ] **Step 3: 写 `src/llm/openaiAdapter.ts`**

```ts
import type { LlmAdapter, LlmMessage, LlmToolCall, LlmTurn, ToolSchema } from './types';

export interface OpenAiAdapterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface OpenAiResponse {
  choices: { message: { content: string | null; tool_calls?: OpenAiToolCall[] } }[];
}

function toOpenAiMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function createOpenAiAdapter(options: OpenAiAdapterOptions): LlmAdapter {
  const model = options.model ?? 'gpt-4o-mini';
  const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async step(messages: LlmMessage[], tools: ToolSchema[]): Promise<LlmTurn> {
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map(toOpenAiMessage),
          tools: tools.map((t) => ({ type: 'function', function: t })),
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI request failed: ${res.status}`);
      }
      const data = (await res.json()) as OpenAiResponse;
      const message = data.choices[0]?.message ?? { content: '' };
      const toolCalls: LlmToolCall[] = (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: parseArguments(c.function.arguments),
      }));
      return { content: message.content ?? '', toolCalls };
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/llm/openaiAdapter.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/llm/openaiAdapter.ts test/llm/openaiAdapter.test.ts
git commit -m "feat(llm): OpenAI Chat Completions 适配器（fetch，可注入 mock）"
```

---

## Task 9：导出 + 全量验证 + Live 验收闸文档

**Files:**
- Modify: `src/index.ts`
- Create: `docs/LIVE-ACCEPTANCE.md`

- [ ] **Step 1: 重写 `src/index.ts`**

```ts
// 契约层
export type {
  Ref,
  RefKind,
  Risk,
  ObjectNode,
  ActionNode,
  ControlNode,
  SurfaceNode,
  PageSnapshot,
} from './types';
export { parseContract, parseContractWithElements } from './contract/parseContract';
export type { ContractParseResult } from './contract/parseContract';
export { RefMinter } from './contract/refs';

// host
export type { HostAdapter, HostResult } from './host/types';
export { createDomHostAdapter } from './adapters/domHostAdapter';
export type { DomHostAdapterOptions } from './adapters/domHostAdapter';

// llm
export type { LlmAdapter, LlmMessage, LlmToolCall, LlmTurn, ToolSchema, LlmRole } from './llm/types';
export { createOpenAiAdapter } from './llm/openaiAdapter';
export type { OpenAiAdapterOptions } from './llm/openaiAdapter';

// core
export { createAgent } from './core/loop';
export type { AgentStep, AgentOptions } from './core/loop';
export { resolveRef } from './core/refResolver';
export type { RefResolution } from './core/refResolver';
export { READ_LOOP_TOOLS, REF_TOOL_KINDS } from './core/tools';
export { serializeSnapshot } from './core/serialize';

// testing 双适配器（供库使用者写测试）
export { FakeLlmAdapter, toolCallTurn, textTurn } from './testing/fakeLlmAdapter';
export { FakeHostAdapter } from './testing/fakeHostAdapter';
```

- [ ] **Step 2: 全量测试 + 类型检查 + 构建**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部 PASS（切片 1 的 12 + 切片 2 新增），typecheck 0 错误，dist/index.d.ts 含新导出。

- [ ] **Step 3: 写 `docs/LIVE-ACCEPTANCE.md`**

```markdown
# Live 验收闸（真实 LLM 回合）

> 自动测试用 FakeLlmAdapter，证明不了对话质量。交付切片 2 前必须用真实 OpenAI key 跑一次。

## 前置
- 环境变量 OPENAI_API_KEY。
- 一个含 data-agent-* 的真实页面（或 examples 里的示范页，切片 4 提供）。

## 步骤
1. 用 createOpenAiAdapter({ apiKey: process.env.OPENAI_API_KEY }) + createDomHostAdapter() 组装 createAgent。
2. 至少发以下消息，逐条记录"用户输入 → 工具动作序列 → 页面结果 → finish 终答"：
   - 打招呼/闲聊（应自然 finish，不乱调工具）
   - 只读总结（"这页有什么"——应 observePage 后如实总结）
   - 跨页读取（"看第一个的详情"——应 openObject → readSurface → 综合）
   - 引用不存在的东西（应得到 error 并要求澄清，不编造 ref）

## 通过标准（写进报告）
- finish 的 outcome 为 completed 且不是靠 maxSteps 兜底的 failed。
- 工具调用的 ref 全部来自 observePage 结果，无编造。
- 终答与工具轨迹一致，无"工具失败却声称成功"。
- 语言自然、不机械、不跨域串台。

任一不满足 → 切片 2 视为未验收，记录现象再修。
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts docs/LIVE-ACCEPTANCE.md
git commit -m "feat(api): 导出切片2公共面 + Live 验收闸文档"
```

---

## 切片 2 验收

- [ ] `npm test` 全绿（切片 1 + 切片 2 全部）。
- [ ] `npm run typecheck` 0 错误。
- [ ] `npm run build` 产出含新导出的 dist/index.d.ts。
- [ ] Live 验收闸（docs/LIVE-ACCEPTANCE.md）：需用户提供 OpenAI key 后单独执行；未跑前切片 2 标记"代码完成、待 live 验收"，不声称"已验收"。

---

## 自审记录

- **Spec 覆盖**：对应 spec §2.2（核心不变量 1/2/5）、§2.3（回合流转）、§3（公共 API createAgent）、§5（工具集，写型留切片 3）、§8（llmAdapter OpenAI、hostAdapter 执行）、§11（真实 LLM 回合验收闸）。verifier/ledger/narrationGuard（§6）、planRunner（§7）划入切片 3/4。
- **占位扫描**：无 TBD/TODO；每步含完整代码。
- **类型一致性**：LlmTurn{content,toolCalls}、LlmToolCall{id,name,arguments}、AgentStep 三态、HostAdapter{snapshot,readSurface,openObject,navigate}、HostResult{ok,snapshot,note?}、resolveRef(snapshot,refId,expectedKind)、REF_TOOL_KINDS、createAgent({llm,host,maxSteps?,systemPrompt?}) 全程一致；FakeHostAdapter 的 log 字段与 loop 测试引用一致。
- **element 注册表**：domHostAdapter 直接持有 parseContractWithElements 的 map 并按 ref 取元素，规避按索引绑定在非法声明时的错位风险。
