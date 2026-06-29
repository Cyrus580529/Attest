import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import { PageMemory } from '../../src/memory/pageMemory';
import { memoryKey } from '../../src/memory/pageSignature';

function build(html: string, url = '/board') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}
const board = () =>
  build(`<div data-agent-object="ticket:1">A</div><div data-agent-object="ticket:2">B</div>`, '/board');
const detail = () => build(`<section data-agent-surface="detail">详情</section>`, '/d');

async function collect(gen: AsyncGenerator<AgentStep>): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for await (const s of gen) steps.push(s);
  return steps;
}

describe('loop page memory', () => {
  it('首次跑后记忆里出现该 key 的轨迹', async () => {
    const memory = new PageMemory();
    const host = new FakeHostAdapter(board());
    const llm = new FakeLlmAdapter([toolCallTurn('observePage', {}), toolCallTurn('finish', { answer: '有2个工单' })]);
    const steps = await collect(createAgent({ llm, host, memory }).run('看工单'));

    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
    expect(memory.lookup(memoryKey(board(), '看工单'))).not.toBeNull();
  });

  it('第二次同 key → 零 LLM 重放完成', async () => {
    const memory = new PageMemory();
    const host1 = new FakeHostAdapter(board(), { 'object:ticket:1': detail() });
    const llm1 = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: 'object:ticket:1' }),
      toolCallTurn('finish', { answer: '看了第一个' }),
    ]);
    await collect(createAgent({ llm: llm1, host: host1, memory }).run('看第一个'));

    const host2 = new FakeHostAdapter(board(), { 'object:ticket:1': detail() });
    const emptyLlm = new FakeLlmAdapter([]);
    const steps = await collect(createAgent({ llm: emptyLlm, host: host2, memory }).run('看第一个'));

    expect(steps.some((s) => s.type === 'replay')).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
    expect(emptyLlm.calls).toHaveLength(0);
  });

  it('记忆失效（ref 解析不出）→ 回退 LLM', async () => {
    const memory = new PageMemory();
    const host1 = new FakeHostAdapter(board(), { 'object:ticket:2': detail() });
    const llm1 = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: 'object:ticket:2' }),
      toolCallTurn('finish', { answer: '看了第二个' }),
    ]);
    await collect(createAgent({ llm: llm1, host: host1, memory }).run('看第二个'));

    const host2 = new FakeHostAdapter(build(`<div data-agent-object="ticket:9">Z</div>`, '/board'));
    const llm2 = new FakeLlmAdapter([toolCallTurn('finish', { answer: '回退完成' })]);
    const steps = await collect(createAgent({ llm: llm2, host: host2, memory }).run('看第二个'));

    expect(llm2.calls.length).toBeGreaterThan(0);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('高危动作重放仍 held（默认拒绝 → 不执行）', async () => {
    const memory = new PageMemory();
    const shop = () => build(`<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`, '/shop');
    const done = () => build(`<section data-agent-surface="ok">兑换成功</section>`, '/done');
    const host1 = new FakeHostAdapter(shop(), { 'action:redeem': done() });
    const llm1 = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:redeem' }),
      toolCallTurn('finish', { answer: '已兑换' }),
    ]);
    await collect(
      createAgent({ llm: llm1, host: host1, memory, confirm: async () => ({ approved: true }) }).run('兑换'),
    );

    const host2 = new FakeHostAdapter(shop(), { 'action:redeem': done() });
    const emptyLlm = new FakeLlmAdapter([]);
    const steps = await collect(createAgent({ llm: emptyLlm, host: host2, memory }).run('兑换'));

    expect(steps.some((s) => s.type === 'held')).toBe(true);
    expect(host2.log).toEqual([]);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'cancelled' });
  });
});
