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

  it('写动作未验证且其后无验证写（未恢复）→ failed', () => {
    expect(
      computeOutcome([{ kind: 'write', tool: 'invokeAction', refId: 'a', verified: false, evidence: [] }]),
    ).toBe('failed');
  });

  it('未验证写后有验证成功的写（已恢复，与 error 恢复规则同形）→ completed', () => {
    // 场景：模型点了本就激活的 tab（无变化=正确地未验证），随后的关键写全部验证——
    // 一次无效果的探索性点击不应把整个任务拍成 failed。
    expect(
      computeOutcome([
        { kind: 'write', tool: 'invokeAction', refId: 'tab', verified: false, evidence: [] },
        { kind: 'write', tool: 'invokeAction', refId: 'save', verified: true, evidence: ['c'] },
      ]),
    ).toBe('completed');
  });

  it('验证写在前、未验证写收尾（终态不明）→ failed', () => {
    expect(
      computeOutcome([
        { kind: 'write', tool: 'invokeAction', refId: 'save', verified: true, evidence: ['c'] },
        { kind: 'write', tool: 'invokeAction', refId: 'tab', verified: false, evidence: [] },
      ]),
    ).toBe('failed');
  });

  it('写工具 error（host 崩溃/TOCTOU 拒绝）且其后无验证写 → failed，不得 completed', () => {
    expect(
      computeOutcome([{ kind: 'error', tool: 'invokeAction', detail: 'host 执行失败' }]),
    ).toBe('failed');
  });

  it('写工具 error 后有验证成功的写（已恢复）→ completed', () => {
    expect(
      computeOutcome([
        { kind: 'error', tool: 'invokeAction', detail: 'ref 未命中' },
        { kind: 'write', tool: 'invokeAction', refId: 'a', verified: true, evidence: ['c'] },
      ]),
    ).toBe('completed');
  });

  it('读工具 error 不拖垮 outcome（模型可改道）→ completed', () => {
    expect(
      computeOutcome([
        { kind: 'error', tool: 'openObject', detail: '读取失败' },
        { kind: 'observe', tool: 'readSurface', detail: 'x' },
      ]),
    ).toBe('completed');
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
