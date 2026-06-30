// 非交互 live 证伪脚本 —— 真模型跑固定场景，验证 slice6/7 + 渐进披露到底崩不崩。
// 跑法：$env:ATTEST_API_KEY=...; $env:ATTEST_BASE_URL="https://api.deepseek.com"; $env:ATTEST_MODEL="deepseek-chat"; npx tsx examples/live-check.ts [smoke|s1|s2|s3|all]
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// 必须在 happy-dom 注册前抓住 Node 原生 fetch（无 CORS），专给 LLM 调用。
const nodeFetch = globalThis.fetch;
GlobalRegistrator.register();

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.ATTEST_MODEL ?? 'deepseek-chat';
if (!key) {
  console.error('需要 ATTEST_API_KEY');
  process.exit(1);
}

const { createAgent } = await import('../src/core/loop');
const { createDomHostAdapter } = await import('../src/adapters/domHostAdapter');
const { createOpenAiAdapter } = await import('../src/llm/openaiAdapter');
const { RecipeBook } = await import('../src/memory/recipeBook');
import type { AgentStep } from '../src/core/loop';

const which = process.argv[2] ?? 'all';
const newLlm = () => createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch });

/** 建一个 n 工单的看板：每个 ticket 可 open（detail 显示其内容），resolve 高危、每次产生可观察变化（计数器保证 verify）。 */
function buildBoard(n: number): void {
  let counter = 0;
  document.body.innerHTML =
    Array.from({ length: n }, (_, i) => `<div data-agent-object="ticket:${i + 1}">工单${i + 1}：问题${i + 1}</div>`).join('') +
    `<button data-agent-action="resolve" data-agent-risk="high">标记为已解决</button>` +
    `<section data-agent-surface="detail">（未选择）</section>`;
  const detail = document.querySelector('[data-agent-surface="detail"]')!;
  document.querySelectorAll('[data-agent-object]').forEach((li) => {
    li.addEventListener('click', () => {
      detail.textContent = `详情：${li.textContent?.trim()} —— 复现步骤与负责人。`;
    });
  });
  document.querySelector('[data-agent-action="resolve"]')!.addEventListener('click', () => {
    counter += 1;
    detail.textContent = `✅ 已解决 #${counter}（${detail.textContent?.slice(0, 24)}…）`;
  });
}

function show(s: AgentStep): void {
  if (s.type === 'thinking') console.log(`  💭 ${s.text}`);
  else if (s.type === 'plan') console.log(`  ▸ 计划：${s.items.join('；')}`);
  else if (s.type === 'finish') {
    console.log(`  FINISH [${s.outcome}] ${s.answer}`);
    console.log(`    账本：${s.ledger.map((e) => e.kind).join(' → ') || '(空)'}`);
  } else if (s.type === 'action') console.log(`  action ${s.tool}(${s.refId}) verified=${s.verified}`);
  else if (s.type === 'held') console.log(`  held ${s.intent.label}`);
  else if (s.type === 'cancelled') console.log(`  cancelled ${s.refId}`);
  else if (s.type === 'observation') console.log(`  observe ${s.tool}${s.refId ? `(${s.refId})` : ''}`);
  else if (s.type === 'error') console.log(`  ⚠️ error ${s.tool}: ${s.error}`);
}

async function drive(label: string, agent: { run: (m: string) => AsyncGenerator<AgentStep> }, msg: string): Promise<AgentStep[]> {
  console.log(`\n── ${label} ──\n用户> ${msg}`);
  const steps: AgentStep[] = [];
  for await (const s of agent.run(msg)) {
    steps.push(s);
    show(s);
  }
  return steps;
}

function programAgent(recipes?: InstanceType<typeof RecipeBook>) {
  return createAgent({
    llm: newLlm(),
    host: createDomHostAdapter({ getUrl: () => '/board' }),
    codeAsAction: true,
    recipes,
    maxSteps: 6,
    confirm: (intent) => {
      console.log(`  [HELD→自动批准 scope=all] ${intent.label}`);
      return Promise.resolve({ approved: true, scope: 'all' });
    },
  });
}

const errs = (steps: AgentStep[]) => steps.filter((s) => s.type === 'error').length;
const fin = (steps: AgentStep[]) => steps.find((s) => s.type === 'finish');

async function smoke(): Promise<void> {
  console.log('\n=== SMOKE：验证 auth/model/管线 ===');
  const turn = await newLlm().step([{ role: 'user', content: '只回复两个字：通了' }], []);
  console.log(`  模型回复：${JSON.stringify(turn.content)}`);
}

async function s1(): Promise<void> {
  console.log('\n=== S1：程序循环基本盘（3 工单）===');
  buildBoard(3);
  const steps = await drive('逐个打开并全部标记已解决', programAgent(), '把每个工单都打开看一眼，然后全部标记为已解决');
  const f = fin(steps);
  console.log(`\n  >>> 判定：outcome=${f?.type === 'finish' ? f.outcome : '?'}，error 步=${errs(steps)}`);
}

async function s2(): Promise<void> {
  console.log('\n=== S2：渐进披露大页面（25 工单）—— 关键证伪 ===');
  buildBoard(25);
  const steps = await drive('大页面批处理', programAgent(), '把每个工单都标记为已解决');
  const f = fin(steps);
  const verified = steps.filter((s) => s.type === 'action' && s.verified).length;
  const fabRef = steps.some((s) => s.type === 'error' && /ref|引用|未找到|not found/i.test(s.error));
  console.log(`\n  >>> 判定：outcome=${f?.type === 'finish' ? f.outcome : '?'}，verified 写=${verified}，error 步=${errs(steps)}，疑似编 ref=${fabRef}`);
}

async function s3(): Promise<void> {
  console.log('\n=== S3：配方跨任务串味 ===');
  const recipes = new RecipeBook();
  buildBoard(3);
  await drive('任务A：全部解决（成功后入配方）', programAgent(recipes), '把每个工单都标记为已解决');
  buildBoard(3);
  console.log('\n  （第二次：同页面、无关任务，看 A 配方会不会把 B 带偏）');
  const steps = await drive('任务B：只看第2个工单讲什么', programAgent(recipes), '第2个工单讲的是什么问题？只要告诉我内容，不要改动任何东西');
  const wrongWrites = steps.filter((s) => s.type === 'action' && s.tool === 'invokeAction').length;
  const f = fin(steps);
  console.log(`\n  >>> 判定：outcome=${f?.type === 'finish' ? f.outcome : '?'}，B 里发生的写动作=${wrongWrites}（应为 0——B 是只读任务，若 >0 说明被 A 配方带偏）`);
}

try {
  await smoke();
  if (which === 'smoke') { /* 只 smoke */ }
  else {
    if (which === 'all' || which === 's1') await s1();
    if (which === 'all' || which === 's2') await s2();
    if (which === 'all' || which === 's3') await s3();
  }
  console.log('\n=== 完成 ===');
} catch (e) {
  console.error(`\n[运行出错] ${(e as Error).message}`);
  process.exit(1);
}
process.exit(0);
