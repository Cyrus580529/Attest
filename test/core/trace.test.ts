import { describe, it, expect } from 'vitest';
import { serializeTrace } from '../../src/core/trace';
import type { AgentStep } from '../../src/core/loopTypes';

describe('serializeTrace', () => {
  it('给每个 step 加序号和时间戳，顺序不变，finish 事件（含 facts）也照常序列化', () => {
    const steps: AgentStep[] = [
      { type: 'observation', tool: 'observePage', result: 'x' },
      { type: 'action', tool: 'invokeAction', refId: 'action:a', verified: true, evidence: ['c'] },
      {
        type: 'finish',
        facts: {
          outcome: 'completed',
          verified: [],
          unverified: [],
          cancelled: [],
          writeErrors: [],
          clarifications: [],
          summary: '仅读取了页面，未执行写操作',
        },
        narration: 'done',
        answer: 'done',
        outcome: 'completed',
        ledger: [],
      },
    ];
    let calls = 0;
    const now = () => `t${calls++}`;
    const trace = serializeTrace(steps, now);
    expect(trace).toHaveLength(3);
    expect(trace.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(trace.map((t) => t.ts)).toEqual(['t0', 't1', 't2']);
    expect(trace[2]!.step.type).toBe('finish');
  });

  it('args 字段随 action step 一起序列化（execWrite 传入的调用参数）', () => {
    const steps: AgentStep[] = [
      { type: 'action', tool: 'setControl', refId: 'control:name', verified: true, evidence: ['c'], args: { value: '张三' } },
    ];
    const trace = serializeTrace(steps, () => 't');
    const step = trace[0]!.step as { args?: unknown };
    expect(step.args).toEqual({ value: '张三' });
  });

  it('不传 now 时用真实系统时间（默认参数可用，不炸）', () => {
    const steps: AgentStep[] = [{ type: 'observation', tool: 'observePage', result: 'x' }];
    const trace = serializeTrace(steps);
    expect(trace[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 格式
  });
});
