// 【可行性探针】从纯语义/ARIA 页面（零 data-agent-*）推断契约，真模型驱动。
// 跑法：$env:ATTEST_API_KEY=...; $env:ATTEST_BASE_URL="https://api.deepseek.com"; $env:ATTEST_MODEL="deepseek-v4-pro"; npx tsx examples/spike-infer.ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const nodeFetch = globalThis.fetch;
GlobalRegistrator.register();

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.ATTEST_MODEL ?? 'deepseek-v4-pro';
if (!key) { console.error('需要 ATTEST_API_KEY'); process.exit(1); }

const { createAgent } = await import('../src/core/loop');
const { createOpenAiAdapter } = await import('../src/llm/openaiAdapter');
const { inferContract } = await import('../src/contract/inferContract');
const { serializeSnapshot } = await import('../src/core/serialize');
import type { AgentStep } from '../src/core/loop';
import type { HostAdapter, HostResult } from '../src/host/types';
import type { PageSnapshot, Ref } from '../src/types';

// 纯语义/ARIA 任务面板——完全没有 data-agent-* 标注，模拟一个"普通"前端页面。
function buildSemanticPage(): void {
  document.body.innerHTML = `
    <header><h1>任务面板</h1></header>
    <main>
      <ul role="list" aria-label="任务列表">
        <li id="t1">登录超时 500</li>
        <li id="t2">支付回调失败</li>
        <li id="t3">导出 CSV 乱码</li>
      </ul>
      <form>
        <label for="assignee">指派给</label>
        <input id="assignee" name="assignee" value="" />
        <label for="priority">优先级</label>
        <select id="priority"><option value="low">低</option><option value="high">高</option></select>
        <button type="button" id="save">保存</button>
        <button type="button" id="del">删除选中</button>
      </form>
      <section role="region" aria-label="详情">请选择一个任务查看详情。</section>
      <output role="status">就绪</output>
    </main>`;

  let selected: HTMLElement | null = null;
  const region = document.querySelector('[role="region"]')!;
  const status = document.querySelector('[role="status"]')!;
  const assignee = () => (document.getElementById('assignee') as HTMLInputElement).value;
  document.querySelectorAll('li').forEach((li) =>
    li.addEventListener('click', () => {
      selected = li as HTMLElement;
      region.textContent = `详情：${li.textContent?.trim()} — 负责人:${assignee() || '未指派'}`;
    }),
  );
  document.getElementById('save')!.addEventListener('click', () => {
    status.textContent = selected ? `已保存：${selected.textContent?.trim()} → ${assignee() || '(空)'}` : '⚠️ 未选择';
  });
  document.getElementById('del')!.addEventListener('click', () => {
    if (!selected) { status.textContent = '⚠️ 未选择'; return; }
    const t = selected.textContent?.trim();
    selected.remove(); selected = null;
    status.textContent = `🗑️ 已删除：${t}`;
  });
}

// 用 inferContract 的 host 适配器（仿 domHostAdapter）。
function createInferHost(): HostAdapter {
  let current: PageSnapshot = { url: '/board', objects: [], actions: [], controls: [], surfaces: [] };
  let elements = new Map<string, Element>();
  const refresh = (): PageSnapshot => {
    const r = inferContract(document.body, '/board');
    current = r.snapshot; elements = r.elements; return current;
  };
  const click = (ref: Ref): HostResult => {
    const el = elements.get(ref.id);
    if (!el) return { ok: false, snapshot: current, note: 'not found' };
    (el as HTMLElement).click();
    return { ok: true, snapshot: refresh() };
  };
  return {
    snapshot: () => refresh(),
    readSurface: (ref) => current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '',
    openObject: (ref) => Promise.resolve(click(ref)),
    navigate: (ref) => Promise.resolve(click(ref)),
    setControl: (ref, value) => {
      const el = elements.get(ref.id);
      if (el && 'value' in el) {
        (el as HTMLInputElement).value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return Promise.resolve({ ok: !!el, snapshot: refresh() });
    },
    invokeAction: (ref) => Promise.resolve(click(ref)),
  };
}

function show(s: AgentStep): void {
  if (s.type === 'thinking') console.log(`  💭 ${s.text}`);
  else if (s.type === 'plan') console.log(`  ▸ 计划：${s.items.join('；')}`);
  else if (s.type === 'finish') { console.log(`  FINISH [${s.outcome}] ${s.answer}`); console.log(`    账本：${s.ledger.map((e) => e.kind).join(' → ')}`); }
  else if (s.type === 'action') console.log(`  action ${s.tool}(${s.refId}) verified=${s.verified}`);
  else if (s.type === 'held') console.log(`  held ${s.intent.label}`);
  else if (s.type === 'cancelled') console.log(`  ✕ cancelled ${s.refId}`);
  else if (s.type === 'observation') console.log(`  observe ${s.tool}${s.refId ? `(${s.refId})` : ''}`);
  else if (s.type === 'error') console.log(`  ⚠️ error ${s.tool}: ${s.error}`);
}

async function drive(label: string, msg: string, approve: boolean): Promise<AgentStep[]> {
  buildSemanticPage();
  const agent = createAgent({
    llm: createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch }),
    host: createInferHost(),
    codeAsAction: true,
    maxSteps: 6,
    confirm: (i) => { console.log(`  [HELD→${approve ? '批准' : '拒绝'}] ${i.label}`); return Promise.resolve({ approved: approve, scope: 'all' }); },
  });
  console.log(`\n── ${label} ──\n用户> ${msg}`);
  const steps: AgentStep[] = [];
  for await (const s of agent.run(msg)) { steps.push(s); show(s); }
  return steps;
}

// 1) 先把推断出的契约打印出来，肉眼看它 sensible 不
buildSemanticPage();
console.log('=== 推断出的契约（来自纯语义页，无 data-agent-*）===');
console.log(serializeSnapshot(inferContract(document.body, '/board').snapshot));

if (process.argv[2] === 'infer-only') process.exit(0);

try {
  await drive('读取：有哪些任务 + 读"支付"详情', '这个页面上有哪些任务？把讲"支付"的那个任务的详情读出来告诉我。', true);
  await drive('表单+动作：指派并保存', '把"登录超时"指派给 Alice 并保存。', true);
  await drive('高危：删除选中（应 held）', '先选中"导出 CSV 乱码"，然后删除它。', false);
  console.log('\n=== 完成 ===');
} catch (e) {
  console.error(`\n[运行出错] ${(e as Error).message}`);
  process.exit(1);
}
process.exit(0);
