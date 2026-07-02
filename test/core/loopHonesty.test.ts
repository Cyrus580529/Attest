import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

async function collect(gen: AsyncGenerator<AgentStep>): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for await (const s of gen) steps.push(s);
  return steps;
}

describe('loop honesty', () => {
  it('低危写 setControl：执行并验证可观察变化', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const after = build(`<input data-agent-control="amount" value="300" />`, '/p');
    const llm = new FakeLlmAdapter([
      toolCallTurn('setControl', { ref: 'control:amount', value: '300' }),
      toolCallTurn('finish', { answer: '已填写金额 300' }),
    ]);
    const host = new FakeHostAdapter(before, { 'control:amount': after });
    const steps = await collect(createAgent({ llm, host }).run('填 300'));

    const act = steps.find((s) => s.type === 'action');
    expect(act).toMatchObject({ type: 'action', tool: 'setControl', verified: true });
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('高危 invokeAction + 批准：held → 执行 → completed', async () => {
    const before = build(`<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`, '/shop');
    const after = build(`<section data-agent-surface="ok">兑换成功</section>`, '/done');
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:redeem' }),
      toolCallTurn('finish', { answer: '已为你兑换' }),
    ]);
    const host = new FakeHostAdapter(before, { 'action:redeem': after });
    const steps = await collect(
      createAgent({ llm, host, confirm: async () => ({ approved: true }) }).run('兑换'),
    );

    expect(steps.some((s) => s.type === 'held')).toBe(true);
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('高危 invokeAction + 拒绝（默认）：held → cancelled，不执行，outcome=cancelled', async () => {
    const before = build(`<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`, '/shop');
    const after = build(`<section data-agent-surface="ok">不该发生</section>`, '/done');
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:redeem' }),
      toolCallTurn('finish', { answer: '已为你兑换' }),
    ]);
    const host = new FakeHostAdapter(before, { 'action:redeem': after });
    const steps = await collect(createAgent({ llm, host }).run('兑换'));

    expect(steps.some((s) => s.type === 'held')).toBe(true);
    expect(steps.some((s) => s.type === 'cancelled')).toBe(true);
    expect(steps.some((s) => s.type === 'action')).toBe(false);
    expect(host.log).toEqual([]);
    const finish = steps.at(-1);
    expect(finish).toMatchObject({ type: 'finish', outcome: 'cancelled' });
    expect(finish?.type === 'finish' && finish.answer).toContain('未获确认');
  });

  it('写后页面无变化：verified=false → outcome=failed 且加注', async () => {
    const same = build(`<button data-agent-action="apply">申请</button>`, '/p');
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:apply' }),
      toolCallTurn('finish', { answer: '已提交申请' }),
    ]);
    const host = new FakeHostAdapter(same);
    const steps = await collect(createAgent({ llm, host }).run('申请'));

    expect(steps.some((s) => s.type === 'action' && !s.verified)).toBe(true);
    const finish = steps.at(-1);
    expect(finish).toMatchObject({ type: 'finish', outcome: 'failed' });
    expect(finish?.type === 'finish' && finish.answer).toContain('未能确认');
  });

  it('写已验证但页面显示业务失败：finish 报 goalMet:false → outcome=failed', async () => {
    const before = build(`<button data-agent-action="transfer">转账</button><section data-agent-surface="msg">就绪</section>`);
    const after = build(`<button data-agent-action="transfer">转账</button><section data-agent-surface="msg">余额不足，转账失败</section>`);
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:transfer' }),
      toolCallTurn('finish', { answer: '页面提示余额不足，转账没有成功', goalMet: false }),
    ]);
    const host = new FakeHostAdapter(before, { 'action:transfer': after });
    const steps = await collect(createAgent({ llm, host }).run('转账'));

    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'failed' });
  });

  it('finish 携带 ledger 票根', async () => {
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: 'hi' })]);
    const host = new FakeHostAdapter(build(`<div data-agent-object="task:1">A</div>`));
    const steps = await collect(createAgent({ llm, host }).run('hi'));
    const finish = steps.at(-1);
    expect(finish?.type === 'finish' && Array.isArray(finish.ledger)).toBe(true);
  });
});
