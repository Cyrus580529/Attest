// Attest 交互式 REPL —— 手动验收用。
// 跑法（PowerShell）：
//   $env:ATTEST_API_KEY="可用key"; $env:ATTEST_BASE_URL="https://www.kamiapi.top/v1"; $env:ATTEST_MODEL="gpt-5.5"; npm run repl
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// happy-dom 注册会用"浏览器式 fetch"（强制同源/CORS）覆盖全局 fetch，
// 会拦截跨域的 LLM 请求。先抓住 Node 原生 fetch（无 CORS），专给 LLM 调用用。
const nodeFetch = globalThis.fetch;
GlobalRegistrator.register();

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.openai.com/v1';
const model = process.env.ATTEST_MODEL ?? 'gpt-5.5';

if (!key) {
  console.error('请先设置 ATTEST_API_KEY（PowerShell: $env:ATTEST_API_KEY="sk-..."）');
  process.exit(1);
}

// 在 happy-dom 注册后再加载内核
const { createAgent } = await import('../src/core/loop');
const { createDomHostAdapter } = await import('../src/adapters/domHostAdapter');
const { createOpenAiAdapter } = await import('../src/llm/openaiAdapter');
const { PageMemory } = await import('../src/memory/pageMemory');

const html = readFileSync(resolve(process.cwd(), 'examples/mini-board/index.html'), 'utf8');
const rl = readline.createInterface({ input, output });

function loadBoard(): void {
  document.body.innerHTML = html.replace(/[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*/i, '');
  const detail = document.querySelector('[data-agent-surface="detail"]')!;
  document.querySelectorAll('[data-agent-object]').forEach((li) => {
    li.addEventListener('click', () => {
      detail.textContent = `详情：${li.textContent?.trim()} —— 复现步骤、影响范围、负责人见此。`;
    });
  });
  document.querySelector('[data-agent-action="resolve"]')!.addEventListener('click', () => {
    detail.textContent = '✅ 该工单已标记为已解决。';
  });
}

let memory: InstanceType<typeof PageMemory> | undefined = new PageMemory();

function show(s: Record<string, unknown>): void {
  const t = s.type as string;
  if (t === 'finish') {
    console.log(`\x1b[1mFINISH [${String(s.outcome)}]\x1b[0m ${String(s.answer)}`);
    const ledger = s.ledger as { kind: string }[];
    console.log(`  账本: ${ledger.map((e) => e.kind).join(' → ') || '(空)'}`);
  } else if (t === 'action') {
    const ev = s.evidence as string[];
    console.log(`  action ${String(s.tool)}(${String(s.refId)}) verified=${String(s.verified)} 证据=[${ev.join('; ')}]`);
  } else if (t === 'replay') {
    console.log(`  \x1b[33m⚡replay\x1b[0m ${String(s.tool)}${s.refId ? `(${String(s.refId)})` : ''}  ← 记忆，零 LLM`);
  } else if (t === 'observation') {
    console.log(`  observe ${String(s.tool)}${s.refId ? `(${String(s.refId)})` : ''}`);
  } else if (t === 'held') {
    console.log(`  \x1b[31mheld\x1b[0m ${String((s.intent as { label: string }).label)}`);
  } else if (t === 'cancelled') {
    console.log(`  cancelled ${String(s.refId)}`);
  } else {
    console.log(`  error ${String(s.tool)}: ${String(s.error)}`);
  }
}

function makeAgent() {
  return createAgent({
    llm: createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch }),
    host: createDomHostAdapter({ getUrl: () => '/board' }),
    memory,
    confirm: async (intent) => {
      const a = await rl.question(`  ⚠️ 高危「${intent.label}」执行吗？(y/N) `);
      return { approved: a.trim().toLowerCase() === 'y' };
    },
  });
}

console.log(`\nAttest REPL  |  ${baseUrl} / ${model}  |  记忆:开`);
console.log('命令: /reset 重置页面 | /memory 开关记忆 | /quit 退出 | 其它=对 agent 说话');
console.log('示范页: 3 个工单(ticket) + open + resolve(高危) + detail\n');
loadBoard();

for (;;) {
  const line = (await rl.question('\x1b[36m你>\x1b[0m ')).trim();
  if (!line) continue;
  if (line === '/quit' || line === '/exit') break;
  if (line === '/reset') {
    loadBoard();
    console.log('（页面已重置）');
    continue;
  }
  if (line === '/memory') {
    memory = memory ? undefined : new PageMemory();
    console.log(`（记忆已${memory ? '开' : '关'}）`);
    continue;
  }
  try {
    for await (const step of makeAgent().run(line)) show(step as unknown as Record<string, unknown>);
  } catch (e) {
    console.log(`  [运行出错] ${(e as Error).message}`);
  }
}
rl.close();
