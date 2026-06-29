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
