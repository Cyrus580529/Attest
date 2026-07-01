// Route B benchmark 运行骨架 —— 用真实浏览器(Playwright)驱动真实站点(WebArena/ST-WebAgentBench),
// 由 Attest 信任核心执行 + verify + held + 账本裁决 outcome,再交你的评分器判分。
//
// 前置(你的机器):
//   npm i && npx playwright install chromium
//   起 WebArena / ST-WebAgentBench 应用(Docker),拿到任务 URL 与评分器
//   $env:ATTEST_API_KEY="..."; $env:ATTEST_BASE_URL="https://api.deepseek.com"; $env:ATTEST_MODEL="deepseek-v4-pro"
//   npx tsx examples/bench-run.ts
//
// 沙箱里跑不了(需浏览器 + Docker)——本文件保证逻辑清楚、结构正确,真跑在你侧。
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const nodeFetch = globalThis.fetch; // happy-dom 注册前抓 Node 原生 fetch(给 LLM,绕 CORS)
GlobalRegistrator.register(); // 只为拿 Node 侧 DOMParser 来解析 page.content();Playwright 是独立浏览器进程,不受影响

const { chromium } = await import('playwright');
const { createAgent } = await import('../src/core/loop');
const { createBrowserHostAdapter } = await import('../src/adapters/browserHostAdapter');
const { createOpenAiAdapter } = await import('../src/llm/openaiAdapter');
import type { BrowserPage } from '../src/adapters/browserPage';
import type { AgentStep } from '../src/core/loop';
import type { ConfirmFn } from '../src/honesty/types';

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.ATTEST_MODEL ?? 'deepseek-v4-pro';
if (!key) { console.error('需要 ATTEST_API_KEY'); process.exit(1); }

/** page.content() 的 HTML → 可 querySelector 的 DOM(Node 侧用 happy-dom 的 DOMParser)。 */
const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html');

/**
 * 任务集：填你的 WebArena / ST-WebAgentBench 任务。
 * safeConfirm 用于控制 confirm 策略——注意真实页动作皆 inferred → 一律 held:
 *   · 测「完成率」：自动批准(下方 AUTO_APPROVE)。
 *   · 测「用户确认/安全」维度：按策略拒绝违规动作(held 恰是 Attest 的强项)。
 */
interface BenchTask {
  id: string;
  url: string;
  goal: string;
  confirm?: ConfirmFn;
}
const AUTO_APPROVE: ConfirmFn = () => Promise.resolve({ approved: true, scope: 'all' });

const TASKS: BenchTask[] = [
  // 示例(替换为真实任务 URL/目标)：
  // { id: 'wa-1', url: 'http://localhost:7770/', goal: '把购物车里的第一件商品数量改为 2', confirm: AUTO_APPROVE },
];

function show(s: AgentStep): void {
  if (s.type === 'finish') {
    console.log(`  FINISH [${s.outcome}] ${s.answer}`);
    console.log(`    账本：${s.ledger.map((e) => e.kind).join(' → ') || '(空)'}`);
  } else if (s.type === 'action') console.log(`  action ${s.tool}(${s.refId}) verified=${s.verified}`);
  else if (s.type === 'held') console.log(`  🔒 held ${s.intent.label}`);
  else if (s.type === 'cancelled') console.log(`  ✕ cancelled ${s.refId}`);
  else if (s.type === 'speculate') console.log(`  ⚡ speculate ${s.tool} hit=${s.hit}`);
  else if (s.type === 'observation') console.log(`  observe ${s.tool}${s.refId ? `(${s.refId})` : ''}`);
  else if (s.type === 'error') console.log(`  ⚠️ error ${s.tool}: ${s.error}`);
}

/**
 * 评分：接你的权威评分器(ST-WebAgentBench: Completion-Under-Policy / Risk Ratio;WebArena: success checker)。
 * 这些是 Python——最简做法是子进程 shell-out(child_process.execFile)传任务 id + 最终页面状态,读回判分。
 * 此处先占位打印,你把它换成真评分调用。
 */
async function scoreTask(task: BenchTask, steps: AgentStep[]): Promise<void> {
  const fin = steps.find((s) => s.type === 'finish');
  const verifiedWrites = steps.filter((s) => s.type === 'action' && s.verified).length;
  const held = steps.filter((s) => s.type === 'held').length;
  const cancelled = steps.filter((s) => s.type === 'cancelled').length;
  console.log(
    `  >>> [${task.id}] outcome=${fin?.type === 'finish' ? fin.outcome : '?'}; ` +
      `verified 写=${verifiedWrites}; held=${held}; cancelled=${cancelled}`,
  );
  // TODO(你): 调 ST/WebArena 评分器：
  //   const { stdout } = await execFileP('python', ['eval.py', task.id]); console.log(stdout);
}

async function main(): Promise<void> {
  if (TASKS.length === 0) {
    console.error('TASKS 为空——请填入真实 WebArena/ST-WebAgentBench 任务(url/goal)。');
    process.exit(1);
  }
  const browser = await chromium.launch();
  try {
    for (const task of TASKS) {
      const page = await browser.newPage();
      await page.goto(task.url, { waitUntil: 'networkidle' });
      const host = createBrowserHostAdapter(page as unknown as BrowserPage, { parseHtml });
      await host.refresh(); // 初始化缓存快照

      console.log(`\n── [${task.id}] ${task.goal} ──`);
      const agent = createAgent({
        llm: createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch }),
        host,
        confirm: task.confirm ?? AUTO_APPROVE, // 真实页动作皆 inferred→held,完成率跑需自动批准
        maxSteps: 20,
      });
      const steps: AgentStep[] = [];
      for await (const s of agent.run(task.goal)) { steps.push(s); show(s); }
      await scoreTask(task, steps);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

await main();
process.exit(0);
