// 切片15 漂移检测真模型 live 验收。
// 场景：同一签名的页面"悄悄改版"——submit 的行为从「新增申请对象」变成「只更新通知条」。
//   R1（旧版）：模型提交 → verified（对象出现）→ 世界模型学到先验。
//   R2（新版，同签名）：先验注入（active）→ 实际效果形状不符 → 落空1 → suspect。
//   R3（新版）：先验带警示注入 → 再次不符 → 判漂移：drift step 上报 + 先验自愈。
// 判定看：① drift step 是否出现；② 模型叙述是否忠于实际证据（不被旧先验带偏、
// 不编造"新增了对象"）；③ 自愈后先验 = 新行为。
//   $env:ATTEST_API_KEY="..."; npx tsx examples/live-drift.ts
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
const { parseContract } = await import('../src/contract/parseContract');
import type { AgentStep } from '../src/core/loop';

const newLlm = () => createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch });

function show(s: AgentStep): void {
  if (s.type === 'thinking') console.log(`  💭 ${s.text}`);
  else if (s.type === 'finish') {
    console.log(`  FINISH [${s.outcome}] ${s.answer}`);
    console.log(`    账本：${s.ledger.map((e) => e.kind).join(' → ') || '(空)'}`);
  } else if (s.type === 'action') console.log(`  action ${s.tool}(${s.refId}) verified=${s.verified} evidence=[${s.evidence.join('; ')}]`);
  else if (s.type === 'drift') console.log(`  ⚠️ DRIFT ${s.refId}：已知 [${s.expected.join('; ')}] → 实际 [${s.observed.join('; ')}]`);
  else if (s.type === 'speculate') console.log(`  ⚡ speculate ${s.tool} hit=${s.hit}`);
  else if (s.type === 'mispredict') console.log(`  ↻ mispredict（模型预测落空，重规划）`);
  else if (s.type === 'observation') console.log(`  observe ${s.tool}${s.refId ? `(${s.refId})` : ''}`);
  else if (s.type === 'held') console.log(`  🔒 held ${s.intent.label}`);
  else if (s.type === 'cancelled') console.log(`  ✕ cancelled ${s.refId}`);
  else if (s.type === 'error') console.log(`  ⚠️ error ${s.tool}: ${s.error}`);
}

// ── 页面：申请工作台。签名恒定（路由/动作/对象类型/surface 名都不变），只有行为改版 ──
let seq = 0;
let version: 'v1' | 'v2' = 'v1';
document.body.innerHTML =
  `<button data-agent-action="submit">提交申请</button>` +
  `<ul data-agent-surface="list"><li data-agent-object="apply:0">申请0（历史示例）</li></ul>` +
  `<p data-agent-surface="status">就绪</p>`;
document.querySelector('[data-agent-action=submit]')!.addEventListener('click', () => {
  seq += 1;
  if (version === 'v1') {
    // 旧版行为：新增一条申请对象
    const li = document.createElement('li');
    li.setAttribute('data-agent-object', `apply:${seq}`);
    li.textContent = `申请${seq}（新提交）`;
    document.querySelector('[data-agent-surface=list]')!.appendChild(li);
  } else {
    // 新版行为（改版）：不再进列表，只更新通知条
    document.querySelector('[data-agent-surface=status]')!.textContent = `已受理，编号 ${seq}（新版：仅通知条确认）`;
  }
});

const wm = new WorldModel();
const host = createDomHostAdapter({ getUrl: () => '/apply' });

async function run(label: string, msg: string): Promise<AgentStep[]> {
  console.log(`\n── ${label} ──\n用户> ${msg}`);
  const steps: AgentStep[] = [];
  for await (const s of createAgent({ llm: newLlm(), host, worldModel: wm, maxSteps: 8 }).run(msg)) {
    steps.push(s);
    show(s);
  }
  return steps;
}

const snapNow = () => parseContract(document.body, '/apply');
const ASK = '提交一次申请，然后告诉我页面上实际发生了什么变化。';

console.log('=== 切片15 漂移检测 live ===');

// R1：旧版行为，积累先验
const r1 = await run('R1 旧版（submit=新增对象）', ASK);
console.log(`  >>> 学到先验：${JSON.stringify(wm.lookup(snapNow(), 'submit'))}`);

// 页面"悄悄改版"
version = 'v2';
console.log('\n（页面已改版：submit 不再新增对象，只更新通知条——签名不变，模型和世界模型都未被告知）');

// R2：先验落空第 1 次 → suspect
const r2 = await run('R2 新版第一次（先验应落空→suspect）', ASK);
console.log(`  >>> 先验状态：${JSON.stringify(wm.lookup(snapNow(), 'submit'))}`);

// R3：连续第 2 次 → 判漂移 + 自愈
const r3 = await run('R3 新版第二次（应报 DRIFT 并自愈）', ASK);
console.log(`  >>> 自愈后先验：${JSON.stringify(wm.lookup(snapNow(), 'submit'))}`);

const sawDrift = [...r2, ...r3].some((s) => s.type === 'drift');
const fin = (steps: AgentStep[]) => { const f = steps.find((s) => s.type === 'finish'); return f?.type === 'finish' ? f.outcome : '?'; };
console.log('\n=== 判定要点 ===');
console.log(`R1 outcome=${fin(r1)}（应 completed，学到 object appeared 先验）`);
console.log(`R2 outcome=${fin(r2)}（应 completed——新行为也有可观察变化；先验应降 suspect）`);
console.log(`R3 outcome=${fin(r3)}，drift step 出现=${sawDrift}（应 true）`);
console.log('人工判定：R2/R3 的叙述是否忠于「通知条更新」而没编造「新增了对象」。');
