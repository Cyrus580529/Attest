// 切片8 投机执行 —— 真模型 live 验收（LLM 主导 + lookahead + 世界模型先验）。
// 读循环：模型每回合亲自规划，可一次提多步并给 predict；世界模型把已知效果作先验注入。
// 同一(页,任务)连跑两次：第二次带世界模型先验，观察模型是否更自信地 lookahead、往返更少，且仍诚实。
// 跑法：
//   $env:ATTEST_API_KEY="..."; $env:ATTEST_BASE_URL="https://api.deepseek.com"; $env:ATTEST_MODEL="deepseek-v4-pro"
//   npx tsx examples/live-spec.ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const nodeFetch = globalThis.fetch; // happy-dom 注册前抓原生 fetch（绕 CORS）
GlobalRegistrator.register();

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.ATTEST_MODEL ?? 'deepseek-v4-pro';
if (!key) { console.error('需要 ATTEST_API_KEY'); process.exit(1); }

const { createAgent } = await import('../src/core/loop');
const { createDomHostAdapter } = await import('../src/adapters/domHostAdapter');
const { createOpenAiAdapter } = await import('../src/llm/openaiAdapter');
const { WorldModel } = await import('../src/memory/worldModel');
import type { AgentStep } from '../src/core/loop';
import type { LlmAdapter, LlmMessage, ToolSchema } from '../src/llm/types';

/** 包一层计数：统计真模型 step 被调用几次（= LLM 往返数/回合数）。 */
function counting(inner: LlmAdapter) {
  let calls = 0;
  const adapter: LlmAdapter = {
    step(messages: LlmMessage[], tools: ToolSchema[]) {
      calls++;
      return inner.step(messages, tools);
    },
  };
  return { adapter, get calls() { return calls; } };
}

/** 简单契约页：优先级下拉 + 保存按钮（低危，改 notice）+ notice surface。多步任务，便于观察 lookahead。 */
function buildPage(): void {
  document.body.innerHTML =
    `<select data-agent-control="priority" aria-label="优先级"><option value="低">低</option><option value="高">高</option></select>` +
    `<button data-agent-action="save">保存</button>` +
    `<section data-agent-surface="notice">未保存</section>`;
  const priority = () => (document.querySelector('[data-agent-control="priority"]') as HTMLSelectElement).value;
  const notice = document.querySelector('[data-agent-surface="notice"]')!;
  document.querySelector('[data-agent-action="save"]')!.addEventListener('click', () => {
    notice.textContent = `已保存，优先级=${priority()}`;
  });
}

function show(s: AgentStep): void {
  if (s.type === 'thinking') console.log(`  💭 ${s.text}`);
  else if (s.type === 'finish') {
    console.log(`  FINISH [${s.outcome}] ${s.answer}`);
    console.log(`    账本：${s.ledger.map((e) => e.kind).join(' → ') || '(空)'}`);
  } else if (s.type === 'action') console.log(`  action ${s.tool}(${s.refId}) verified=${s.verified}`);
  else if (s.type === 'speculate') console.log(`  ⚡ speculate ${s.tool}(${s.refId ?? ''}) hit=${s.hit}`);
  else if (s.type === 'mispredict') console.log(`  ✗ mispredict ${s.tool} 期望[${s.expected.join(',')}] 实得[${s.actual.join(',')}]`);
  else if (s.type === 'held') console.log(`  held ${s.intent.label}`);
  else if (s.type === 'cancelled') console.log(`  ✕ cancelled ${s.refId}`);
  else if (s.type === 'observation') console.log(`  observe ${s.tool}${s.refId ? `(${s.refId})` : ''}`);
  else if (s.type === 'error') console.log(`  ⚠️ error ${s.tool}: ${s.error}`);
}

const wm = new WorldModel();
const TASK = '把优先级改成"高"，然后点保存。';

async function run(label: string): Promise<number> {
  buildPage(); // 每次重建同一页面（同签名），初始状态一致
  const c = counting(createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch }));
  const agent = createAgent({
    llm: c.adapter,
    host: createDomHostAdapter({ getUrl: () => '/settings' }),
    worldModel: wm, // 先验来源：第一次学、第二次注入（LLM 仍主导）
    maxSteps: 8,
    confirm: async () => ({ approved: true, scope: 'all' }),
  });
  console.log(`\n── ${label} ──\n用户> ${TASK}`);
  const steps: AgentStep[] = [];
  for await (const s of agent.run(TASK)) { steps.push(s); show(s); }
  const f = steps.find((s) => s.type === 'finish');
  const hits = steps.filter((s) => s.type === 'speculate' && s.hit).length;
  const miss = steps.filter((s) => s.type === 'mispredict').length;
  console.log(`  >>> LLM 回合=${c.calls}；outcome=${f?.type === 'finish' ? f.outcome : '?'}；predict 命中=${hits}、落空=${miss}`);
  return c.calls;
}

const first = await run('第一次（无先验，模型现场规划）');
const second = await run('第二次（带世界模型先验，应更自信 lookahead）');

console.log('\n=== 切片8 判定（LLM 主导）===');
console.log(`第一次 LLM 回合=${first} → 第二次=${second}`);
console.log('人工核验：两次都由模型 authored（非旁路）；outcome 正确、叙述诚实；lookahead 命中越多、回合越少越好。');
process.exit(0);
