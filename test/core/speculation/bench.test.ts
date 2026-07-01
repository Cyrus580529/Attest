import { describe, it, expect } from 'vitest';
import { parseContract } from '../../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../../src/testing/fakeHostAdapter';
import type { LlmTurn } from '../../../src/llm/types';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}
async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}
function batchTurn(calls: { name: string; arguments: Record<string, unknown> }[]): LlmTurn {
  return { content: '', toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, arguments: c.arguments })) };
}

const c0 = () => build(`<input data-agent-control="a" value="0"/><input data-agent-control="b" value="0"/>`);
const cA = () => build(`<input data-agent-control="a" value="1"/><input data-agent-control="b" value="0"/>`);
const cB = () => build(`<input data-agent-control="a" value="1"/><input data-agent-control="b" value="1"/>`);

// A/B 净收益：同一多步任务，反应式（一步一回合）vs lookahead（一回合批量+predict）。
// LLM 主导不变（两者都由模型 authored），效率来自"一次想更远"——lookahead 回合数应更少。
describe('lookahead A/B 净收益（LLM 始终主导）', () => {
  it('反应式：两步两回合 → LLM 调用=3（含收尾）', async () => {
    const host = new FakeHostAdapter(c0(), { 'control:a': cA(), 'control:b': cB() });
    const llm = new FakeLlmAdapter([
      toolCallTurn('setControl', { ref: 'control:a', value: '1' }),
      toolCallTurn('setControl', { ref: 'control:b', value: '1' }),
      toolCallTurn('finish', { answer: 'done' }),
    ]);
    await collect(createAgent({ llm, host }).run('把 a、b 都设为1'));
    expect(llm.calls.length).toBe(3);
  });

  it('lookahead：一回合批量+predict → LLM 调用=1，且全命中', async () => {
    const host = new FakeHostAdapter(c0(), { 'control:a': cA(), 'control:b': cB() });
    const llm = new FakeLlmAdapter([
      batchTurn([
        { name: 'setControl', arguments: { ref: 'control:a', value: '1', predict: ['control:a: 0 → 1'] } },
        { name: 'setControl', arguments: { ref: 'control:b', value: '1', predict: ['control:b: 0 → 1'] } },
        { name: 'finish', arguments: { answer: 'done' } },
      ]),
    ]);
    const steps = await collect(createAgent({ llm, host }).run('把 a、b 都设为1'));
    expect(llm.calls.length).toBe(1); // 一回合搞定：3 回合 → 1 回合
    expect(steps.filter((s) => s.type === 'speculate' && s.hit).length).toBe(2);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });
});
