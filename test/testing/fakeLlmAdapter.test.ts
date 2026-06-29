import { describe, it, expect } from 'vitest';
import { FakeLlmAdapter, toolCallTurn, textTurn } from '../../src/testing/fakeLlmAdapter';

describe('FakeLlmAdapter', () => {
  it('按脚本顺序返回 turn 并记录调用', async () => {
    const fake = new FakeLlmAdapter([toolCallTurn('observePage', {}), textTurn('done')]);
    const t1 = await fake.step([{ role: 'user', content: 'hi' }], []);
    const t2 = await fake.step([], []);

    expect(t1.toolCalls[0]?.name).toBe('observePage');
    expect(t2.content).toBe('done');
    expect(fake.calls).toHaveLength(2);
  });

  it('脚本用尽返回空 turn', async () => {
    const fake = new FakeLlmAdapter([]);
    const t = await fake.step([], []);
    expect(t).toEqual({ content: '', toolCalls: [] });
  });
});
