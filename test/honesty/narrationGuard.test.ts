import { describe, it, expect } from 'vitest';
import { applyClaim } from '../../src/honesty/narrationGuard';

// 自评降级通道：diff 只证明"有效果"，不证明"业务成功"。账本是声明上限，自述只能更保守。
describe('applyClaim', () => {
  it('goalMet:false 把 completed 降级为 failed', () => {
    expect(applyClaim('completed', { goalMet: false })).toBe('failed');
  });

  it('goalMet:true 不能把 failed 升级回 completed（只降不升）', () => {
    expect(applyClaim('failed', { goalMet: true })).toBe('failed');
  });

  it('cancelled/partial 不被覆盖（已是更精确的原因）', () => {
    expect(applyClaim('cancelled', { goalMet: false })).toBe('cancelled');
    expect(applyClaim('partial', { goalMet: false })).toBe('partial');
  });

  it('无自评时原样返回', () => {
    expect(applyClaim('completed')).toBe('completed');
    expect(applyClaim('failed')).toBe('failed');
  });
});
