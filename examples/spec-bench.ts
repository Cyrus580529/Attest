// A/B 量化台：带/不带记忆+世界模型投机，比 LLM 调用数（确定性，FakeLlm，无需 API key）。
// 目的：直观展示「投机省下的往返」——命中投机的热跑应几乎零 LLM 调用。
// 跑法：npx tsx examples/spec-bench.ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const { parseContract } = await import('../src/contract/parseContract');
const { createAgent } = await import('../src/core/loop');
const { FakeLlmAdapter, toolCallTurn } = await import('../src/testing/fakeLlmAdapter');
const { FakeHostAdapter } = await import('../src/testing/fakeHostAdapter');
const { PageMemory } = await import('../src/memory/pageMemory');
const { WorldModel } = await import('../src/memory/worldModel');
import type { AgentStep } from '../src/core/loop';

function board() {
  document.body.innerHTML = `<input data-agent-control="c" value="0"/>`;
  return parseContract(document.body, '/p');
}
function board5() {
  document.body.innerHTML = `<input data-agent-control="c" value="5"/>`;
  return parseContract(document.body, '/p');
}
async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}

const memory = new PageMemory();
const wm = new WorldModel();

const cold = new FakeLlmAdapter([
  toolCallTurn('setControl', { ref: 'control:c', value: '5' }),
  toolCallTurn('finish', { answer: 'ok' }),
]);
await collect(
  createAgent({ llm: cold, host: new FakeHostAdapter(board(), { 'control:c': board5() }), memory, worldModel: wm }).run('设置c'),
);
const coldCalls = cold.calls.length;

const N = 10;
let hotCalls = 0;
let hits = 0;
for (let i = 0; i < N; i++) {
  const hot = new FakeLlmAdapter([toolCallTurn('finish', { answer: 'fallback' })]);
  const steps = await collect(
    createAgent({ llm: hot, host: new FakeHostAdapter(board(), { 'control:c': board5() }), memory, worldModel: wm }).run('设置c'),
  );
  hotCalls += hot.calls.length;
  if (steps.some((s) => s.type === 'speculate' && s.hit)) hits++;
}

console.log('=== 投机执行 A/B 量化 ===');
console.log(`冷跑（建记忆）LLM 调用: ${coldCalls}`);
console.log(`热跑 ${N} 次：命中投机 ${hits}/${N}，LLM 调用合计 ${hotCalls}`);
console.log(`每任务均摊 LLM 调用：冷 ${coldCalls} → 热 ${(hotCalls / N).toFixed(2)}`);
process.exit(0);
