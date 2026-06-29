import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn, textTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';

function listSnap() {
  document.body.innerHTML = `<div data-agent-object="task:1">登录任务</div>`;
  return parseContract(document.body, '/list');
}
function detailSnap() {
  document.body.innerHTML = `<section data-agent-surface="detail">需要修复登录</section>`;
  return parseContract(document.body, '/detail');
}

async function collect(gen: AsyncGenerator<AgentStep>): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for await (const s of gen) steps.push(s);
  return steps;
}

describe('read loop', () => {
  it('observePage → finish：产出观察与完成终答', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('observePage', {}),
      toolCallTurn('finish', { answer: '当前有 1 个任务：登录任务' }),
    ]);
    const host = new FakeHostAdapter(listSnap());
    const steps = await collect(createAgent({ llm, host }).run('有什么任务'));

    expect(steps[0]).toMatchObject({ type: 'observation', tool: 'observePage' });
    expect(steps[0]?.type === 'observation' && steps[0].result).toContain('登录任务');
    expect(steps.at(-1)).toMatchObject({ type: 'finish', answer: '当前有 1 个任务：登录任务', outcome: 'completed' });
  });

  it('非法 ref → error step，且不执行 host', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: 'object:task:999' }),
      toolCallTurn('finish', { answer: '找不到那个任务' }),
    ]);
    const host = new FakeHostAdapter(listSnap());
    const steps = await collect(createAgent({ llm, host }).run('打开任务'));

    expect(steps[0]).toMatchObject({ type: 'error', tool: 'openObject', refId: 'object:task:999' });
    expect(host.log).toEqual([]);
  });

  it('openObject 进详情后 readSurface 跨页读取', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: 'object:task:1' }),
      toolCallTurn('readSurface', { ref: 'surface:detail' }),
      toolCallTurn('finish', { answer: '任务详情：需要修复登录' }),
    ]);
    const host = new FakeHostAdapter(listSnap(), { 'object:task:1': detailSnap() });
    const steps = await collect(createAgent({ llm, host }).run('看任务1详情'));

    expect(host.log[0]).toEqual({ kind: 'open', refId: 'object:task:1' });
    const read = steps.find((s) => s.type === 'observation' && s.tool === 'readSurface');
    expect(read && read.type === 'observation' && read.result).toBe('需要修复登录');
  });

  it('纯文本回复（无 tool_call）当作完成终答', async () => {
    const llm = new FakeLlmAdapter([textTurn('你好，我能帮你查看任务。')]);
    const host = new FakeHostAdapter(listSnap());
    const steps = await collect(createAgent({ llm, host }).run('你好'));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'finish', answer: '你好，我能帮你查看任务。', outcome: 'completed' });
  });

  it('超过 maxSteps → 诚实的 failed 终答', async () => {
    const llm = new FakeLlmAdapter(Array(20).fill(toolCallTurn('observePage', {})));
    const host = new FakeHostAdapter(listSnap());
    const steps = await collect(createAgent({ llm, host, maxSteps: 3 }).run('循环'));

    const last = steps.at(-1);
    expect(last).toMatchObject({ type: 'finish', outcome: 'failed' });
  });
});
