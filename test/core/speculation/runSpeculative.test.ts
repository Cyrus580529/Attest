import { describe, it, expect } from 'vitest';
import { parseContract } from '../../../src/contract/parseContract';
import { FakeHostAdapter } from '../../../src/testing/fakeHostAdapter';
import { Ledger } from '../../../src/honesty/ledger';
import { runSpeculative } from '../../../src/core/speculation/runSpeculative';
import { fromMemory } from '../../../src/core/speculation/sources';
import type { AgentStep } from '../../../src/core/loopTypes';
import type { RecordedStep } from '../../../src/memory/pageMemory';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}
async function drain(gen: AsyncGenerator<AgentStep, { done: boolean }>) {
  const steps: AgentStep[] = [];
  let r = await gen.next();
  while (!r.done) {
    steps.push(r.value);
    r = await gen.next();
  }
  return { steps, result: r.value };
}

const todo = () => build(`<button data-agent-action="done">完成</button><input data-agent-control="c" value="0"/>`);
const done5 = () => build(`<button data-agent-action="done">完成</button><input data-agent-control="c" value="5"/>`);

describe('runSpeculative', () => {
  it('预测命中 → 零-LLM 执行写步，source 耗尽 → done:true', async () => {
    const host = new FakeHostAdapter(todo(), { 'action:done': done5() });
    const ledger = new Ledger();
    const rec: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: 'done' }, observedDiff: ['control:c: 0 → 5'] },
      { tool: 'finish', answer: 'ok' },
    ];
    const { steps, result } = await drain(
      runSpeculative(fromMemory(rec), {
        host,
        ledger,
        confirm: async () => ({ approved: true }),
        grantedScopes: new Set(),
      }),
    );
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
    expect(steps.some((s) => s.type === 'speculate' && s.hit)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ type: 'finish' });
    expect(result.done).toBe(true);
  });

  it('预测漂移（写 verified 但 diff 不吻合）→ mispredict + done:false（交回重同步）', async () => {
    const other = () => build(`<button data-agent-action="done">完成</button><input data-agent-control="c" value="9"/>`);
    const host = new FakeHostAdapter(todo(), { 'action:done': other() });
    const ledger = new Ledger();
    const rec: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: 'done' }, observedDiff: ['control:c: 0 → 5'] },
      { tool: 'finish', answer: 'ok' },
    ];
    const { steps, result } = await drain(
      runSpeculative(fromMemory(rec), {
        host,
        ledger,
        confirm: async () => ({ approved: true }),
        grantedScopes: new Set(),
      }),
    );
    expect(steps.some((s) => s.type === 'mispredict')).toBe(true);
    expect(result.done).toBe(false);
  });

  it('ref 失效 → done:false，不误动', async () => {
    const host = new FakeHostAdapter(todo(), {});
    const rec: RecordedStep[] = [{ tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: '不存在' } }];
    const { result } = await drain(
      runSpeculative(fromMemory(rec), {
        host,
        ledger: new Ledger(),
        confirm: async () => ({ approved: true }),
        grantedScopes: new Set(),
      }),
    );
    expect(result.done).toBe(false);
  });
});
