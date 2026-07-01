// 切片8 投机执行 —— 真模型 live 验收。
// 读循环 + memory + worldModel，同一(页面,任务)连跑两次：第二次应命中投机、LLM 往返骤降，且仍诚实。
// 跑法：
//   $env:ATTEST_API_KEY="..."; $env:ATTEST_BASE_URL="https://api.deepseek.com"; $env:ATTEST_MODEL="deepseek-chat"
//   npx tsx examples/live-spec.ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const nodeFetch = globalThis.fetch; // happy-dom 注册前抓原生 fetch（绕 CORS）
GlobalRegistrator.register();

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.ATTEST_MODEL ?? 'deepseek-chat';
if (!key) { console.error('需要 ATTEST_API_KEY'); process.exit(1); }

const { createAgent } = await import('../src/core/loop');
const { createDomHostAdapter } = await import('../src/adapters/domHostAdapter');
const { createOpenAiAdapter } = await import('../src/llm/openaiAdapter');
const { PageMemory } = await import('../src/memory/pageMemory');
const { WorldModel } = await import('../src/memory/worldModel');
import type { AgentStep } from '../src/core/loop';
import type { LlmAdapter, LlmMessage, ToolSchema } from '../src/llm/types';

/** 包一层计数：统计真模型 step 被调用几次（= LLM 往返数）。 */
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

/** 建一个简单契约页：优先级下拉 + 保存按钮（低危，改 notice）+ notice surface。 */
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

const memory = new PageMemory();
const wm = new WorldModel();
const TASK = '把优先级改成"高"，然后点保存。';

async function run(label: string): Promise<number> {
  buildPage(); // 每次重建同一页面（同签名），初始状态一致
  const c = counting(createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch }));
  const agent = createAgent({
    llm: c.adapter,
    host: createDomHostAdapter({ getUrl: () => '/settings' }),
    memory,
    worldModel: wm,
    maxSteps: 8,
    confirm: async () => ({ approved: true, scope: 'all' }),
  });
  console.log(`\n── ${label} ──\n用户> ${TASK}`);
  const steps: AgentStep[] = [];
  for await (const s of agent.run(TASK)) { steps.push(s); show(s); }
  const f = steps.find((s) => s.type === 'finish');
  const specHit = steps.some((s) => s.type === 'speculate' && s.hit);
  console.log(`  >>> LLM 往返=${c.calls}；outcome=${f?.type === 'finish' ? f.outcome : '?'}；命中投机=${specHit}`);
  return c.calls;
}

const cold = await run('第一次（冷跑，建记忆/世界模型）');
const hot = await run('第二次（热跑，应命中投机、LLM 往返骤降）');

console.log('\n=== 切片8 判定 ===');
console.log(`冷跑 LLM 往返=${cold} → 热跑 LLM 往返=${hot}`);
console.log(hot < cold ? '✅ 热跑往返下降——投机生效' : '⚠️ 热跑未下降——需查记忆键/漂移/命中');
console.log('人工核验：热跑 outcome 是否仍正确、叙述是否诚实、有无乱动。');
process.exit(0);
