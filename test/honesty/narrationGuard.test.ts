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
