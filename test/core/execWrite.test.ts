import { describe, it, expect, beforeEach } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import { Ledger } from '../../src/honesty/ledger';
import { executeWrite } from '../../src/core/execWrite';
import { inferContract } from '../../src/contract/inferContract';
import type { ConfirmFn } from '../../src/honesty/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

function makeSnap(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

const APPROVE_ONCE: ConfirmFn = () => Promise.resolve({ approved: true, scope: 'once' });
const DENY: ConfirmFn = () => Promise.resolve({ approved: false });

describe('executeWrite', () => {
  it('低危 setControl 检测到变化 → verified', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const after = makeSnap(`<input data-agent-control="qty" value="5"/>`);
    const host = new FakeHostAdapter(before, { 'control:qty': after });
    const ledger = new Ledger();
    const r = await executeWrite(host, ledger, DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '5',
    });
    expect(r.verified).toBe(true);
    expect(ledger.entries.some((e) => e.kind === 'write' && e.verified)).toBe(true);
  });

  it('写后无可观察变化 → verified false', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const host = new FakeHostAdapter(before); // 无 transition → 快照不变
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '0',
    });
    expect(r.verified).toBe(false);
  });

  it('高危 invoke 默认拒绝 → cancelled，无 write 记账', async () => {
    const before = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    const host = new FakeHostAdapter(before);
    const ledger = new Ledger();
    const r = await executeWrite(host, ledger, DENY, new Set(), {
      tool: 'invokeAction',
      refId: 'action:resolve',
    });
    expect(r.verified).toBe(false);
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.steps.some((s) => s.type === 'cancelled')).toBe(true);
    expect(ledger.entries.some((e) => e.kind === 'grant' && !e.approved)).toBe(true);
    expect(ledger.entries.some((e) => e.kind === 'write')).toBe(false);
  });

  it('高危 invoke approve(once) → 执行并验证', async () => {
    const before = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    const after = makeSnap(`<section data-agent-surface="ok">已解决</section>`, '/done');
    const host = new FakeHostAdapter(before, { 'action:resolve': after });
    const r = await executeWrite(host, new Ledger(), APPROVE_ONCE, new Set(), {
      tool: 'invokeAction',
      refId: 'action:resolve',
    });
    expect(r.verified).toBe(true);
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
  });

  it('作用域授权 all：首次问、入集，同名第二次不再问', async () => {
    const before = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    const host = new FakeHostAdapter(before); // 快照稳定，动作持续可解析
    const scopes = new Set<string>();
    let calls = 0;
    const confirm: ConfirmFn = () => {
      calls++;
      return Promise.resolve({ approved: true, scope: 'all' });
    };
    await executeWrite(host, new Ledger(), confirm, scopes, { tool: 'invokeAction', refId: 'action:resolve' });
    expect(scopes.has('resolve')).toBe(true);
    await executeWrite(host, new Ledger(), confirm, scopes, { tool: 'invokeAction', refId: 'action:resolve' });
    expect(calls).toBe(1); // 第二次未再调 confirm
  });

  it('来源感知：inferred 控件 setControl → held（即便非高危）', async () => {
    document.body.innerHTML = `<label for="q">数量</label><input id="q" value="0"/>`;
    const before = inferContract(document.body, '/p').snapshot;
    const host = new FakeHostAdapter(before); // 无 transition；DENY 会先 held 再取消
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:数量',
      value: '5',
    });
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.steps.some((s) => s.type === 'cancelled')).toBe(true);
    expect(r.verified).toBe(false);
  });

  it('来源感知：inferred 低危 invoke（如"保存"）→ 也 held', async () => {
    document.body.innerHTML = `<button>保存</button>`;
    const before = inferContract(document.body, '/p').snapshot;
    const host = new FakeHostAdapter(before);
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'invokeAction',
      refId: 'action:保存',
    });
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.steps.some((s) => s.type === 'cancelled')).toBe(true);
  });

  it('来源感知：inferred 写 approve → 正常执行验证', async () => {
    document.body.innerHTML = `<label for="q">数量</label><input id="q" value="0"/>`;
    const before = inferContract(document.body, '/p').snapshot;
    document.body.innerHTML = `<label for="q">数量</label><input id="q" value="5"/>`;
    const after = inferContract(document.body, '/p').snapshot;
    const host = new FakeHostAdapter(before, { 'control:数量': after });
    const r = await executeWrite(host, new Ledger(), APPROVE_ONCE, new Set(), {
      tool: 'setControl',
      refId: 'control:数量',
      value: '5',
    });
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('authored 低危 setControl → 不 held（来源感知不误伤声明契约）', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const host = new FakeHostAdapter(before);
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '5',
    });
    expect(r.steps.some((s) => s.type === 'held')).toBe(false);
  });

  it('ref 未命中 → error step，不执行', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const host = new FakeHostAdapter(before);
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:nope',
      value: '5',
    });
    expect(r.steps[0]?.type).toBe('error');
    expect(r.verified).toBe(false);
  });

  it('WriteResult 回传本次验证的 evidence（供记忆/世界模型录制为预测）', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const after = makeSnap(`<input data-agent-control="qty" value="5"/>`);
    const host = new FakeHostAdapter(before, { 'control:qty': after });
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '5',
    });
    expect(r.verified).toBe(true);
    expect(r.evidence).toBeDefined();
    expect(r.evidence!.some((d) => d.includes('control:qty'))).toBe(true);
  });
});
