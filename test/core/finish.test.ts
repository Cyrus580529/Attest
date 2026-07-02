import { describe, it, expect } from 'vitest';
import { buildFacts, finishStep, programFinish } from '../../src/core/finish';
import { Ledger } from '../../src/honesty/ledger';
import type { LedgerEntry } from '../../src/honesty/types';

const W = (refId: string, verified = true, evidence: string[] = ['x changed']): LedgerEntry => ({
  kind: 'write',
  tool: 'invokeAction',
  refId,
  verified,
  evidence: verified ? evidence : [],
});

describe('buildFacts——事实由账本硬生成', () => {
  it('验证写进 verified 明细，summary 报计数', () => {
    const f = buildFacts([W('action:a'), W('action:b')], 'completed');
    expect(f.outcome).toBe('completed');
    expect(f.verified).toEqual([
      { tool: 'invokeAction', refId: 'action:a', evidence: ['x changed'] },
      { tool: 'invokeAction', refId: 'action:b', evidence: ['x changed'] },
    ]);
    expect(f.summary).toContain('成功执行并验证 2 个动作');
  });

  it('被拒高危配对 intent 取 label，summary 含"未获确认"', () => {
    const f = buildFacts(
      [
        { kind: 'intent', refId: 'action:wipe', label: '清空全部（高风险）', expectedEvidence: [] },
        { kind: 'grant', refId: 'action:wipe', approved: false },
      ],
      'cancelled',
    );
    expect(f.cancelled).toEqual([{ refId: 'action:wipe', label: '清空全部（高风险）' }]);
    expect(f.summary).toContain('未获确认');
  });

  it('未验证写进 unverified，summary 含"未能确认"', () => {
    const f = buildFacts([W('action:a', false)], 'failed');
    expect(f.unverified).toEqual([{ tool: 'invokeAction', refId: 'action:a' }]);
    expect(f.summary).toContain('未能确认');
  });

  it('写工具 error 进 writeErrors，读 error 不进', () => {
    const f = buildFacts(
      [
        { kind: 'error', tool: 'invokeAction', detail: 'ref 失效' },
        { kind: 'error', tool: 'readSurface', detail: '读失败' },
      ],
      'failed',
    );
    expect(f.writeErrors).toEqual([{ tool: 'invokeAction', detail: 'ref 失效' }]);
  });

  it('空账本 → summary 警示"没有执行任何动作"', () => {
    const f = buildFacts([], 'completed');
    expect(f.summary).toContain('没有执行任何动作');
  });
});

describe('finishStep——narration 归模型、facts 归账本、answer 拼接', () => {
  it('narration 一字不改，answer = narration + 执行记录', () => {
    const ledger = new Ledger();
    ledger.record(W('action:a'));
    const s = finishStep('已帮你处理好了', ledger);
    expect(s.type).toBe('finish');
    if (s.type !== 'finish') return;
    expect(s.narration).toBe('已帮你处理好了');
    expect(s.facts.verified).toHaveLength(1);
    expect(s.answer).toContain('已帮你处理好了');
    expect(s.answer).toContain('成功执行并验证 1 个动作');
    expect(s.outcome).toBe('completed');
  });

  it('goalMet:false 仍降级 completed→failed，facts.outcome 同步', () => {
    const ledger = new Ledger();
    ledger.record(W('action:a'));
    const s = finishStep('页面提示余额不足', ledger, { goalMet: false });
    if (s.type !== 'finish') return;
    expect(s.outcome).toBe('failed');
    expect(s.facts.outcome).toBe('failed');
  });
});

describe('programFinish——同一 facts 骨架', () => {
  it('finish step 带 facts 与 narration，partial 规则不变', () => {
    const ledger = new Ledger();
    ledger.record(W('action:a'));
    ledger.record({ kind: 'intent', refId: 'action:b', label: 'b', expectedEvidence: [] });
    ledger.record({ kind: 'grant', refId: 'action:b', approved: false });
    const s = programFinish(ledger, '处理了一部分');
    if (s.type !== 'finish') return;
    expect(s.outcome).toBe('partial');
    expect(s.narration).toBe('处理了一部分');
    expect(s.facts.verified).toHaveLength(1);
    expect(s.facts.cancelled).toHaveLength(1);
    expect(s.answer).toContain('未获确认');
  });
});
