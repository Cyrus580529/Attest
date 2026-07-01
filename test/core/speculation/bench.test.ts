import { describe, it, expect } from 'vitest';
import { parseContract } from '../../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../../src/testing/fakeHostAdapter';
import { PageMemory } from '../../../src/memory/pageMemory';
import { WorldModel } from '../../../src/memory/worldModel';

function board() {
  document.body.innerHTML = `<input data-agent-control="c" value="0"/>`;
  return parseContract(document.body, '/p');
}
function board5() {
  document.body.innerHTML = `<input data-agent-control="c" value="5"/>`;
  return parseContract(document.body, '/p');
}
async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}

// A/B 净收益生死线：冷跑建记忆后，N 次热跑应几乎不问 LLM（命中投机零-LLM）。
describe('投机执行 A/B 净收益', () => {
  it('冷跑用 LLM；热跑 N 次命中投机 → 每任务 LLM 调用降到 0', async () => {
    const memory = new PageMemory();
    const wm = new WorldModel();

    const cold = new FakeLlmAdapter([
      toolCallTurn('setControl', { ref: 'control:c', value: '5' }),
      toolCallTurn('finish', { answer: 'ok' }),
    ]);
    await collect(
      createAgent({ llm: cold, host: new FakeHostAdapter(board(), { 'control:c': board5() }), memory, worldModel: wm }).run(
        '设置c',
      ),
    );
    const coldCalls = cold.calls.length;

    const N = 10;
    let hotCalls = 0;
    for (let i = 0; i < N; i++) {
      const hot = new FakeLlmAdapter([toolCallTurn('finish', { answer: 'fallback' })]);
      const steps = await collect(
        createAgent({ llm: hot, host: new FakeHostAdapter(board(), { 'control:c': board5() }), memory, worldModel: wm }).run(
          '设置c',
        ),
      );
      hotCalls += hot.calls.length;
      expect(steps.some((s) => s.type === 'speculate' && s.hit)).toBe(true);
      expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
    }

    expect(coldCalls).toBeGreaterThan(0);
    expect(hotCalls).toBe(0); // 净收益：热跑全靠投机，零往返
  });
});
