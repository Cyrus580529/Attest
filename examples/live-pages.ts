// 更丰富页型的真模型 live 验收（CLAUDE.md 开放线 #3：导航 / 分页 / 嵌套）。
// 确定性版见 test/examples/richPages.test.ts（证"机制对"）；这里让真模型自己规划驱动，证"体验好"。
// 判定看：模型是否走对工具、跨页/钻取是否读到、写是否 verify、outcome 是否诚实。
// 跑法：
//   $env:ATTEST_API_KEY="..."; $env:ATTEST_BASE_URL="https://api.deepseek.com"; $env:ATTEST_MODEL="deepseek-v4-pro"
//   npx tsx examples/live-pages.ts [nav|page|nest|all]
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const nodeFetch = globalThis.fetch; // happy-dom 注册前抓原生 fetch（绕 CORS）
GlobalRegistrator.register();

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.ATTEST_MODEL ?? 'deepseek-v4-pro';
if (!key) { console.error('需要 ATTEST_API_KEY'); process.exit(1); }

const { createAgent } = await import('../src/core/loop');
const { createVoixHostAdapter } = await import('../src/adapters/voixHostAdapter');
const { createDomHostAdapter } = await import('../src/adapters/domHostAdapter');
const { createOpenAiAdapter } = await import('../src/llm/openaiAdapter');
import type { AgentStep } from '../src/core/loop';
import type { HostAdapter } from '../src/host/types';

const newLlm = () => createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch });
const which = process.argv[2] ?? 'all';

function show(s: AgentStep): void {
  if (s.type === 'thinking') console.log(`  💭 ${s.text}`);
  else if (s.type === 'finish') {
    console.log(`  FINISH [${s.outcome}] ${s.answer}`);
    console.log(`    账本：${s.ledger.map((e) => e.kind).join(' → ') || '(空)'}`);
  } else if (s.type === 'action') console.log(`  action ${s.tool}(${s.refId}) verified=${s.verified}`);
  else if (s.type === 'observation') console.log(`  observe ${s.tool}${s.refId ? `(${s.refId})` : ''}`);
  else if (s.type === 'held') console.log(`  🔒 held ${s.intent.label}`);
  else if (s.type === 'cancelled') console.log(`  ✕ cancelled ${s.refId}`);
  else if (s.type === 'error') console.log(`  ⚠️ error ${s.tool}: ${s.error}`);
}

async function drive(label: string, host: HostAdapter, msg: string): Promise<AgentStep[]> {
  console.log(`\n── ${label} ──\n用户> ${msg}`);
  const steps: AgentStep[] = [];
  for await (const s of createAgent({ llm: newLlm(), host, maxSteps: 8 }).run(msg)) { steps.push(s); show(s); }
  return steps;
}
const outcome = (steps: AgentStep[]) => { const f = steps.find((s) => s.type === 'finish'); return f?.type === 'finish' ? f.outcome : '?'; };

// ① 导航：一个 tool 改写整页跳详情（SPA 式）。
async function nav(): Promise<void> {
  console.log('\n=== ① VOIX 导航（tool 改写整页跳详情）===');
  document.body.innerHTML =
    `<tool name="open_item" description="打开某条目看详情"><prop name="id" type="string" description="条目号" required></prop></tool>` +
    `<context name="view">列表：条目1（登录报错）、条目2（导出失败）</context>`;
  document.querySelector('[name=open_item]')!.addEventListener('call', (e) => {
    const { id } = (e as CustomEvent).detail;
    document.body.innerHTML =
      `<tool name="go_back" description="返回列表"></tool>` +
      `<context name="view">条目${id} 详情：负责人 Alice，复现步骤见工单。</context>`;
  });
  const steps = await drive('打开第2条看详情', createVoixHostAdapter({ getUrl: () => '/list' }), '打开第2个条目，告诉我它的详情');
  console.log(`  >>> 页面现状：${document.querySelector('context[name=view]')?.textContent}；outcome=${outcome(steps)}`);
}

// ② 分页：next_page 翻页改 context。
async function page(): Promise<void> {
  console.log('\n=== ② VOIX 分页（next_page 翻页）===');
  let p = 1;
  const render = () => {
    document.querySelector('context[name=items]')!.textContent =
      p === 1 ? '第1/2页：苹果、香蕉' : '第2/2页：樱桃、枣子';
  };
  document.body.innerHTML =
    `<tool name="next_page" description="翻到下一页"></tool><context name="items">第1/2页：苹果、香蕉</context>`;
  document.querySelector('[name=next_page]')!.addEventListener('call', () => { p = 2; render(); });
  const steps = await drive('读全部分页', createVoixHostAdapter({ getUrl: () => '/paged' }), '这个列表有两页，把所有页的条目都读出来给我');
  console.log(`  >>> 页面现状：${document.querySelector('context[name=items]')?.textContent}；outcome=${outcome(steps)}`);
}

// ③ 嵌套：epic 下挂 task 两层对象，钻取子对象读详情。
async function nest(): Promise<void> {
  console.log('\n=== ③ data-agent-* 嵌套（epic > task 两层，钻取子对象）===');
  document.body.innerHTML =
    `<ul data-agent-surface="board"><li data-agent-object="epic:1">Epic：发布` +
    `<ul><li data-agent-object="task:11">Task：写 README</li><li data-agent-object="task:12">Task：录 demo</li></ul>` +
    `</li></ul><section data-agent-surface="detail">（未选择）</section>`;
  const detail = document.querySelector('[data-agent-surface="detail"]')!;
  document.querySelectorAll('[data-agent-object]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      detail.textContent = `详情：${(ev.currentTarget as Element).textContent?.trim().split('\n')[0]} —— 负责人与截止日。`;
    });
  });
  const steps = await drive('钻取第一个任务', createDomHostAdapter({ getUrl: () => '/nested' }), '发布这个 Epic 下的第一个任务是什么？点开看它的详情再告诉我');
  console.log(`  >>> 详情区：${document.querySelector('[data-agent-surface="detail"]')?.textContent}；outcome=${outcome(steps)}`);
}

if (which === 'all' || which === 'nav') await nav();
if (which === 'all' || which === 'page') await page();
if (which === 'all' || which === 'nest') await nest();

console.log('\n=== 判定要点 ===');
console.log('① 导航：模型 open_item 传对 id、跳转后读到「条目2 详情」、completed。');
console.log('② 分页：模型翻页后读到「第2/2页」、答全4项、completed。');
console.log('③ 嵌套：模型 openObject 钻到 task:11、详情区出现「写 README」、completed。');
process.exit(0);
