import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}
async function collect(gen: AsyncGenerator<AgentStep>): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for await (const s of gen) steps.push(s);
  return steps;
}

describe('askUser 主动澄清（ask 回调对标 confirm）', () => {
  const snap = () => build(`<section data-agent-surface="s">就绪</section>`);

  it('交互宿主返回答案 → clarify 步 answered=true，工具结果含答案', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('askUser', { question: '导出的日期范围是？' }),
      toolCallTurn('finish', { answer: '按用户指定的范围导出' }),
    ]);
    let asked = '';
    const steps = await collect(
      createAgent({
        llm,
        host: new FakeHostAdapter(snap()),
        ask: async (q) => {
          asked = q;
          return { answer: '2024 Q3' };
        },
      }).run('导出报表'),
    );
    expect(asked).toBe('导出的日期范围是？');
    const clarify = steps.find((s) => s.type === 'clarify');
    expect(clarify).toMatchObject({ type: 'clarify', answered: true });
    const finish = steps.find((s) => s.type === 'finish');
    expect(finish && finish.type === 'finish' && finish.ledger.some((e) => e.kind === 'clarify')).toBe(true);
  });

  it('非交互宿主（无人应答）→ clarify 步 answered=false，不阻塞', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('askUser', { question: '会议时长是？' }),
      toolCallTurn('finish', { answer: '缺时长，按系统默认，已说明假设' }),
    ]);
    const steps = await collect(
      createAgent({ llm, host: new FakeHostAdapter(snap()), ask: async () => ({}) }).run('排会议'),
    );
    const clarify = steps.find((s) => s.type === 'clarify');
    expect(clarify).toMatchObject({ type: 'clarify', answered: false });
  });

  it('默认无 ask 选项 → 无人应答语义，不抛错', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('askUser', { question: '缺哪个参数？' }),
      toolCallTurn('finish', { answer: 'done' }),
    ]);
    const steps = await collect(createAgent({ llm, host: new FakeHostAdapter(snap()) }).run('做点事'));
    expect(steps.find((s) => s.type === 'clarify')).toMatchObject({ answered: false });
  });

  it('澄清不影响 outcome（clarify 非写，纯澄清任务仍 completed）', async () => {
    const llm = new FakeLlmAdapter([
      toolCallTurn('askUser', { question: '哪个？' }),
      toolCallTurn('finish', { answer: '已澄清' }),
    ]);
    const steps = await collect(
      createAgent({ llm, host: new FakeHostAdapter(snap()), ask: async () => ({ answer: 'x' }) }).run('问一下'),
    );
    const finish = steps.find((s) => s.type === 'finish');
    expect(finish && finish.type === 'finish' && finish.outcome).toBe('completed');
  });
});
