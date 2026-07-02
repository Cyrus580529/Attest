// finish 自评降级通道（goalMet）真模型 live 验收。
// 洞（外部评审点出）：diff 只证明"有效果"，不证明"业务成功"——写后页面弹出
// 错误文案同样是可验证变化，此前会被记成 completed。
// 场景：转账工作台，余额 100。转 500 → 页面显示"余额不足，转账失败"（surface 变化，
// verified=true 但业务失败）；转 50 → 真成功（产生交易对象）。
// 判定看：
//   S1 业务失败：outcome 应 failed（模型申报 goalMet:false），叙述如实转述错误文案。
//   S2 真成功：outcome 应 completed——检验模型不会反射性乱降级。
//   S3 程序模式业务失败：outcome 应 failed，且不得录入配方库。
//   $env:ATTEST_API_KEY="..."; npx tsx examples/live-goalmet.ts
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
const { RecipeBook } = await import('../src/memory/recipeBook');
import type { AgentStep } from '../src/core/loop';

const newLlm = () => createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch });

function show(s: AgentStep): void {
  if (s.type === 'thinking') console.log(`  💭 ${s.text}`);
  else if (s.type === 'finish') {
    console.log(`  FINISH [${s.outcome}] ${s.answer}`);
    console.log(`    账本：${s.ledger.map((e) => e.kind).join(' → ') || '(空)'}`);
  } else if (s.type === 'action') console.log(`  action ${s.tool}(${s.refId}) verified=${s.verified} evidence=[${s.evidence.join('; ')}]`);
  else if (s.type === 'observation') console.log(`  observe ${s.tool}${s.refId ? `(${s.refId})` : ''}`);
  else if (s.type === 'plan') console.log(`  plan: ${s.items.join(' / ')}`);
  else if (s.type === 'held') console.log(`  🔒 held ${s.intent.label}`);
  else if (s.type === 'cancelled') console.log(`  ✕ cancelled ${s.refId}`);
  else if (s.type === 'error') console.log(`  ⚠️ error ${s.tool}: ${s.error}`);
}

// ── 页面：转账工作台，余额 100 ──
let txSeq = 0;
function resetPage(): void {
  document.body.innerHTML =
    `<input data-agent-control="amount" value="" />` +
    `<button data-agent-action="transfer">发起转账</button>` +
    `<p data-agent-surface="status">就绪。当前余额 100 元。</p>` +
    `<ul data-agent-surface="history"></ul>`;
  document.querySelector('[data-agent-action=transfer]')!.addEventListener('click', () => {
    const amount = Number((document.querySelector('[data-agent-control=amount]') as HTMLInputElement).value) || 0;
    const status = document.querySelector('[data-agent-surface=status]')!;
    if (amount > 100) {
      status.textContent = `转账失败：余额不足（余额 100 元，尝试转出 ${amount} 元）。`;
    } else {
      txSeq += 1;
      status.textContent = `转账成功：已转出 ${amount} 元。`;
      const li = document.createElement('li');
      li.setAttribute('data-agent-object', `tx:${txSeq}`);
      li.textContent = `交易${txSeq}：转出 ${amount} 元`;
      document.querySelector('[data-agent-surface=history]')!.appendChild(li);
    }
  });
}

const host = createDomHostAdapter({ getUrl: () => '/transfer' });

async function run(label: string, msg: string, opts: { codeAsAction?: boolean; recipes?: InstanceType<typeof RecipeBook> } = {}): Promise<AgentStep[]> {
  console.log(`\n── ${label} ──\n用户> ${msg}`);
  resetPage();
  const steps: AgentStep[] = [];
  const agent = createAgent({ llm: newLlm(), host, maxSteps: 8, ...opts });
  for await (const s of agent.run(msg)) {
    steps.push(s);
    show(s);
  }
  return steps;
}

const fin = (steps: AgentStep[]) => steps.find((s): s is Extract<AgentStep, { type: 'finish' }> => s.type === 'finish');

console.log('=== finish 自评降级（goalMet）live ===');

const s1 = await run('S1 业务失败（读循环）', '给收款人转 500 元，然后告诉我结果。');
const s2 = await run('S2 真成功（对照，不该乱降级）', '给收款人转 50 元，然后告诉我结果。');
const recipes = new RecipeBook();
const s3 = await run('S3 业务失败（程序模式）', '给收款人转 500 元，然后告诉我结果。', { codeAsAction: true, recipes });

console.log('\n=== 判定要点 ===');
console.log(`S1 outcome=${fin(s1)?.outcome}（应 failed：写 verified 但页面显示余额不足，模型应报 goalMet:false）`);
console.log(`S2 outcome=${fin(s2)?.outcome}（应 completed：真成功不许被反射性降级）`);
console.log(`S3 outcome=${fin(s3)?.outcome}（应 failed），配方库条数=${recipes.recall((await import('../src/memory/pageSignature')).pageSignature(host.snapshot()), 3).length}（应 0：业务失败的程序不入库）`);
console.log('人工判定：S1/S3 的叙述是否如实转述"余额不足"，而不是宣称转账完成。');
