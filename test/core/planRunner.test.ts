import { describe, it, expect } from 'vitest';
import { PlanRunner } from '../../src/core/planRunner';

describe('PlanRunner', () => {
  it('追踪 visited 并计算 remaining', () => {
    const pr = new PlanRunner('看所有任务详情');
    pr.markVisited('object:task:1');
    expect(pr.hasVisited('object:task:1')).toBe(true);
    expect(pr.remaining(['object:task:1', 'object:task:2', 'object:task:3'])).toEqual([
      'object:task:2',
      'object:task:3',
    ]);
  });

  it('累积 synthesis 并汇总', () => {
    const pr = new PlanRunner('g');
    pr.addFinding('任务1：紧急');
    pr.addFinding('任务2：普通');
    expect(pr.summary()).toContain('任务1：紧急');
    expect(pr.summary()).toContain('任务2：普通');
  });

  it('全部访问后 remaining 为空', () => {
    const pr = new PlanRunner('g');
    ['a', 'b'].forEach((x) => pr.markVisited(x));
    expect(pr.remaining(['a', 'b'])).toEqual([]);
  });
});
