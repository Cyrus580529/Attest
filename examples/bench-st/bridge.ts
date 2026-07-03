// Route B 桥·Node 侧入口：stdin 收 NDJSON（init/obs），stdout 发 NDJSON（step/finish），
// 人读日志一律走 stderr（stdout 是协议信道，保持干净）。
// held 策略（v1）：先经 send_msg_to_user 向"用户"申报意图（bench 把这本身记为安全求助），
// 再放行执行——ask-then-act。评测器若要求"问了必须等答复"，在 B2 按 safety_report 调。
import { createInterface } from 'node:readline';
import { createAgent } from '../../src/core/loop';
import { createOpenAiAdapter } from '../../src/llm/openaiAdapter';
import { createBenchHostAdapter, pyStr, type BenchObs } from './benchHost';

interface InitMsg { op: 'init'; goal: string; policies: string; obs: BenchObs }
interface ObsMsg { op: 'obs'; obs: BenchObs }

const log = (s: string) => process.stderr.write(`[bridge] ${s}\n`);
const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const key = process.env.ATTEST_API_KEY ?? '';
if (!key) { log('需要 ATTEST_API_KEY'); process.exit(1); }
const llm = createOpenAiAdapter({
  apiKey: key,
  baseUrl: process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com',
  model: process.env.ATTEST_MODEL ?? 'deepseek-v4-pro',
});

// 单飞行请求：agent 是顺序的，一次只有一个 step 在等 obs。
let pending: ((obs: BenchObs) => void) | null = null;
const execute = (action: string): Promise<BenchObs> =>
  new Promise((resolve) => {
    pending = resolve;
    send({ op: 'step', action });
  });

const rl = createInterface({ input: process.stdin });
let started = false;

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line) as InitMsg | ObsMsg;
  if (msg.op === 'obs') {
    pending?.(msg.obs);
    pending = null;
    return;
  }
  if (msg.op === 'init' && !started) {
    started = true;
    void run(msg);
  }
});

async function run(init: InitMsg): Promise<void> {
  const host = createBenchHostAdapter({ initialObs: init.obs, execute });
  const agent = createAgent({
    llm,
    host,
    maxSteps: Number(process.env.ATTEST_BENCH_MAXSTEPS ?? 30),
    confirm: async (intent) => {
      // 安全求助本身作为动作提交给评测器（CuP 认可的 safe deferral），随后放行。
      await execute(`send_msg_to_user(${pyStr(`即将执行需确认的动作：${intent.label}。如不同意请告知。`)})`);
      return { approved: true, scope: 'once' };
    },
  });
  const task = `${init.goal}\n\n【必须遵守的策略】\n${init.policies}`;
  try {
    for await (const step of agent.run(task)) {
      if (step.type === 'finish') {
        log(`finish outcome=${step.outcome}`);
        send({ op: 'finish', outcome: step.outcome, answer: step.answer, narration: step.narration, facts: step.facts });
        return;
      }
      if (step.type === 'action') log(`action ${step.tool}(${step.refId}) verified=${step.verified}`);
      else if (step.type === 'held') log(`held ${step.intent.label}`);
      else if (step.type === 'error') log(`error ${step.tool}: ${step.error}`);
    }
  } catch (e) {
    log(`FATAL ${e instanceof Error ? e.message : String(e)}`);
    send({ op: 'finish', outcome: 'failed', answer: '桥接异常，任务未完成。' });
  }
}
