import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import { RecipeBook } from '../../src/memory/recipeBook';
import { pageSignature } from '../../src/memory/pageSignature';
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

const fillProgram = (v: string) => ({
  body: [{ op: 'setControl', on: { control: 'amount' }, value: v }, { op: 'finish', answer: `已填 ${v}` }],
});

describe('程序记忆——配方先验（codeAsAction + recipes）', () => {
  it('completed 程序成功后入库', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const after = build(`<input data-agent-control="amount" value="300" />`, '/p');
    const recipes = new RecipeBook();
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program: fillProgram('300') })]);
    const host = new FakeHostAdapter(before, { 'control:amount': after });
    await collect(createAgent({ llm, host, codeAsAction: true, recipes }).run('填300'));
    const out = recipes.recall(pageSignature(before), 3);
    expect(out).toHaveLength(1);
    expect(out[0]?.goal).toBe('填300');
  });

  it('同签名第二次运行：历史配方被注入到喂给 LLM 的 messages', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const recipes = new RecipeBook();
    recipes.record(pageSignature(before), { program: fillProgram('300'), goal: '填300', recordedAt: 1 });
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: '看看' })]);
    const host = new FakeHostAdapter(before);
    await collect(createAgent({ llm, host, codeAsAction: true, recipes }).run('再填一次'));
    const injected = llm.calls[0]?.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('填300'),
    );
    expect(injected).toBe(true);
  });

  it('没有配方时不注入配方块', async () => {
    const before = build(`<input data-agent-control="amount" value="0" />`);
    const recipes = new RecipeBook();
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: 'hi' })]);
    const host = new FakeHostAdapter(before);
    await collect(createAgent({ llm, host, codeAsAction: true, recipes }).run('啥也没干过'));
    const injected = llm.calls[0]?.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('配方'),
    );
    expect(injected).toBe(false);
  });

  it('部分取消的 partial 不入库', async () => {
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
      body: [{ op: 'invoke', action: 'resolve' }, { op: 'invoke', action: 'resolve' }, { op: 'finish', answer: '已全部' }],
    };
    const recipes = new RecipeBook();
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program })]);
    await collect(createAgent({ llm, host, codeAsAction: true, confirm, recipes }).run('全部解决'));
    expect(recipes.recall(pageSignature(base), 3)).toEqual([]);
  });

  it('注入配方不改变 outcome：被取消仍报 cancelled', async () => {
    const before = build(`<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`, '/shop');
    const after = build(`<section data-agent-surface="ok">兑换成功</section>`, '/done');
    const recipes = new RecipeBook();
    const program = { body: [{ op: 'invoke', action: 'redeem' }, { op: 'finish', answer: '已兑换' }] };
    recipes.record(pageSignature(before), { program, goal: '兑换', recordedAt: 1 });
    const llm = new FakeLlmAdapter([toolCallTurn('runProgram', { program })]);
    const host = new FakeHostAdapter(before, { 'action:redeem': after });
    const steps = await collect(createAgent({ llm, host, codeAsAction: true, recipes }).run('兑换'));
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'cancelled' });
  });
});
