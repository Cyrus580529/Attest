// 漂移检测接入读循环：漂移事件 yield 为 drift step；未验证写也进世界模型（负样本）；
// 先验注入分级（active 原样 / suspect 带警示 / 负先验明示无效果）。
import { describe, it, expect, beforeEach } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import { WorldModel } from '../../src/memory/worldModel';
import type { PageSnapshot, Ref } from '../../src/types';
import type { HostResult } from '../../src/host/types';

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

/** 每次 invoke 按队列推进快照（FakeHost 的 transition 只会停在同一张，测连续两次写需要它）。 */
class SeqHost extends FakeHostAdapter {
  constructor(
    initial: PageSnapshot,
    private readonly queue: PageSnapshot[],
  ) {
    super(initial);
  }
  override invokeAction(_ref: Ref): Promise<HostResult> {
    const next = this.queue.shift();
    if (next) this.setCurrent(next);
    return Promise.resolve({ ok: true, snapshot: this.snapshot() });
  }
}

const PAGE = (status: string) =>
  `<button data-agent-action="apply">申请</button><p data-agent-surface="status">${status}</p>`;

describe('漂移检测接入读循环', () => {
  it('已知动作连续两次不按已知效果发生 → yield drift step，世界模型自愈', async () => {
    const s0 = build(PAGE('v0'));
    const s1 = build(PAGE('v1'));
    const s2 = build(PAGE('v2'));
    const wm = new WorldModel();
    // 旧先验：apply 会新增 task 对象——但页面已改版，现在只改 status 文本
    wm.learn(s0, 'apply', { changed: true, details: ['object appeared: object:task:1'] });

    const host = new SeqHost(s0, [s1, s2]);
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:apply' }),
      toolCallTurn('invokeAction', { ref: 'action:apply' }),
      toolCallTurn('finish', { answer: '两次申请完成' }),
    ]);
    const steps = await collect(createAgent({ llm, host, worldModel: wm }).run('申请两次'));

    const drift = steps.find((s) => s.type === 'drift');
    expect(drift).toMatchObject({
      type: 'drift',
      refId: 'action:apply',
      expected: ['object appeared: object:task:1'],
      observed: ['surface surface:status changed'],
    });
    // 自愈：先验已采纳新行为
    expect(wm.lookup(s2, 'apply')).toEqual({
      details: ['surface surface:status changed'],
      status: 'active',
    });
  });

  it('未验证写（执行了但无变化）也进世界模型 → 负样本计数', async () => {
    const s0 = build(PAGE('v0'));
    const host = new FakeHostAdapter(s0); // 无 transition → 无变化
    const wm = new WorldModel();
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: 'action:apply' }),
      toolCallTurn('finish', { answer: '试过了' }),
    ]);
    await collect(createAgent({ llm, host, worldModel: wm }).run('申请'));
    expect(wm.noEffectCount(s0, 'apply')).toBe(1);
  });

  it('先验注入分级：suspect 带警示、负先验（≥2 次无效果）明示勿依赖', async () => {
    const s0 = build(
      `<button data-agent-action="apply">申请</button>` +
        `<button data-agent-action="noop">没用的按钮</button>` +
        `<p data-agent-surface="status">v0</p>`,
    );
    const wm = new WorldModel();
    wm.learn(s0, 'apply', { changed: true, details: ['object appeared: object:task:1'] });
    wm.learn(s0, 'apply', { changed: true, details: ['surface surface:status changed'] }); // 落空1 → suspect
    wm.learn(s0, 'noop', { changed: false, details: [] });
    wm.learn(s0, 'noop', { changed: false, details: [] }); // 负样本 ×2

    const host = new FakeHostAdapter(s0);
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: '不用做' })]);
    await collect(createAgent({ llm, host, worldModel: wm }).run('看看'));

    const userMsg = llm.calls[0]!.messages.find((m) => m.role === 'user')!.content ?? '';
    expect(userMsg).toContain('apply');
    expect(userMsg).toContain('最近一次未按此效果发生'); // suspect 警示
    expect(userMsg).toContain('noop');
    expect(userMsg).toContain('无可观察'); // 负先验
  });
});
