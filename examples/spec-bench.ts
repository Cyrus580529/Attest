// A/B 量化台：同一多步任务，反应式（一步一回合）vs lookahead（一回合批量+predict）。
// LLM 始终主导（两者都由模型 authored）；效率来自"一次想更远"——lookahead 回合数更少。
// 跑法：npx tsx examples/spec-bench.ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const { parseContract } = await import('../src/contract/parseContract');
const { createAgent } = await import('../src/core/loop');
const { FakeLlmAdapter, toolCallTurn } = await import('../src/testing/fakeLlmAdapter');
const { FakeHostAdapter } = await import('../src/testing/fakeHostAdapter');
import type { AgentStep } from '../src/core/loop';
import type { LlmTurn } from '../src/llm/types';

function build(html: string) {
  document.body.innerHTML = html;
  return parseContract(document.body, '/p');
}
async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}
function batchTurn(calls: { name: string; arguments: Record<string, unknown> }[]): LlmTurn {
  return { content: '', toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, arguments: c.arguments })) };
}

const c0 = () => build(`<input data-agent-control="a" value="0"/><input data-agent-control="b" value="0"/>`);
const cA = () => build(`<input data-agent-control="a" value="1"/><input data-agent-control="b" value="0"/>`);
const cB = () => build(`<input data-agent-control="a" value="1"/><input data-agent-control="b" value="1"/>`);
const transitions = { 'control:a': cA(), 'control:b': cB() };

// 反应式：一步一回合
const reactive = new FakeLlmAdapter([
  toolCallTurn('setControl', { ref: 'control:a', value: '1' }),
  toolCallTurn('setControl', { ref: 'control:b', value: '1' }),
  toolCallTurn('finish', { answer: 'done' }),
]);
await collect(createAgent({ llm: reactive, host: new FakeHostAdapter(c0(), transitions) }).run('把 a、b 设为1'));

// lookahead：一回合批量 + predict
const lookahead = new FakeLlmAdapter([
  batchTurn([
    { name: 'setControl', arguments: { ref: 'control:a', value: '1', predict: ['control:a: 0 → 1'] } },
    { name: 'setControl', arguments: { ref: 'control:b', value: '1', predict: ['control:b: 0 → 1'] } },
    { name: 'finish', arguments: { answer: 'done' } },
  ]),
]);
const steps = await collect(createAgent({ llm: lookahead, host: new FakeHostAdapter(c0(), transitions) }).run('把 a、b 设为1'));

console.log('=== lookahead A/B 量化（LLM 始终主导）===');
console.log(`反应式（一步一回合）LLM 调用: ${reactive.calls.length}`);
console.log(`lookahead（一回合批量+predict）LLM 调用: ${lookahead.calls.length}，命中 ${steps.filter((s) => s.type === 'speculate' && s.hit).length} 步`);
console.log(`往返节省：${reactive.calls.length} → ${lookahead.calls.length}`);
process.exit(0);
