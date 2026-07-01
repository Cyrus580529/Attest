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
