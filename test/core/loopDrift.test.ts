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

  it('先验注入用泛化形：不带实例 id（否则模型照抄当 predict 必然跨实例落空）', async () => {
    const s0 = build(PAGE('v0'));
    const wm = new WorldModel();
    wm.learn(s0, 'apply', {
      changed: true,
      details: ['object appeared: object:task:7', 'control control:qty: 0 → 5'],
    });
    const host = new FakeHostAdapter(s0);
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: '不用做' })]);
    await collect(createAgent({ llm, host, worldModel: wm }).run('看看'));

    const userMsg = llm.calls[0]!.messages.find((m) => m.role === 'user')!.content ?? '';
    expect(userMsg).toContain('object appeared: object:task');
    expect(userMsg).not.toContain('object:task:7'); // 实例 id 不得泄进先验
    expect(userMsg).toContain('control control:qty');
    expect(userMsg).not.toContain('0 → 5'); // 具体值不得泄进先验
  });

  it('注入上限：先验行数最多 8 行，active 优先于 suspect', async () => {
    // 10 个动作全有先验，其中 action a0 是 suspect——应被挤出（active 优先）
    const html =
      Array.from({ length: 10 }, (_, i) => `<button data-agent-action="a${i}">A${i}</button>`).join('') +
      `<p data-agent-surface="status">v0</p>`;
    const s0 = build(html);
    const wm = new WorldModel();
    for (let i = 0; i < 10; i++) {
      wm.learn(s0, `a${i}`, { changed: true, details: ['surface surface:status changed'] });
    }
    wm.learn(s0, 'a0', { changed: true, details: ['object appeared: object:x:1'] }); // a0 落空 → suspect
    const host = new FakeHostAdapter(s0);
    const llm = new FakeLlmAdapter([toolCallTurn('finish', { answer: 'ok' })]);
    await collect(createAgent({ llm, host, worldModel: wm }).run('看看'));

    const userMsg = llm.calls[0]!.messages.find((m) => m.role === 'user')!.content ?? '';
    const priorLines = userMsg.split('\n').filter((l: string) => l.startsWith('- '));
    expect(priorLines.length).toBeLessThanOrEqual(8);
    expect(userMsg).not.toContain('- a0 →'); // suspect 的 a0 被 active 挤出
  });

  it('中途换页（签名变化）→ 新页先验搭在该工具结果上补注', async () => {
    const pageA = build(`<div data-agent-object="item:1">条目1</div><p data-agent-surface="list">列表</p>`, '/list');
    const pageB = build(
      `<button data-agent-action="approve">通过</button><p data-agent-surface="detail">详情</p>`,
      '/detail',
    );
    const wm = new WorldModel();
    wm.learn(pageB, 'approve', { changed: true, details: ['surface surface:detail changed'] });

    const host = new FakeHostAdapter(pageA, { 'object:item:1': pageB });
    const llm = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: 'object:item:1' }),
      toolCallTurn('finish', { answer: 'ok' }),
    ]);
    await collect(createAgent({ llm, host, worldModel: wm }).run('打开条目1'));

    // 第二回合模型看到的 openObject 工具结果里，应补注 pageB 的先验
    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('approve → 预期变化: surface surface:detail changed');
  });

  it('同签名页面内的工具调用不重复补注先验', async () => {
    const s0 = build(PAGE('v0'));
    const wm = new WorldModel();
    wm.learn(s0, 'apply', { changed: true, details: ['surface surface:status changed'] });
    const host = new FakeHostAdapter(s0); // 无 transition，签名恒定
    const llm = new FakeLlmAdapter([
      toolCallTurn('readSurface', { ref: 'surface:status' }),
      toolCallTurn('finish', { answer: 'ok' }),
    ]);
    await collect(createAgent({ llm, host, worldModel: wm }).run('看看'));

    const userMsg = llm.calls[0]!.messages.find((m) => m.role === 'user')!.content ?? '';
    expect(userMsg).toContain('apply → 预期变化'); // 开头已注入
    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).not.toContain('预期变化'); // 同签名不重复
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
