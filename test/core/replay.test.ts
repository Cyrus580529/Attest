import { describe, it, expect } from 'vitest';
import { replayOutcome } from '../../src/core/replay';
import type { TraceEvent } from '../../src/core/trace';
import type { LedgerEntry } from '../../src/honesty/types';

function finishTrace(ledger: LedgerEntry[], recordedOutcome: 'completed' | 'failed'): TraceEvent[] {
  return [
    {
      seq: 0,
      ts: 't0',
      step: {
        type: 'finish',
        facts: {
          outcome: recordedOutcome,
          verified: [],
          unverified: [],
          cancelled: [],
          writeErrors: [],
          clarifications: [],
          summary: 'x',
        },
        narration: 'x',
        answer: 'x',
        outcome: recordedOutcome,
        ledger,
      },
    },
  ];
}

describe('replayOutcome', () => {
  it('账本重跑 computeOutcome 和录制时的 outcome 一致 → matches:true', () => {
    const ledger: LedgerEntry[] = [
      { kind: 'write', tool: 'invokeAction', refId: 'action:delete', verified: true, evidence: ['object:lead:5 gone'] },
    ];
    const result = replayOutcome(finishTrace(ledger, 'completed'));
    expect(result).toEqual({ recordedOutcome: 'completed', replayedOutcome: 'completed', matches: true });
  });

  it('账本重跑后的 outcome 和录制时不一致（模拟代码改动后判定变了）→ matches:false', () => {
    // 模拟：录制时账本里全是导航类写，当时的旧代码判 completed；
    // 现在的 computeOutcome（已加 navLike 规则）重跑会判 failed。
    const ledger: LedgerEntry[] = [
      { kind: 'write', tool: 'invokeAction', refId: 'action:accounts', verified: true, evidence: ['url: a → b'], navLike: true },
    ];
    const result = replayOutcome(finishTrace(ledger, 'completed'));
    expect(result).toEqual({ recordedOutcome: 'completed', replayedOutcome: 'failed', matches: false });
  });

  it('trace 里没有 finish 事件（任务半路截断）→ 两边都是 null，matches:true（没什么可比的）', () => {
    const trace: TraceEvent[] = [
      { seq: 0, ts: 't0', step: { type: 'observation', tool: 'observePage', result: 'x' } },
    ];
    expect(replayOutcome(trace)).toEqual({ recordedOutcome: null, replayedOutcome: null, matches: true });
  });
});
