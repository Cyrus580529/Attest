import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}
async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}

describe('读循环上下文管理', () => {
  it('长对话触发压缩：历史体量恒定受限（远低于朴素随轮数线性累积）', async () => {
    const host = new FakeHostAdapter(build(`<section data-agent-surface="s">${'内容'.repeat(80)}</section>`));
    const reads = Array.from({ length: 10 }, () => toolCallTurn('readSurface', { ref: 'surface:s' }));
    const llm = new FakeLlmAdapter([...reads, toolCallTurn('finish', { answer: '看完了' })]);
    await collect(createAgent({ llm, host, maxContextTokens: 40, maxSteps: 20 }).run('反复读那段文字'));

    const last = llm.calls.at(-1)!;
    expect(last.messages.some((m) => m.role === 'user' && m.content.includes('事实进展'))).toBe(true);
    // 10 轮朴素累积会 ≥22 条；压缩后恒定在 head(2)+摘要(1)+近期(≤6) 量级，远低于此。
    expect(last.messages.length).toBeLessThan(14);
  });

  it('短对话不压缩：无摘要注入', async () => {
    const host = new FakeHostAdapter(build(`<section data-agent-surface="s">短</section>`));
    const llm = new FakeLlmAdapter([toolCallTurn('readSurface', { ref: 'surface:s' }), toolCallTurn('finish', { answer: 'ok' })]);
    await collect(createAgent({ llm, host }).run('读一下'));
    const anySummary = llm.calls.some((c) => c.messages.some((m) => m.content.includes('事实进展')));
    expect(anySummary).toBe(false);
  });
});
