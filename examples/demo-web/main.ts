// Attest 可视 demo：agent 在浏览器内驱动左半屏真实 DOM，右半屏逐条落证据。
// LLM 经 vite 代理（/api → DeepSeek，key 在 dev server 进程里，不进浏览器）。
import { createAgent, type AgentStep } from '../../src/core/loop';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';
import { createOpenAiAdapter } from '../../src/llm/openaiAdapter';
import { WorldModel } from '../../src/memory/worldModel';
import type { Intent } from '../../src/honesty/types';

// ── 左半屏：工单工作台的页面行为（一张普通的契约页，与 agent 无关的"业务代码"）──
interface Ticket { id: number; title: string; detail: string; done: boolean }
const tickets: Ticket[] = [
  { id: 101, title: '登录页 500 错误', detail: '生产环境登录接口在高峰期返回 500，疑似连接池耗尽。', done: false },
  { id: 102, title: '导出 CSV 乱码', detail: 'Excel 打开导出的 CSV 中文乱码，需要 BOM 头。', done: false },
  { id: 103, title: '移动端按钮错位', detail: 'iOS Safari 上主按钮被底部安全区遮挡。', done: true },
  { id: 104, title: '搜索结果分页丢参', detail: '翻页后丢失筛选条件，回到全量结果。', done: false },
];
let selected: Ticket | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const listEl = $('ticket-list');
const detailEl = $('detail');
const statusEl = $('status');

function renderTickets(): void {
  listEl.innerHTML = '';
  for (const t of tickets) {
    const li = document.createElement('li');
    li.setAttribute('data-agent-object', `ticket:${t.id}`);
    li.className = selected?.id === t.id ? 'selected' : '';
    li.innerHTML =
      `<span class="t-id">#${t.id}</span><span class="t-title">${t.title}</span>` +
      `<span class="t-chip ${t.done ? 'done' : 'open'}">${t.done ? '已解决' : '未解决'}</span>`;
    li.addEventListener('click', () => {
      selected = t;
      detailEl.textContent = `#${t.id} ${t.title} —— ${t.detail}（状态：${t.done ? '已解决' : '未解决'}）`;
      renderTickets();
    });
    listEl.appendChild(li);
  }
}

$('btn-resolve').addEventListener('click', () => {
  if (!selected) { statusEl.textContent = '未选中工单，无法解决。'; return; }
  selected.done = true;
  statusEl.textContent = `工单 #${selected.id} 已标记为已解决。`;
  detailEl.textContent = `#${selected.id} ${selected.title} —— ${selected.detail}（状态：已解决）`;
  renderTickets();
});
$('btn-archive').addEventListener('click', () => {
  const open = tickets.filter((t) => !t.done).length;
  statusEl.textContent = open > 0
    ? `无法归档：还有 ${open} 个未解决工单。请先全部解决。`
    : '看板已归档。';
});
$('btn-clear').addEventListener('click', () => {
  tickets.length = 0;
  selected = null;
  detailEl.textContent = '（看板已被清空）';
  statusEl.textContent = '已清空全部工单。';
  renderTickets();
});
renderTickets();

// ── 右半屏：证据面板渲染 ──
const tape = $('tape');
const dot = $('live-dot');

