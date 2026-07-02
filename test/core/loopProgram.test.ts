import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import type { HostAdapter } from '../../src/host/types';
import type { ConfirmFn } from '../../src/honesty/types';
import type { PageSnapshot } from '../../src/types';

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

  it('运行程序前先发一个 plan 步（人话计划，来自程序本身）', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const after = build(`<input data-agent-control="amount" value="5" />`, '/p');
    const program = { body: [{ op: 'setControl', on: { control: 'amount' }, value: '5' }, { op: 'finish', answer: 'ok' }] };
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program })]);
    const host = new FakeHostAdapter(before, { 'control:amount': after });
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('填5'));
    const planIdx = steps.findIndex((s) => s.type === 'plan');
    const actionIdx = steps.findIndex((s) => s.type === 'action');
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeLessThan(actionIdx); // 计划在执行之前
    const plan = steps[planIdx];
    expect(plan?.type === 'plan' && plan.items).toContain('把「amount」设为 5');
  });

  it('显示思考：模型生成程序时的推理(content)作为 thinking 步呈现，在计划之前', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const after = build(`<input data-agent-control="amount" value="5" />`, '/p');
    const program = { body: [{ op: 'setControl', on: { control: 'amount' }, value: '5' }, { op: 'finish', answer: 'ok' }] };
    const llm = new FakeLlmAdapter([
      { content: '我先把金额填成 5', toolCalls: [{ id: 'c1', name: 'runProgram', arguments: { program } }] },
      toolCallTurn('finish', { answer: '已填好' }),
    ]);
    const host = new FakeHostAdapter(before, { 'control:amount': after });
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('填5'));
    const thinkIdx = steps.findIndex((s) => s.type === 'thinking');
    const planIdx = steps.findIndex((s) => s.type === 'plan');
    const think = steps[thinkIdx];
    expect(think?.type === 'thinking' && think.text).toBe('我先把金额填成 5');
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    expect(thinkIdx).toBeLessThan(planIdx); // 思考在计划之前
  });

  it('三段式：执行后有一个复盘回合，最终回答来自看到真实结果后的反思，而非程序里写死的话', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const after = build(`<input data-agent-control="amount" value="7" />`, '/p');
    const program = { body: [{ op: 'setControl', on: { control: 'amount' }, value: '7' }, { op: 'finish', answer: '程序里写死的话' }] };
    const llm = new FakeLlmAdapter([
      toolCallTurn('runProgram', { program }),
      toolCallTurn('finish', { answer: '看到结果后的准确复盘' }),
    ]);
    const host = new FakeHostAdapter(before, { 'control:amount': after });
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('填7'));
    const finish = steps.at(-1);
    expect(finish?.type === 'finish' && finish.answer).toContain('看到结果后的准确复盘');
    expect(finish?.type === 'finish' && finish.answer).not.toContain('程序里写死的话');
    expect(llm.calls[1]?.tools.map((t) => t.name)).toEqual(['finish']); // 复盘回合只能 finish
  });

  it('真实失败模式：直接 finish 编造动作成功（空账本）→ 必须加注未执行任何动作，不替模型背书', async () => {
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: '已全部标记为已解决' })]);
    const host = new FakeHostAdapter(build(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`));
    const steps = await collect(createAgent({ llm, host, codeAsAction: true }).run('把工单全部标记为已解决'));
    const finish = steps.at(-1);
    expect(finish?.type === 'finish' && finish.answer).toContain('没有执行任何动作');
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

  it('部分取消（一个批准一个拒绝）→ outcome=partial + 证据小结，不替"全部完成"背书', async () => {
    const base = build(`<button data-agent-action="resolve" data-agent-risk="high">标记为已解决</button>`, '/b');
    let n = 0;
    let cur: PageSnapshot = base;
    const host: HostAdapter = {
      snapshot: () => cur,
      readSurface: (r) => cur.surfaces.find((s) => s.ref.id === r.id)?.text ?? '',
      openObject: () => Promise.resolve({ ok: true, snapshot: cur }),
      navigate: () => Promise.resolve({ ok: true, snapshot: cur }),
      setControl: () => Promise.resolve({ ok: true, snapshot: cur }),
      invokeAction: () => {
        n += 1;
        cur = { ...base, url: `${base.url}#${n}` };
        return Promise.resolve({ ok: true, snapshot: cur });
      },
    };
    let c = 0;
    const confirm: ConfirmFn = () => Promise.resolve(c++ === 0 ? { approved: true } : { approved: false });
    const program = {
      body: [{ op: 'invoke', action: 'resolve' }, { op: 'invoke', action: 'resolve' }, { op: 'finish', answer: '已全部标记为已解决' }],
    };
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program })]);
    const steps = await collect(createAgent({ llm, host, codeAsAction: true, confirm }).run('全部解决'));
    const finish = steps.at(-1);
    expect(finish?.type === 'finish' && finish.outcome).toBe('partial');
    expect(finish?.type === 'finish' && finish.answer).toContain('未获确认');
  });

  it('渐进披露：播种对大对象集只给轮廓（省 token），不逐个塞', async () => {
    const html = Array.from({ length: 30 }, (_, i) => `<div data-agent-object="ticket:${i}">工单${i}</div>`).join('');
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: '看看' })]);
    const host = new FakeHostAdapter(build(html, '/b'));
    await collect(createAgent({ llm, host, codeAsAction: true }).run('有哪些工单'));
    const seed = llm.calls[0]?.messages.find((m) => m.role === 'user')?.content as string;
    expect(seed).toContain('共 30 个'); // 轮廓
    expect(seed).not.toContain('object object:ticket:29'); // 没逐个全列
  });

  it('小对象集播种照常逐个列（无回归）', async () => {
    const html = Array.from({ length: 3 }, (_, i) => `<div data-agent-object="ticket:${i}">工单${i}</div>`).join('');
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: '看看' })]);
    const host = new FakeHostAdapter(build(html, '/b'));
    await collect(createAgent({ llm, host, codeAsAction: true }).run('有哪些工单'));
    const seed = llm.calls[0]?.messages.find((m) => m.role === 'user')?.content as string;
    expect(seed).toContain('object object:ticket:2 — 工单2');
    expect(seed).not.toContain('共 3 个');
  });

  it('读取闭环：复盘回合拿得到最终 surface 文本（不再只喂账本计数）', async () => {
    const before = build(`<div data-agent-object="task:1">登录超时</div><section data-agent-surface="detail">（未选择）</section>`, '/w');
    const opened = build(`<div data-agent-object="task:1">登录超时</div><section data-agent-surface="detail">任务1：登录超时 — 负责人:未指派</section>`, '/w');
    const program = { body: [{ op: 'open', on: 'object:task:1' }, { op: 'read', surface: 'detail' }, { op: 'finish', answer: '读完了' }] };
    const llm = new FakeLlmAdapter([
      toolCallTurn('runProgram', { program }),
      toolCallTurn('finish', { answer: '负责人未指派' }),
    ]);
    const host = new FakeHostAdapter(before, { 'object:task:1': opened });
    await collect(createAgent({ llm, host, codeAsAction: true }).run('看任务1详情'));
    const reflectMsgs = llm.calls[1]?.messages ?? [];
    const sawSurface = reflectMsgs.some((m) => typeof m.content === 'string' && m.content.includes('负责人:未指派'));
    expect(sawSurface).toBe(true);
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
