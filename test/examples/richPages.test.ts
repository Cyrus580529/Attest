// 更丰富的页型验证（CLAUDE.md 开放线 #3：导航 / 分页 / 嵌套）。
// 用 FakeLlm 走真 loop + 真 host adapter，证明信任机制在比玩具单页更硬的形状上仍成立：
//   ① VOIX 导航——一个 tool 改写整页（SPA 式跳详情），跳转后快照反映新页、写被 verify。
//   ② VOIX 分页——next_page tool 翻页，verify 捕捉 context 变化，模型可跨页读。
//   ③ data-agent-* 嵌套——epic 下挂 task 两层对象，openObject 钻取子对象、读详情。
// 真模型 live 验收仍需 examples/live-pages.ts + 你的 key；这里只证"机制对"。
import { describe, it, expect, beforeEach } from 'vitest';
import { createVoixHostAdapter } from '../../src/adapters/voixHostAdapter';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn, type LlmTurn } from '../../src/testing/fakeLlmAdapter';
import type { PageSnapshot } from '../../src/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

async function collect(gen: AsyncGenerator<AgentStep>): Promise<AgentStep[]> {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}
const refOfAction = (snap: PageSnapshot, name: string) => snap.actions.find((a) => a.name === name)!.ref.id;
const refOfSurface = (snap: PageSnapshot, name: string) => snap.surfaces.find((s) => s.name === name)!.ref.id;

describe('更丰富页型：导航 / 分页 / 嵌套（机制验证）', () => {
  it('① VOIX 导航：tool 改写整页跳详情，跳转后快照反映新页且写被 verify → completed', async () => {
    // 列表页：open_item(带 id) 的 handler 把整个 body 换成详情页（新 tool + 新 context）。
    document.body.innerHTML =
      `<tool name="open_item" description="打开某条目看详情"><prop name="id" type="string" required></prop></tool>` +
      `<context name="view">列表：条目1、条目2</context>`;
    document.querySelector('[name=open_item]')!.addEventListener('call', (e) => {
      const { id } = (e as CustomEvent).detail;
      document.body.innerHTML =
        `<tool name="go_back" description="返回列表"></tool>` +
        `<context name="view">条目${id} 的详情：负责人与复现步骤。</context>`;
    });

    const host = createVoixHostAdapter({ getUrl: () => '/list' });
    const openRef = refOfAction(host.snapshot(), 'open_item');
    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: openRef, args: { id: '2' } }),
      toolCallTurn('finish', { answer: '已打开条目2 并读到详情' }),
    ]);

    const steps = await collect(createAgent({ llm, host }).run('打开第2个条目看详情'));
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true); // 跳转即可观察变化，verify 通过
    expect(host.snapshot().surfaces.find((s) => s.name === 'view')!.text).toContain('条目2 的详情');
    expect(host.snapshot().actions.some((a) => a.name === 'go_back')).toBe(true); // 新页的 tool 已生效
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('② VOIX 分页：next_page 翻页，verify 捕捉 context 变化，可跨页读', async () => {
    let page = 1;
    const render = () => {
      document.querySelector('context[name=items]')!.textContent =
        page === 1 ? '第1/2页：苹果、香蕉' : '第2/2页：樱桃、枣子';
    };
    document.body.innerHTML =
      `<tool name="next_page" description="下一页"></tool><context name="items">第1/2页：苹果、香蕉</context>`;
    document.querySelector('[name=next_page]')!.addEventListener('call', () => { page = 2; render(); });

    const host = createVoixHostAdapter({ getUrl: () => '/paged' });
    const snap0 = host.snapshot();
    const itemsRef = refOfSurface(snap0, 'items');
    const nextRef = refOfAction(snap0, 'next_page');
    const llm = new FakeLlmAdapter([
      toolCallTurn('readSurface', { ref: itemsRef }),   // 读第1页
      toolCallTurn('invokeAction', { ref: nextRef }),   // 翻页（写，verify）
      toolCallTurn('readSurface', { ref: itemsRef }),   // 读第2页
      toolCallTurn('finish', { answer: '两页共4项：苹果、香蕉、樱桃、枣子' }),
    ]);

    const steps = await collect(createAgent({ llm, host }).run('把所有分页的条目都读出来'));
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true); // 翻页被 verify
    expect(host.snapshot().surfaces.find((s) => s.name === 'items')!.text).toContain('第2/2页');
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });

  it('③ data-agent-* 嵌套：epic 下挂 task 两层对象，openObject 钻取子对象读详情 → completed', async () => {
    document.body.innerHTML =
      `<ul data-agent-surface="board">` +
      `  <li data-agent-object="epic:1">Epic：发布` +
      `    <ul>` +
      `      <li data-agent-object="task:11">Task：写 README</li>` +
      `      <li data-agent-object="task:12">Task：录 demo</li>` +
      `    </ul>` +
      `  </li>` +
      `</ul>` +
      `<section data-agent-surface="detail">（未选择）</section>`;
    const detail = document.querySelector('[data-agent-surface="detail"]')!;
    document.querySelectorAll('[data-agent-object]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        detail.textContent = `详情：${(ev.currentTarget as Element).textContent?.trim().split('\n')[0]}`;
      });
    });

    const host = createDomHostAdapter({ getUrl: () => '/nested' });
    const snap0 = host.snapshot();
    // 两层对象都被抽出：epic + 两个 task
    expect(snap0.objects.filter((o) => o.type === 'task')).toHaveLength(2);
    expect(snap0.objects.some((o) => o.type === 'epic')).toBe(true);
    const task11 = snap0.objects.find((o) => o.type === 'task' && o.ref.id.includes('11'))!.ref.id;
    const detailRef = refOfSurface(snap0, 'detail');

    const llm = new FakeLlmAdapter([
      toolCallTurn('openObject', { ref: task11 }),      // 钻取嵌套子对象
      toolCallTurn('readSurface', { ref: detailRef }),  // 读详情
      toolCallTurn('finish', { answer: 'Task 11 是「写 README」' }),
    ]);

    const steps = await collect(createAgent({ llm, host }).run('第一个任务讲的是什么'));
    expect(host.snapshot().surfaces.find((s) => s.name === 'detail')!.text).toContain('写 README');
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
  });
});
