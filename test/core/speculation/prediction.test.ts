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

describe('matchesPrediction 对象实例宽容（实例 id 页面指派、预测时不可知）', () => {
  it('object appeared 预测带实例 id，实际出现同型不同 id → 命中', () => {
    const actual = ev(true, ['object appeared: object:record:2']);
    expect(matchesPrediction(actual, { expectDetails: ['object appeared: object:record:1'] })).toBe(true);
  });

  it('object gone 同理跨实例命中', () => {
    const actual = ev(true, ['object gone: object:task:9']);
    expect(matchesPrediction(actual, { expectDetails: ['object gone: object:task:3'] })).toBe(true);
  });

  it('对象类型不同 → 仍不命中（宽容只到实例，不到类型）', () => {
    const actual = ev(true, ['object appeared: object:record:2']);
    expect(matchesPrediction(actual, { expectDetails: ['object appeared: object:task:1'] })).toBe(false);
  });

  it('appeared/gone 方向不同 → 不命中', () => {
    const actual = ev(true, ['object gone: object:record:2']);
    expect(matchesPrediction(actual, { expectDetails: ['object appeared: object:record:1'] })).toBe(false);
  });

  it('control 值预测保持严格（值是模型自己选的、可预测）：0→5 预测遇 0→9 → 不命中', () => {
    const actual = ev(true, ['control control:qty: 0 → 9']);
    expect(matchesPrediction(actual, { expectDetails: ['control control:qty: 0 → 5'] })).toBe(false);
  });
});
