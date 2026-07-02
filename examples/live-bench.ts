// 先验净收益 live A/B：同一任务，冷启动（无世界模型）vs 带先验（上一遍学到的世界模型）。
// 计量：LLM 往返数、prompt/completion token（从 API usage 截取）、predict 命中、
// 每回合平均工具调用数（批量度=模型敢不敢一次想更远）、outcome。
// 设计：每组（rep）用全新 WorldModel——冷跑训练它，暖跑消费它；页面在两跑之间重置。
//   $env:ATTEST_API_KEY="..."; npx tsx examples/live-bench.ts [reps]
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const nodeFetch = globalThis.fetch;
GlobalRegistrator.register();

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.ATTEST_MODEL ?? 'deepseek-v4-pro';
if (!key) { console.error('需要 ATTEST_API_KEY'); process.exit(1); }
const REPS = Number(process.argv[2] ?? '3');

const { createAgent } = await import('../src/core/loop');
const { createDomHostAdapter } = await import('../src/adapters/domHostAdapter');
const { createOpenAiAdapter } = await import('../src/llm/openaiAdapter');
const { WorldModel } = await import('../src/memory/worldModel');
import type { AgentStep } from '../src/core/loop';
import type { LlmAdapter } from '../src/llm/types';

interface Metrics {
  rounds: number;      // LLM 往返（adapter.step 次数）
  requests: number;    // HTTP 请求数（含重试；= rounds 说明无重试噪音）
  prompt: number;      // prompt tokens（API usage）
  completion: number;  // completion tokens
  toolCalls: number;   // 工具调用总数
  specTotal: number;   // predict 尝试数
  specHits: number;    // predict 命中数
  verified: number;    // verified 写数
  outcome: string;
  wallMs: number;
}

async function runOne(setupPage: () => void, ask: string, wm: InstanceType<typeof WorldModel> | undefined): Promise<Metrics> {
  setupPage();
  const m: Metrics = { rounds: 0, requests: 0, prompt: 0, completion: 0, toolCalls: 0, specTotal: 0, specHits: 0, verified: 0, outcome: '?', wallMs: 0 };
  const meteredFetch: typeof fetch = async (input, init) => {
    m.requests += 1;
    const res = await nodeFetch(input, init);
    try {
      const j = (await res.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (j?.usage) { m.prompt += j.usage.prompt_tokens ?? 0; m.completion += j.usage.completion_tokens ?? 0; }
    } catch { /* 非 JSON 响应不计 */ }
    return res;
  };
  const base = createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: meteredFetch });
  const llm: LlmAdapter = { step: (msgs, tools) => { m.rounds += 1; return base.step(msgs, tools); } };
  const host = createDomHostAdapter({ getUrl: () => '/bench' });

  const t0 = Date.now();
  for await (const s of createAgent({ llm, host, worldModel: wm, maxSteps: 10 }).run(ask)) {
    const step = s as AgentStep;
    if (step.type === 'action') { m.toolCalls += 1; if (step.verified) m.verified += 1; }
    else if (step.type === 'observation') m.toolCalls += 1;
    else if (step.type === 'speculate') { m.specTotal += 1; if (step.hit) m.specHits += 1; }
    else if (step.type === 'finish') m.outcome = step.outcome;
  }
  m.wallMs = Date.now() - t0;
  return m;
}

// ── 任务定义（低危、可验证、多步）──
const T1 = {
  name: 'T1 三连动作（3 个独立完成键）',
  ask: '把三个任务都标记完成。',
  setup: () => {
    document.body.innerHTML =
      `<ul data-agent-surface="board">` +
      `<li data-agent-object="task:1">任务1：写文档【未完成】</li>` +
      `<li data-agent-object="task:2">任务2：修按钮【未完成】</li>` +
      `<li data-agent-object="task:3">任务3：发通知【未完成】</li></ul>` +
      `<button data-agent-action="done1">完成任务1</button>` +
      `<button data-agent-action="done2">完成任务2</button>` +
      `<button data-agent-action="done3">完成任务3</button>` +
      `<p data-agent-surface="count">已完成 0/3</p>`;
    let done = 0;
    for (const n of [1, 2, 3]) {
      document.querySelector(`[data-agent-action=done${n}]`)!.addEventListener('click', () => {
        const li = document.querySelector(`[data-agent-object="task:${n}"]`)!;
        if (!li.textContent!.includes('【已完成】')) {
          li.textContent = li.textContent!.replace('【未完成】', '【已完成】');
          done += 1;
          document.querySelector('[data-agent-surface=count]')!.textContent = `已完成 ${done}/3`;
        }
      });
    }
  },
};

const T2 = {
  name: 'T2 表单（两控件+提交）',
  ask: '名称填 Alice，数量填 3，然后提交。',
  setup: () => {
    document.body.innerHTML =
      `<label>名称<input data-agent-control="name" value=""/></label>` +
      `<label>数量<input data-agent-control="qty" value="0"/></label>` +
      `<button data-agent-action="submit">提交</button>` +
      `<p data-agent-surface="status">未提交</p>`;
    document.querySelector('[data-agent-action=submit]')!.addEventListener('click', () => {
      const name = (document.querySelector('[data-agent-control=name]') as HTMLInputElement).value;
      const qty = (document.querySelector('[data-agent-control=qty]') as HTMLInputElement).value;
      document.querySelector('[data-agent-surface=status]')!.textContent = `已提交：${name} × ${qty}`;
    });
  },
};

function fmt(m: Metrics): string {
  return `rounds=${m.rounds} req=${m.requests} tok=${m.prompt}+${m.completion} tools=${m.toolCalls} predict=${m.specHits}/${m.specTotal} verified=${m.verified} outcome=${m.outcome} ${(m.wallMs / 1000).toFixed(1)}s`;
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log(`=== 先验净收益 live A/B（${model}，reps=${REPS}）===`);
const summary: Record<string, { cold: Metrics[]; warm: Metrics[] }> = {};

for (const task of [T1, T2]) {
  console.log(`\n## ${task.name}`);
  summary[task.name] = { cold: [], warm: [] };
  for (let rep = 1; rep <= REPS; rep++) {
    const wm = new WorldModel();
    const cold = await runOne(task.setup, task.ask, wm); // 冷：无先验（此跑训练 wm）
    console.log(`  rep${rep} 冷: ${fmt(cold)}`);
    const warm = await runOne(task.setup, task.ask, wm); // 暖：带上一跑学到的先验
    console.log(`  rep${rep} 暖: ${fmt(warm)}`);
    summary[task.name]!.cold.push(cold);
    summary[task.name]!.warm.push(warm);
  }
}

console.log('\n=== 汇总（均值）===');
for (const [name, s] of Object.entries(summary)) {
  const line = (arr: Metrics[]) =>
    `rounds=${avg(arr.map((x) => x.rounds)).toFixed(2)} tok=${avg(arr.map((x) => x.prompt + x.completion)).toFixed(0)} ` +
    `批量度=${avg(arr.map((x) => x.toolCalls / x.rounds)).toFixed(2)} predict命中=${avg(arr.map((x) => x.specHits)).toFixed(2)}/${avg(arr.map((x) => x.specTotal)).toFixed(2)} ` +
    `completed=${arr.filter((x) => x.outcome === 'completed').length}/${arr.length}`;
  console.log(`${name}`);
  console.log(`  冷: ${line(s.cold)}`);
  console.log(`  暖: ${line(s.warm)}`);
}
process.exit(0);
