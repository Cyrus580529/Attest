import { describe, it, expect, beforeEach } from 'vitest';
import { createVoixHostAdapter } from '../../src/adapters/voixHostAdapter';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';

beforeEach(() => {
  document.body.innerHTML = '';
});
async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}

/** 一个 VOIX 页：add_task 工具（call 时改 context），tasks context。 */
function voixPage(): void {
  document.body.innerHTML = `<tool name="add_task" description="添加任务"></tool><context name="tasks">0 个任务</context>`;
  document.querySelector('[name=add_task]')!.addEventListener('call', () => {
    document.querySelector('context[name=tasks]')!.textContent = '1 个任务';
  });
}

describe('createVoixHostAdapter', () => {
  it('invokeAction 派发 call 事件 → handler 改 context → 快照可见变化', async () => {
    voixPage();
    const host = createVoixHostAdapter({ getUrl: () => '/app' });
    const before = host.snapshot();
    expect(before.surfaces[0]!.text).toBe('0 个任务');
    const action = before.actions.find((a) => a.name === 'add_task')!;

    const r = await host.invokeAction(action.ref);
    expect(r.ok).toBe(true);
    expect(r.snapshot.surfaces[0]!.text).toBe('1 个任务');
  });

  it('带 return 的 tool → 等 return 事件，note 带回传结果', async () => {
    document.body.innerHTML = `<tool name="get_time" description="取时间" return></tool>`;
    document.querySelector('[name=get_time]')!.addEventListener('call', (e) => {
      (e.target as Element).dispatchEvent(new CustomEvent('return', { detail: { success: true, time: '12:00' } }));
    });
    const host = createVoixHostAdapter({ getUrl: () => '/app' });
    const action = host.snapshot().actions[0]!;
    const r = await host.invokeAction(action.ref);
    expect(r.note ?? '').toContain('12:00');
  });

  it('端到端：Attest 驱动 VOIX 页 + verify + 诚实 outcome（VOIX 自己给不了的保证）', async () => {
    voixPage();
    const host = createVoixHostAdapter({ getUrl: () => '/app' });
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:add_task' }),
      toolCallTurn('finish', { answer: '已添加一个任务' }),
    ]);
    const steps = await collect(createAgent({ llm, host }).run('添加一个任务'));
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true); // diff 验证通过
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });
});
