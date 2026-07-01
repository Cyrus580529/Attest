import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import type { LlmTurn } from '../../src/llm/types';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}
async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}
/** 一个回合内多工具调用（lookahead 批次）。 */
function batchTurn(calls: { name: string; arguments: Record<string, unknown> }[]): LlmTurn {
  return { content: '', toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, arguments: c.arguments })) };
}

const c0 = () => build(`<input data-agent-control="c" value="0"/>`);
const c5 = () => build(`<input data-agent-control="c" value="5"/>`);
const c9 = () => build(`<input data-agent-control="c" value="9"/>`);

describe('读循环 lookahead（模型一回合提多步+预测，投机执行）', () => {
  it('批次预测全命中 → 一次 LLM 回合内连续执行完，speculate hit，completed', async () => {
    const host = new FakeHostAdapter(c0(), { 'control:c': c5() });
    const llm = new FakeLlmAdapter([
      batchTurn([
        { name: 'setControl', arguments: { ref: 'control:c', value: '5', predict: ['control:c: 0 → 5'] } },
        { name: 'finish', arguments: { answer: '已设为5' } },
      ]),
    ]);
    const steps = await collect(createAgent({ llm, host }).run('把c设为5'));
    expect(steps.some((s) => s.type === 'speculate' && s.hit)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
    expect(llm.calls).toHaveLength(1); // 一个回合搞定
  });

  it('批次中某步预测落空 → 中断本轮，剩余批次不执行，回模型重规划', async () => {
    // setControl 实际 0→9，与 predict 0→5 不符；批次里其后的 invokeAction 不应被执行
    const host = new FakeHostAdapter(c0(), { 'control:c': c9() });
    const llm = new FakeLlmAdapter([
      batchTurn([
        { name: 'setControl', arguments: { ref: 'control:c', value: '5', predict: ['control:c: 0 → 5'] } },
        { name: 'invokeAction', arguments: { ref: 'action:save' } },
        { name: 'finish', arguments: { answer: '不该到这' } },
      ]),
      // 第二回合：模型看到真实结果后收尾
      batchTurn([{ name: 'finish', arguments: { answer: '重规划后作答' } }]),
    ]);
    const steps = await collect(createAgent({ llm, host }).run('把c设为5'));
    expect(steps.some((s) => s.type === 'mispredict')).toBe(true);
    expect(host.log.some((l) => l.kind === 'invoke')).toBe(false); // 落空后未继续执行 invoke
    expect(llm.calls.length).toBe(2); // 回到模型重规划
    expect(steps.at(-1)).toMatchObject({ type: 'finish' });
  });
});
