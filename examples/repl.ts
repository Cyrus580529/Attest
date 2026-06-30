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
let programMode = false; // Code-as-Action 开关（/code 切换）

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function show(s: Record<string, unknown>): void {
  const t = s.type as string;
  if (t === 'thinking') {
    console.log(`\x1b[2m💭 ${String(s.text)}\x1b[0m`);
  } else if (t === 'plan') {
    const items = s.items as string[];
    if (items.length === 1) console.log(`\x1b[1m▸ ${items[0]}\x1b[0m`);
    else {
      console.log('\x1b[1m▸ 计划：\x1b[0m');
      items.forEach((it) => console.log(`   · ${it}`));
    }
  } else if (t === 'finish') {
    const labels: Record<string, string> = {
      completed: '\x1b[32m✅ 完成\x1b[0m',
      partial: '\x1b[33m⚠️ 部分完成\x1b[0m',
      cancelled: '\x1b[33m🚫 已取消\x1b[0m',
      failed: '\x1b[31m❌ 失败\x1b[0m',
    };
    console.log(`${labels[String(s.outcome)] ?? String(s.outcome)}  ${String(s.answer)}`);
    const ledger = s.ledger as { kind: string }[];
    console.log(`  账本: ${ledger.map((e) => e.kind).join(' → ') || '(空)'}`);
  } else if (t === 'action') {
    const ok = s.verified ? '\x1b[32m✓\x1b[0m 已完成' : '\x1b[31m✗\x1b[0m 已执行但';
    const tail = s.verified ? '（页面已确认变化）' : '未检测到可观察变化（未验证）';
    console.log(`  ${ok}${tail}`);
  } else if (t === 'replay') {
    console.log(`  \x1b[33m⚡replay\x1b[0m ${String(s.tool)}${s.refId ? `(${String(s.refId)})` : ''}  ← 记忆，零 LLM`);
  } else if (t === 'observation') {
    const what = s.tool === 'openObject' ? '已打开' : s.tool === 'readSurface' ? '已查看' : '已观察';
    console.log(`  \x1b[2m▸ ${what}\x1b[0m`);
  } else if (t === 'held') {
    console.log(`  \x1b[31mheld\x1b[0m ${String((s.intent as { label: string }).label)}`);
  } else if (t === 'cancelled') {
    console.log(`  \x1b[33m✕ 已取消（未执行该高危动作）\x1b[0m`);
  } else {
    console.log(`  error ${String(s.tool)}: ${String(s.error)}`);
  }
}

function makeAgent() {
  return createAgent({
    llm: createOpenAiAdapter({ apiKey: key, baseUrl, model, fetchImpl: nodeFetch }),
    host: createDomHostAdapter({ getUrl: () => '/board' }),
    // Code-as-Action 模式下不接记忆（本切片 defer）
    memory: programMode ? undefined : memory,
    codeAsAction: programMode,
    confirm: async (intent) => {
      const a = (
        await rl.question(`  ⚠️ 高危「${intent.label}」执行吗？(y=仅此次 / a=本程序全部同类 / N=拒绝) `)
      )
        .trim()
        .toLowerCase();
      if (a === 'a') return { approved: true, scope: 'all' };
      return { approved: a === 'y' };
    },
  });
}

console.log(`\nAttest REPL  |  ${baseUrl} / ${model}  |  记忆:开  |  模式:挤牙膏(单步)`);
console.log('命令: /reset 重置页面 | /memory 开关记忆 | /code 切换"交清单"模式(Code-as-Action) | /quit 退出 | 其它=对 agent 说话');
console.log('示范页: 3 个工单(ticket) + open + resolve(高危) + detail');
console.log('试试(开 /code 后): 把每个工单都打开看一眼，然后全部标记为已解决\n');
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
  if (line === '/code') {
    programMode = !programMode;
    console.log(
      `（已切到${programMode ? '“交清单”模式 Code-as-Action：一次提交一段程序，高危可三选 y/a/N，本模式不接记忆' : '“挤牙膏”单步模式（默认，含记忆）'}）`,
    );
    continue;
  }
  try {
    for await (const step of makeAgent().run(line)) {
      // Claude Code 式停顿：执行步之间留一点节奏，逐条推进而非一瞬间糊上去
      const t = (step as { type: string }).type;
      if (t === 'observation' || t === 'action' || t === 'replay') await sleep(380);
      else if (t === 'plan' || t === 'thinking') await sleep(200);
      show(step as unknown as Record<string, unknown>);
    }
  } catch (e) {
    console.log(`  [运行出错] ${(e as Error).message}`);
  }
}
rl.close();
