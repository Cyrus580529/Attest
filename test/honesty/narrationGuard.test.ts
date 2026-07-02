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

  // 自评降级通道：diff 只证明"有效果"，不证明"业务成功"。模型读到页面上的业务失败
  // （如"余额不足"）时可申报 goalMet:false——账本是声明上限，自述只能更保守。
  it('goalMet:false + 写已验证 → 降级为 failed，答案原样（模型已如实叙述）', () => {
    const r = guardFinish(
      '提交后页面显示"余额不足，操作失败"',
      [{ kind: 'write', tool: 'invokeAction', refId: 'a', verified: true, evidence: ['surface err changed'] }],
      { goalMet: false },
    );
    expect(r).toEqual({ answer: '提交后页面显示"余额不足，操作失败"', outcome: 'failed' });
  });

  it('goalMet:true 不能把 failed 升级回 completed（只降不升）', () => {
    const r = guardFinish(
      '已提交',
      [{ kind: 'write', tool: 'invokeAction', refId: 'a', verified: false, evidence: [] }],
      { goalMet: true },
    );
    expect(r.outcome).toBe('failed');
    expect(r.answer).toContain('未能确认');
  });

  it('goalMet:false 不覆盖 cancelled（拒绝是更精确的原因）', () => {
    const r = guardFinish(
      '未执行',
      [
        { kind: 'intent', refId: 'a', label: 'x', expectedEvidence: [] },
        { kind: 'grant', refId: 'a', approved: false },
      ],
      { goalMet: false },
    );
    expect(r.outcome).toBe('cancelled');
  });
});