function entry(cls: string, pin: string, html: string): HTMLElement {
  const li = document.createElement('li');
  li.className = `entry ${cls}`;
  li.innerHTML = `<span class="pin">${pin}</span><div class="body">${html}</div>`;
  tape.appendChild(li);
  tape.scrollTop = tape.scrollHeight;
  return li;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function renderStep(s: AgentStep): void {
  switch (s.type) {
    case 'observation':
      entry('observe', '·', `<span class="meta">observe</span> ${esc(s.tool)}${s.refId ? `(${esc(s.refId)})` : ''}`);
      break;
    case 'action': {
      const badge = s.verified ? '<span class="badge v">VERIFIED</span>' : '<span class="badge u">UNVERIFIED</span>';
      const ev = s.evidence.map((e) => `<div class="evidence">${esc(e)}</div>`).join('');
      entry(`action${s.verified ? '' : ' unverified'}`, s.verified ? '✓' : '△', `${esc(s.tool)}(${esc(s.refId)})${badge}${ev}`);
      break;
    }
    case 'held':
      entry('held', '◉', `<span class="meta">HELD</span> ${esc(s.intent.label)} —— 等待用户确认`);
      break;
    case 'cancelled':
      entry('cancelled', '✕', `<span class="meta">CANCELLED</span> ${esc(s.refId)}：${esc(s.reason)}`);
      break;
    case 'error':
      entry('error', '⚠', `<span class="meta">ERROR</span> ${esc(s.tool)}：${esc(s.error)}`);
      break;
    case 'speculate':
      entry('speculate', '⚡', `<span class="meta">predict</span> ${esc(s.tool)} ${s.hit ? '命中，连续执行' : '落空'}`);
      break;
    case 'mispredict':
      entry('speculate', '↻', `<span class="meta">mispredict</span> 预测落空，回到模型重规划`);
      break;
    case 'drift':
      entry('error', '≠', `<span class="meta">DRIFT</span> ${esc(s.refId ?? s.tool)} 行为漂移：已知效果不再发生`);
      break;
    case 'thinking':
      entry('observe', '…', `<span class="meta">${esc(s.text)}</span>`);
      break;
    case 'plan':
      entry('observe', '▸', `<span class="meta">计划</span> ${esc(s.items.join('；'))}`);
      break;
    case 'finish': {
      const li = document.createElement('li');
      const facts = s.facts;
      const details = [
        ...facts.verified.map((w) => `✓ ${w.tool}(${w.refId})：${w.evidence.join('; ')}`),
        ...facts.cancelled.map((c) => `✕ ${c.label ?? c.refId}（用户拒绝，未执行）`),
        ...facts.unverified.map((w) => `△ ${w.tool}(${w.refId}) 未检测到变化`),
        ...facts.writeErrors.map((e) => `⚠ ${e.tool}：${e.detail}`),
      ];
      li.innerHTML =
        `<div class="finish-card">` +
        `<span class="stamp ${s.outcome}">${s.outcome.toUpperCase()}</span>` +
        `<div class="finish-narration"><span class="who">NARRATION · 模型原话，一字未改</span>${esc(s.narration)}</div>` +
        `<div class="finish-facts"><span class="who">FACTS · 由证据账本生成，模型不可篡改</span>${esc(facts.summary)}。` +
        (details.length ? `<ul>${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '') +
        `</div></div>`;
      tape.appendChild(li);
      tape.scrollTop = tape.scrollHeight;
      break;
    }
  }
}

// ── held 确认：意向回执 ──
const veil = $('veil');
function confirmIntent(intent: Intent): Promise<{ approved: boolean; scope?: 'once' | 'all' }> {
  $('receipt-label').textContent = intent.label;
  veil.hidden = false;
  return new Promise((resolve) => {
    const done = (approved: boolean, scope?: 'once' | 'all') => {
      veil.hidden = true;
      ok1.removeEventListener('click', onOnce); okA.removeEventListener('click', onAll); no.removeEventListener('click', onDeny);
      resolve({ approved, scope });
    };
    const ok1 = $('ok-once'), okA = $('ok-all'), no = $('deny');
    const onOnce = () => done(true, 'once');
    const onAll = () => done(true, 'all');
    const onDeny = () => done(false);
    ok1.addEventListener('click', onOnce); okA.addEventListener('click', onAll); no.addEventListener('click', onDeny);
  });
}

// ── agent 接线 ──
const WM_KEY = 'attest-demo-worldmodel';
let worldModel: WorldModel;
try { worldModel = WorldModel.fromJSON(JSON.parse(localStorage.getItem(WM_KEY) ?? 'null')); }
catch { worldModel = new WorldModel(); }

const host = createDomHostAdapter({ root: $('workbench'), getUrl: () => '/board' });
const llm = createOpenAiAdapter({
  apiKey: 'proxied-by-dev-server',
  baseUrl: '/api',
  model: new URLSearchParams(location.search).get('model') ?? 'deepseek-v4-pro',
});

const form = $('ask-form') as unknown as HTMLFormElement;
const input = $('ask-input') as unknown as HTMLInputElement;
const btn = $('ask-btn') as unknown as HTMLButtonElement;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = input.value.trim();
  if (!task || btn.disabled) return;
  input.value = '';
  btn.disabled = true;
  dot.classList.add('live');
  document.querySelector('.tape-hint')?.remove();
  entry('task', '»', esc(task));
  try {
    const agent = createAgent({ llm, host, confirm: confirmIntent, worldModel, maxSteps: 14 });
    for await (const step of agent.run(task)) renderStep(step);
    localStorage.setItem(WM_KEY, JSON.stringify(worldModel.toJSON()));
  } catch (err) {
    entry('error', '⚠', `<span class="meta">FATAL</span> ${esc(err instanceof Error ? err.message : String(err))}`);
  } finally {
    btn.disabled = false;
    dot.classList.remove('live');
  }
});
