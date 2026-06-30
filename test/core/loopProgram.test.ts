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

describe('loop code-as-action (codeAsAction)', () => {
  it('act 工具集只有 runProgram + finish，且播种了初始快照', async () => {
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: 'hi' })]);
    const host = new FakeHostAdapter(build(`<input data-agent-control="amount" value="0" />`));
    await collect(createAgent({ llm, host, codeAsAction: true }).run('看看'));
    expect(llm.calls[0]?.tools.map((t) => t.name).sort()).toEqual(['finish', 'runProgram']);
    const seeded = llm.calls[0]?.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('control:amount'),
    );
    expect(seeded).toBe(true);
  });

  it('程序里 setControl → 验证变化 → completed', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const after = build(`<input data-agent-control="amount" value="300" />`, '/p');
    const program = {
      body: [
        { op: 'setControl', on: { control: 'amount' }, value: '300' },
        { op: 'finish', answer: '已填 300' },
      ],
    };
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program })]);
    const host = new FakeHostAdapter(before, { 'control:amount': after });
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('填300'));
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('程序里高危 invoke + 默认拒绝 → held → cancelled', async () => {
    const before = build(`<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`, '/shop');
    const after = build(`<section data-agent-surface="ok">兑换成功</section>`, '/done');
    const program = { body: [{ op: 'invoke', action: 'redeem' }, { op: 'finish', answer: '已兑换' }] };
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program })]);
    const host = new FakeHostAdapter(before, { 'action:redeem': after });
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('兑换'));
    expect(steps.some((s) => s.type === 'held')).toBe(true);
    expect(steps.some((s) => s.type === 'cancelled')).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'cancelled' });
  });

  it('程序里高危 invoke + 批准 → completed', async () => {
    const before = build(`<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`, '/shop');
    const after = build(`<section data-agent-surface="ok">兑换成功</section>`, '/done');
    const program = { body: [{ op: 'invoke', action: 'redeem' }, { op: 'finish', answer: '已兑换' }] };
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program })]);
    const host = new FakeHostAdapter(before, { 'action:redeem': after });
    const steps = await collect(
      createAgent({ llm, host, codeAsAction: true, confirm: async () => ({ approved: true }) }).run('兑换'),
    );
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('真实失败模式：直接 finish 编造动作成功（空账本）→ 必须加注未执行任何动作，不替模型背书', async () => {
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: '已全部标记为已解决' })]);
    const host = new FakeHostAdapter(build(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`));
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('把工单全部标记为已解决'));
    const finish = steps.at(-1);
    expect(finish?.type === 'finish' && finish.answer).toContain('未执行任何动作');
  });

  it('真正经程序执行的写不被误加注', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const after = build(`<input data-agent-control="amount" value="9" />`, '/p');
    const program = { body: [{ op: 'setControl', on: { control: 'amount' }, value: '9' }, { op: 'finish', answer: '已填 9' }] };
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program })]);
    const host = new FakeHostAdapter(before, { 'control:amount': after });
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('填9'));
    const finish = steps.at(-1);
    expect(finish?.type === 'finish' && finish.answer).not.toContain('未执行任何动作');
    expect(finish).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('非法程序 → 错误回灌，模型可退而 finish', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('runProgram', { program: { body: [{ op: 'teleport' }] } }),
      toolCallTurn('finish', { answer: '换个方式' }),
    ]);
    const host = new FakeHostAdapter(build(`<div data-agent-object="x:1">A</div>`));
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('go'));
    expect(steps.some((s) => s.type === 'error')).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish' });
  });
});
