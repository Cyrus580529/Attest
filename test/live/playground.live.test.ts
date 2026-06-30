import { describe, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';
import { createOpenAiAdapter } from '../../src/llm/openaiAdapter';
import { PageMemory } from '../../src/memory/pageMemory';

// 跑法（PowerShell）：
//   $env:ATTEST_API_KEY="sk-..."; $env:ATTEST_BASE_URL="https://www.kamiapi.top/v1"; $env:ATTEST_MODEL="gpt-5.5"; npx vitest run test/live
// 没设 ATTEST_API_KEY 时整组自动跳过。

const key = process.env.ATTEST_API_KEY ?? '';
const baseUrl = process.env.ATTEST_BASE_URL ?? 'https://api.openai.com/v1';
const model = process.env.ATTEST_MODEL ?? 'gpt-5.5';

const html = readFileSync(resolve(process.cwd(), 'examples/mini-board/index.html'), 'utf8');

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

function makeAgent(memory?: PageMemory) {
  const llm = createOpenAiAdapter({ apiKey: key, baseUrl, model });
  return createAgent({
    llm,
    host: createDomHostAdapter({ getUrl: () => '/board' }),
    memory,
    confirm: (intent) => {
      console.log(`   [HELD] 高风险「${intent.label}」→ 演示自动批准`);
      return Promise.resolve({ approved: true });
    },
  });
}

function makeProgramAgent() {
  const llm = createOpenAiAdapter({ apiKey: key, baseUrl, model });
  return createAgent({
    llm,
    host: createDomHostAdapter({ getUrl: () => '/board' }),
    codeAsAction: true,
    confirm: (intent) => {
      console.log(`   [HELD] 高风险「${intent.label}」→ 作用域授权：本程序内全部同名动作`);
      return Promise.resolve({ approved: true, scope: 'all' });
    },
  });
}

function show(step: AgentStep): void {
  if (step.type === 'thinking') {
    console.log(`  💭 ${step.text}`);
  } else if (step.type === 'plan') {
    console.log(`  ▸ 计划：${step.items.join('；')}`);
  } else if (step.type === 'finish') {
    console.log(`  FINISH [${step.outcome}] ${step.answer}`);
    console.log(`    ledger: ${step.ledger.map((e) => e.kind).join(' → ')}`);
  } else if (step.type === 'action') {
    console.log(`  action ${step.tool}(${step.refId}) verified=${step.verified} 证据=[${step.evidence.join('; ')}]`);
  } else if (step.type === 'replay') {
    console.log(`  ⚡replay ${step.tool}${step.refId ? `(${step.refId})` : ''} ← 来自记忆（零 LLM）`);
  } else if (step.type === 'observation') {
    console.log(`  observe ${step.tool}${step.refId ? `(${step.refId})` : ''}`);
  } else if (step.type === 'held') {
    console.log(`  held ${step.intent.label}`);
  } else if (step.type === 'cancelled') {
    console.log(`  cancelled ${step.refId}`);
  } else {
    console.log(`  error ${step.tool}: ${step.error}`);
  }
}

async function drive(label: string, agent: ReturnType<typeof makeAgent>, msg: string): Promise<void> {
  console.log(`\n=== ${label} ===\n用户> ${msg}`);
  for await (const step of agent.run(msg)) show(step);
}

describe.skipIf(!key)(`live playground (${baseUrl} / ${model})`, () => {
  beforeEach(loadBoard);

  it('① 长程：挑一个工单看详情后总结', async () => {
    await drive('长程读取', makeAgent(), '看看有哪些工单，挑“登录页 500 错误”看下详情再告诉我怎么回事');
  }, 120000);

  it('② 高危：标记为已解决（held → 批准 → 验证）', async () => {
    await drive('高危写', makeAgent(), '把这个工单标记为已解决');
  }, 120000);

  it('③ 记忆：同任务第二次零-LLM 重放', async () => {
    const memory = new PageMemory();
    await drive('第一次（走 LLM）', makeAgent(memory), '列出所有工单并总结一句');
    loadBoard();
    await drive('第二次（应⚡replay）', makeAgent(memory), '列出所有工单并总结一句');
  }, 180000);

  it('④ Code-as-Action：一段程序批量处理（held + 作用域授权）', async () => {
    // 期望模型用 runProgram 提交一段 forEach[open, invoke resolve] 程序；
    // 高危 resolve 首次 held → 授权 scope=all → 后续不再问；每个写仍逐个 verified；finish=completed。
    await drive('程序化批处理', makeProgramAgent(), '逐个打开每个工单看一眼，然后把它们全部标记为已解决');
  }, 180000);
});
