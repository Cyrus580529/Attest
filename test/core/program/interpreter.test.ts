import { describe, it, expect, beforeEach } from 'vitest';
import { parseContract } from '../../../src/contract/parseContract';
import { FakeHostAdapter } from '../../../src/testing/fakeHostAdapter';
import { Ledger, computeOutcome } from '../../../src/honesty/ledger';
import { runProgram } from '../../../src/core/program/interpreter';
import type { Program } from '../../../src/core/program/types';
import type { AgentStep } from '../../../src/core/loop';
import type { ConfirmFn } from '../../../src/honesty/types';
import type { HostAdapter } from '../../../src/host/types';
import type { PageSnapshot } from '../../../src/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

function makeSnap(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

const APPROVE_ONCE: ConfirmFn = () => Promise.resolve({ approved: true, scope: 'once' });
const DENY: ConfirmFn = () => Promise.resolve({ approved: false });

async function drain(gen: AsyncGenerator<AgentStep, { answer: string; aborted: boolean }>) {
  const steps: AgentStep[] = [];
  let r = await gen.next();
  while (!r.done) {
    steps.push(r.value);
    r = await gen.next();
  }
  return { steps, ret: r.value };
}

const BOARD = `
  <ul>
    <li data-agent-object="ticket:101">A</li>
    <li data-agent-object="ticket:102">B</li>
  </ul>
  <section data-agent-surface="detail">选择工单</section>
`;

describe('ProgramInterpreter', () => {
  it('forEach 遍历所有匹配对象并绑定 $var', async () => {
    const host = new FakeHostAdapter(makeSnap(BOARD));
    const program: Program = {
      body: [
        { op: 'forEach', query: { type: 'ticket' }, as: 't', do: [{ op: 'open', on: '$t' }] },
        { op: 'finish', answer: 'done' },
      ],
    };
    const { ret } = await drain(runProgram(program, { host, ledger: new Ledger(), confirm: DENY }));
    const opens = host.log.filter((l) => l.kind === 'open').map((l) => l.refId);
    expect(opens).toEqual(['object:ticket:101', 'object:ticket:102']);
    expect(ret.answer).toBe('done');
    expect(ret.aborted).toBe(false);
  });

  it('open 按描述/label 解析对象（不止 ref-id）', async () => {
    const host = new FakeHostAdapter(makeSnap(BOARD));
    const program: Program = {
      body: [{ op: 'open', on: 'B' }, { op: 'finish', answer: 'ok' }], // "B" 是 ticket:102 的 label
    };
    const { ret } = await drain(runProgram(program, { host, ledger: new Ledger(), confirm: DENY }));
    expect(host.log.filter((l) => l.kind === 'open').map((l) => l.refId)).toEqual(['object:ticket:102']);
    expect(ret.aborted).toBe(false);
  });

  it('open 描述歧义/无匹配 → 中止（不猜）', async () => {
    const host = new FakeHostAdapter(makeSnap(BOARD));
    const program: Program = { body: [{ op: 'open', on: '不存在的标签' }] };
    const { steps, ret } = await drain(runProgram(program, { host, ledger: new Ledger(), confirm: DENY }));
    expect(steps.some((s) => s.type === 'error')).toBe(true);
    expect(ret.aborted).toBe(true);
    expect(host.log.some((l) => l.kind === 'open')).toBe(false);
  });

  it('if 真分支执行、假分支跳过', async () => {
    const truthy: Program = {
      body: [{ op: 'if', cond: { surface: 'detail', contains: '选择' }, then: [{ op: 'open', on: 'object:ticket:101' }] }],
    };
    const h1 = new FakeHostAdapter(makeSnap(BOARD));
    await drain(runProgram(truthy, { host: h1, ledger: new Ledger(), confirm: DENY }));
    expect(h1.log.some((l) => l.kind === 'open')).toBe(true);

    const falsy: Program = {
      body: [{ op: 'if', cond: { surface: 'detail', contains: '不存在' }, then: [{ op: 'open', on: 'object:ticket:101' }] }],
    };
    const h2 = new FakeHostAdapter(makeSnap(BOARD));
    await drain(runProgram(falsy, { host: h2, ledger: new Ledger(), confirm: DENY }));
    expect(h2.log.some((l) => l.kind === 'open')).toBe(false);
  });

  it('实时解析：open 改变 detail 后 if 读到的是新快照', async () => {
    const before = makeSnap(BOARD, '/board');
    const after = makeSnap(
      `<li data-agent-object="ticket:101">A</li><section data-agent-surface="detail">urgent bug</section>`,
      '/board',
    );
    const host = new FakeHostAdapter(before, { 'object:ticket:101': after });
    const program: Program = {
      body: [
        { op: 'open', on: 'object:ticket:101' },
        { op: 'if', cond: { surface: 'detail', contains: 'urgent' }, then: [{ op: 'observe' }] },
      ],
    };
    const { steps } = await drain(runProgram(program, { host, ledger: new Ledger(), confirm: DENY }));
    // open 产 1 个 observation；if 命中（读到 open 后的 urgent）→ observe 再产 1 个 = 2
    expect(steps.filter((s) => s.type === 'observation')).toHaveLength(2);
  });

  it('未绑定变量 / ref 未命中 → 中止', async () => {
    const host = new FakeHostAdapter(makeSnap(BOARD));
    const program: Program = { body: [{ op: 'open', on: '$ghost' }, { op: 'observe' }] };
    const { steps, ret } = await drain(runProgram(program, { host, ledger: new Ledger(), confirm: DENY }));
    expect(steps.some((s) => s.type === 'error')).toBe(true);
    expect(steps.some((s) => s.type === 'observation')).toBe(false); // 中止，后续 observe 未跑
    expect(ret.aborted).toBe(true);
  });

  it('超出 maxNodes → 中止', async () => {
    const host = new FakeHostAdapter(makeSnap(BOARD));
    const program: Program = { body: [{ op: 'observe' }, { op: 'observe' }, { op: 'observe' }] };
    const { steps, ret } = await drain(runProgram(program, { host, ledger: new Ledger(), confirm: DENY, maxNodes: 2 }));
    expect(ret.aborted).toBe(true);
    expect(steps.some((s) => s.type === 'error' && s.error.includes('预算'))).toBe(true);
  });

  it('高危 invoke 默认拒绝 → cancelled，程序继续，outcome=cancelled', async () => {
    const host = new FakeHostAdapter(makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`));
    const ledger = new Ledger();
    const program: Program = { body: [{ op: 'invoke', action: 'resolve' }, { op: 'observe' }] };
    const { steps, ret } = await drain(runProgram(program, { host, ledger, confirm: DENY }));
    expect(steps.some((s) => s.type === 'held')).toBe(true);
    expect(steps.some((s) => s.type === 'cancelled')).toBe(true);
    expect(steps.some((s) => s.type === 'observation')).toBe(true); // 拒绝不中止，后续继续
    expect(ret.aborted).toBe(false);
    expect(computeOutcome(ledger.entries)).toBe('cancelled');
  });

  it('高危 invoke approve(once) 且验证到变化 → 不中止，outcome=completed', async () => {
    const before = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    const after = makeSnap(`<section data-agent-surface="ok">已解决</section>`, '/done');
    const host = new FakeHostAdapter(before, { 'action:resolve': after });
    const ledger = new Ledger();
    const program: Program = { body: [{ op: 'invoke', action: 'resolve' }, { op: 'finish', answer: 'ok' }] };
    const { steps, ret } = await drain(runProgram(program, { host, ledger, confirm: APPROVE_ONCE }));
    expect(steps.some((s) => s.type === 'held')).toBe(true);
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
    expect(ret.aborted).toBe(false);
    expect(computeOutcome(ledger.entries)).toBe('completed');
  });

  it('作用域授权 all：一次确认，批量高危不再追问', async () => {
    const base = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`, '/b');
    let n = 0;
    let cur: PageSnapshot = base;
    const host: HostAdapter = {
      snapshot: () => cur,
      readSurface: (ref) => cur.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '',
      openObject: () => Promise.resolve({ ok: true, snapshot: cur }),
      navigate: () => Promise.resolve({ ok: true, snapshot: cur }),
      setControl: () => Promise.resolve({ ok: true, snapshot: cur }),
      invokeAction: () => {
        n += 1;
        cur = { ...base, url: `${base.url}#${n}` }; // url 变 → verify 通过；动作仍在
        return Promise.resolve({ ok: true, snapshot: cur });
      },
    };
    let calls = 0;
    const confirm: ConfirmFn = () => {
      calls += 1;
      return Promise.resolve({ approved: true, scope: 'all' });
    };
    const program: Program = {
      body: [
        { op: 'invoke', action: 'resolve' },
        { op: 'invoke', action: 'resolve' },
        { op: 'finish', answer: 'all done' },
      ],
    };
    const { ret } = await drain(runProgram(program, { host, ledger: new Ledger(), confirm }));
    expect(n).toBe(2); // 两个 invoke 都执行
    expect(calls).toBe(1); // 只问了一次
    expect(ret.aborted).toBe(false);
  });

  it('写未验证（无可观察变化）→ 中止', async () => {
    const host = new FakeHostAdapter(makeSnap(`<button data-agent-action="ping">P</button>`)); // 低危、无 transition
    const ledger = new Ledger();
    const program: Program = { body: [{ op: 'invoke', action: 'ping' }, { op: 'observe' }] };
    const { steps, ret } = await drain(runProgram(program, { host, ledger, confirm: DENY }));
    expect(steps.some((s) => s.type === 'action' && !s.verified)).toBe(true);
    expect(steps.some((s) => s.type === 'observation')).toBe(false); // 未验证→中止，observe 未跑
    expect(ret.aborted).toBe(true);
    expect(computeOutcome(ledger.entries)).toBe('failed');
  });
});
