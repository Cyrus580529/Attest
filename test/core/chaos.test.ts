// 混沌套件：故障注入下的循环生存性。
// 性质断言：任何故障序列下，loop 必须走到 finish、outcome 与账本一致、绝不裸抛、绝不 hang。
// 这是"全绿但崩"教训的确定性对策——真模型验收管"体验好"，这里管"坏条件下不崩"。
import { describe, it, expect, beforeEach } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import type { HostResult } from '../../src/host/types';
import type { Ref } from '../../src/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

async function collect(gen: AsyncGenerator<AgentStep>): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for await (const s of gen) steps.push(s);
  return steps;
}

describe('混沌：host 故障下循环不裸崩', () => {
  it('invokeAction 抛异常 → error step + 诚实 finish（不 completed），绝不裸抛', async () => {
    const before = build(`<button data-agent-action="submit">提交</button>`);
    class ThrowingHost extends FakeHostAdapter {
      override invokeAction(_ref: Ref): Promise<HostResult> {
        throw new Error('page handler exploded');
      }
    }
    const host = new ThrowingHost(before);
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:submit' }),
      toolCallTurn('finish', { answer: '已提交' }),
    ]);
    const steps = await collect(createAgent({ llm, host }).run('提交'));

    expect(steps.some((s) => s.type === 'error')).toBe(true);
    const finish = steps.at(-1);
    expect(finish?.type).toBe('finish');
    expect(finish?.type === 'finish' && finish.outcome).not.toBe('completed');
  });

  it('openObject（读路径）抛异常 → error step，模型收到 ERROR 后仍能收尾', async () => {
    const before = build(`<div data-agent-object="task:1">t1</div>`);
    class ThrowingHost extends FakeHostAdapter {
      override openObject(_ref: Ref): Promise<HostResult> {
        return Promise.reject(new Error('detail fetch failed'));
      }
    }
    const host = new ThrowingHost(before);
    const llm = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: 'object:task:1' }),
      toolCallTurn('finish', { answer: '读不到详情' }),
    ]);
    const steps = await collect(createAgent({ llm, host }).run('看看 task:1'));

    expect(steps.some((s) => s.type === 'error')).toBe(true);
    expect(steps.at(-1)?.type).toBe('finish');
  });

  it('confirm 流程自身崩溃 → 按拒绝处理：绝不执行写，outcome 不为 completed', async () => {
    const before = build(`<button data-agent-action="wipe" data-agent-risk="high">清空</button>`);
    const host = new FakeHostAdapter(before);
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:wipe' }),
      toolCallTurn('finish', { answer: '已清空' }),
    ]);
    const steps = await collect(
      createAgent({
        llm,
        host,
        confirm: async () => {
          throw new Error('confirm UI crashed');
        },
      }).run('清空'),
    );

    expect(host.log).toEqual([]); // 高危写绝不执行
    expect(steps.some((s) => s.type === 'cancelled' || s.type === 'error')).toBe(true);
    const finish = steps.at(-1);
    expect(finish?.type).toBe('finish');
    expect(finish?.type === 'finish' && finish.outcome).not.toBe('completed');
  });

  it('畸形契约输入：parseContract 不抛，静默跳过坏节点（回归守卫）', () => {
    document.body.innerHTML =
      `<div data-agent-object="没有冒号">bad</div>` +
      `<button data-agent-action="">空名</button>` +
      `<div data-agent-object=":空type">bad</div>` +
      `<input data-agent-control="ok" value="1"/>` +
      `<p data-agent-surface="">空名surface</p>`;
    const snap = parseContract(document.body, '/p');
    expect(snap.objects).toEqual([]);
    expect(snap.actions).toEqual([]);
    expect(snap.surfaces).toEqual([]);
    expect(snap.controls.length).toBe(1);
  });
});
