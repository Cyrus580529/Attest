import type { RefKind } from '../types';
import type { LlmAdapter, LlmMessage, LlmToolCall } from '../llm/types';
import type { HostAdapter } from '../host/types';
import type { ConfirmFn, Intent, LedgerEntry, Outcome } from '../honesty/types';
import { READ_LOOP_TOOLS, ACT_TOOLS, PROGRAM_ACT_TOOLS, REF_TOOL_KINDS, WRITE_REF_KINDS } from './tools';
import { resolveRef } from './refResolver';
import { serializeSnapshot } from './serialize';
import { validateProgram, type Program } from './program/types';
import { runProgram } from './program/interpreter';
import { summarizeProgram } from './program/summarize';
import { diffSnapshots } from '../honesty/verifier';
import { isHighRisk } from '../honesty/riskPolicy';
import { Ledger } from '../honesty/ledger';
import { guardFinish } from '../honesty/narrationGuard';
import { memoryKey } from '../memory/pageSignature';
import { PageMemory, recordRef, resolveRecordedRef, type RecordedStep } from '../memory/pageMemory';

export type AgentStep =
  | { type: 'observation'; tool: string; refId?: string; result: string }
  | { type: 'action'; tool: string; refId: string; verified: boolean; evidence: string[] }
  | { type: 'held'; tool: string; refId: string; intent: Intent }
  | { type: 'cancelled'; tool: string; refId: string; reason: string }
  | { type: 'replay'; tool: string; refId?: string }
  | { type: 'plan'; items: string[] }
  | { type: 'error'; tool: string; refId?: string; error: string }
  | { type: 'finish'; answer: string; outcome: Outcome; ledger: LedgerEntry[] };

export interface AgentOptions {
  llm: LlmAdapter;
  host: HostAdapter;
  confirm?: ConfirmFn;
  readOnly?: boolean;
  maxSteps?: number;
  systemPrompt?: string;
  memory?: PageMemory;
  /** opt-in：act 模式改用 Code-as-Action（[runProgram, finish]，本切片不接记忆）。 */
  codeAsAction?: boolean;
}

const DEFAULT_MAX_STEPS = 12;
const DENY: ConfirmFn = () => Promise.resolve({ approved: false });

function defaultSystemPrompt(): string {
  return [
    '你是一个网页助手。你只能通过提供的工具观察和操作页面。',
    '只能引用工具结果里出现过的 ref id，且必须用完整 id（如 object:ticket:101、surface:detail），不要省略前缀或编造。',
    '高风险操作会先暂停等待用户确认；完成时调用 finish 给出用户可见的回答。',
    '无法确认结果时如实说明，不要假装成功。',
  ].join('\n');
}

function programSystemPrompt(): string {
  return [
    '你是一个网页助手，采用 Code-as-Action：把要做的事写成一段程序（JSON AST），用 runProgram 一次提交，由系统逐步真实执行。',
    '【铁律】凡是要对页面做事（打开/查看详情/标记/解决/填写/提交等），都必须通过 runProgram 真正执行。',
    '【铁律】finish 只能复述工具真正做过、且被系统验证过的结果；严禁在 finish 里声称任何没有经 runProgram 执行过的动作——系统会核对证据账本，空口宣称会被判定为未完成。',
    '程序 = { body: Node[] }，可用节点：',
    '- forEach{query:{type?,labelContains?}, as, do:[]}：遍历匹配对象，在 do 里用 "$as" 引用当前对象。',
    '- if{cond:{surface,contains}, then:[], else?:[]}：按某 surface 文本是否含子串分支。',
    '- open{on:"$var"}：打开/选中对象。 read{surface}：读区域文本。',
    '- setControl{on:{control},value}：设控件值。 invoke{action}：触发动作（高危会暂停等你确认）。',
    '- finish{answer}：在程序末尾给出用户可见的最终回答（只陈述真实发生的事）。',
    '示例——把所有工单逐个打开并标记为已解决：',
    'runProgram({ body: [ { op:"forEach", query:{type:"ticket"}, as:"t", do:[ { op:"open", on:"$t" }, { op:"invoke", action:"resolve" } ] }, { op:"finish", answer:"已逐个打开并标记为已解决" } ] })',
    '只能引用“当前页面”里真实暴露的 type/名称，不可编造。高危动作会被暂停等你确认；无法确认结果时如实说明，绝不假装成功。',
    '只有当用户纯粹在问问题、完全不需要操作页面时，才直接调用顶层 finish 作答。',
  ].join('\n');
}

interface CallResult {
  steps: AgentStep[];
  toolResult: string;
  recorded?: RecordedStep;
}

async function processCall(
  call: LlmToolCall,
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
): Promise<CallResult> {
  const name = call.name;
  const before = host.snapshot();

  if (name === 'observePage') {
    const result = serializeSnapshot(before);
    ledger.record({ kind: 'observe', tool: name, detail: result });
    return { steps: [{ type: 'observation', tool: name, result }], toolResult: result };
  }

  const readKind: RefKind | undefined = REF_TOOL_KINDS[name];
  if (readKind) {
    const refId = String(call.arguments.ref ?? '');
    const res = resolveRef(before, refId, readKind);
    if (!res.ok) {
      ledger.record({ kind: 'error', tool: name, detail: res.error });
      return { steps: [{ type: 'error', tool: name, refId, error: res.error }], toolResult: `ERROR: ${res.error}` };
    }
    let result: string;
    if (name === 'readSurface') {
      result = host.readSurface(res.ref);
    } else {
      const r = name === 'openObject' ? await host.openObject(res.ref) : await host.navigate(res.ref);
      result = serializeSnapshot(r.snapshot);
    }
    ledger.record({ kind: 'observe', tool: name, detail: result });
    return {
      steps: [{ type: 'observation', tool: name, refId, result }],
      toolResult: result,
      recorded: { tool: name, ref: recordRef(before, res.ref) },
    };
  }

  const writeKind: RefKind | undefined = WRITE_REF_KINDS[name];
  if (writeKind) {
    const refId = String(call.arguments.ref ?? '');
    const res = resolveRef(before, refId, writeKind);
    if (!res.ok) {
      ledger.record({ kind: 'error', tool: name, detail: res.error });
      return { steps: [{ type: 'error', tool: name, refId, error: res.error }], toolResult: `ERROR: ${res.error}` };
    }

    const steps: AgentStep[] = [];
    let confirmed = false;

    if (name === 'invokeAction' && isHighRisk(before, refId)) {
      const action = before.actions.find((a) => a.ref.id === refId);
      const intent: Intent = {
        actionRef: refId,
        label: action?.label ?? refId,
        expectedEvidence: [`执行 ${action?.name ?? refId} 后页面应发生可观察变化`],
      };
      ledger.record({ kind: 'intent', refId, label: intent.label, expectedEvidence: intent.expectedEvidence });
      steps.push({ type: 'held', tool: name, refId, intent });

      const decision = await confirm(intent);
      ledger.record({ kind: 'grant', refId, approved: decision.approved });
      if (!decision.approved) {
        steps.push({ type: 'cancelled', tool: name, refId, reason: 'user declined' });
        return { steps, toolResult: 'ACTION CANCELLED: 用户拒绝了该高风险操作。' };
      }
      confirmed = true;
    }

    const value = name === 'setControl' ? String(call.arguments.value ?? '') : undefined;
    const result = name === 'setControl' ? await host.setControl(res.ref, value ?? '') : await host.invokeAction(res.ref);
    const evidence = diffSnapshots(before, result.snapshot);
    ledger.record({ kind: 'write', tool: name, refId, verified: evidence.changed, evidence: evidence.details });
    steps.push({ type: 'action', tool: name, refId, verified: evidence.changed, evidence: evidence.details });
    const base = evidence.changed
      ? `done; 证据: ${evidence.details.join('; ')}`
      : '已执行，但未检测到可观察变化（未验证）。';
    const toolResult = confirmed ? `（此高风险操作已由用户确认后才执行）${base}` : base;
    return { steps, toolResult, recorded: { tool: name, ref: recordRef(before, res.ref), value } };
  }

  ledger.record({ kind: 'error', tool: name, detail: `unknown tool "${name}"` });
  return { steps: [{ type: 'error', tool: name, error: `unknown tool "${name}"` }], toolResult: 'ERROR: unknown tool' };
}

function finishStep(answer: string, ledger: Ledger): AgentStep {
  const guarded = guardFinish(answer.trim(), ledger.entries);
  return { type: 'finish', answer: guarded.answer, outcome: guarded.outcome, ledger: ledger.toJSON() };
}

async function* attemptReplay(
  steps: RecordedStep[],
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
): AsyncGenerator<AgentStep, { done: boolean }> {
  for (const step of steps) {
    if (step.tool === 'finish') {
      yield finishStep(step.answer ?? '', ledger);
      return { done: true };
    }

    let refId: string | undefined;
    if (step.ref) {
      const ref = resolveRecordedRef(host.snapshot(), step.ref);
      if (!ref) return { done: false };
      refId = ref.id;
    }

    yield { type: 'replay', tool: step.tool, refId };

    const call: LlmToolCall = {
      id: `replay_${step.tool}`,
      name: step.tool,
      arguments: {
        ...(refId !== undefined ? { ref: refId } : {}),
        ...(step.value !== undefined ? { value: step.value } : {}),
      },
    };
    const { steps: produced } = await processCall(call, host, ledger, confirm);
    for (const s of produced) yield s;

    if (produced.some((s) => s.type === 'error')) return { done: false };
    if (produced.some((s) => s.type === 'action' && !s.verified)) return { done: false };
    if (produced.some((s) => s.type === 'cancelled')) {
      yield finishStep('', ledger);
      return { done: true };
    }
  }

  yield finishStep('', ledger);
  return { done: true };
}

export function createAgent(options: AgentOptions) {
  const { llm, host } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const programMode = !options.readOnly && !!options.codeAsAction;
  const systemPrompt =
    options.systemPrompt ?? (programMode ? programSystemPrompt() : defaultSystemPrompt());
  const confirm = options.confirm ?? DENY;
  const tools = options.readOnly ? READ_LOOP_TOOLS : programMode ? PROGRAM_ACT_TOOLS : ACT_TOOLS;
  const memory = options.memory;

  /** Code-as-Action 模式：播种观察 → 模型交 runProgram → 解释器驱动 → 由账本算 outcome。 */
  async function* runProgramMode(userMessage: string): AsyncGenerator<AgentStep> {
    const ledger = new Ledger();
    const seeded = serializeSnapshot(host.snapshot());
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${userMessage}\n\n当前页面：\n${seeded}` },
    ];

    // 程序模式收尾：outcome 与证据小结全由账本算，绝不替模型自述背书（defense-in-depth）。
    // - 空账本＝这回合没经任何工具干活 → 加注“未执行任何动作”（堵空账本谎报）。
    // - 有成功写但也有被拒授权＝部分完成 → outcome=partial（堵“部分取消却报全部完成”的谎报）。
    const programFinish = (answer: string, aborted = false): AgentStep => {
      const entries = ledger.entries;
      const verified = entries.filter((e) => e.kind === 'write' && e.verified).length;
      const unverified = entries.filter((e) => e.kind === 'write' && !e.verified).length;
      const cancelled = entries.filter((e) => e.kind === 'grant' && !e.approved).length;

      let outcome: Outcome;
      if (unverified > 0) outcome = 'failed';
      else if (cancelled > 0 && verified > 0) outcome = 'partial';
      else if (cancelled > 0) outcome = 'cancelled';
      else outcome = 'completed';
      if (aborted && (outcome === 'completed' || outcome === 'partial')) outcome = 'failed';

      const notes: string[] = [];
      if (entries.length === 0) {
        notes.push('本回合未经任何工具操作或读取页面，未执行任何动作，以上仅为直接作答；不要据此认为相关任务已完成');
      } else {
        const tally: string[] = [];
        if (verified > 0) tally.push(`成功 ${verified} 项`);
        if (cancelled > 0) tally.push(`取消 ${cancelled} 项`);
        if (unverified > 0) tally.push(`未验证 ${unverified} 项`);
        if (tally.length > 0) notes.push(`实际：${tally.join('·')}`);
        if (cancelled > 0) notes.push('有动作被你取消，未全部完成');
      }
      const finalAnswer = notes.length > 0 ? `${answer}\n（注意：${notes.join('；')}。）`.trim() : answer;
      return { type: 'finish', answer: finalAnswer, outcome, ledger: ledger.toJSON() };
    };

    for (let i = 0; i < maxSteps; i++) {
      const turn = await llm.step(messages, tools);

      if (turn.toolCalls.length === 0) {
        yield programFinish(turn.content.trim());
        return;
      }
      messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

      let done = false;
      for (const call of turn.toolCalls) {
        if (call.name === 'finish') {
          yield programFinish(String(call.arguments.answer ?? '').trim());
          return;
        }
        if (call.name === 'runProgram') {
          const errors = validateProgram(call.arguments.program);
          if (errors.length > 0) {
            const detail = errors.join('; ');
            ledger.record({ kind: 'error', tool: 'runProgram', detail });
            yield { type: 'error', tool: 'runProgram', error: detail };
            messages.push({ role: 'tool', toolCallId: call.id, content: `ERROR: 程序非法: ${detail}` });
            continue;
          }
          const program = call.arguments.program as Program;
          const planItems = summarizeProgram(program, host.snapshot());
          if (planItems.length > 0) yield { type: 'plan', items: planItems };
          const result = yield* runProgram(program, { host, ledger, confirm });
          yield programFinish(result.answer.trim() || '（程序已执行）', result.aborted);
          done = true;
          break;
        }
        ledger.record({ kind: 'error', tool: call.name, detail: `unknown tool "${call.name}"` });
        yield { type: 'error', tool: call.name, error: `unknown tool "${call.name}"` };
        messages.push({ role: 'tool', toolCallId: call.id, content: 'ERROR: unknown tool' });
      }
      if (done) return;
    }

    yield programFinish('我没能在限定步数内完成这个任务，没有可确认的结果。', true);
  }

  async function* run(userMessage: string): AsyncGenerator<AgentStep> {
    if (programMode) {
      yield* runProgramMode(userMessage);
      return;
    }
    const ledger = new Ledger();
    const recorded: RecordedStep[] = [];
    const key = memory ? memoryKey(host.snapshot(), userMessage) : '';

    if (memory) {
      const entry = memory.lookup(key);
      if (entry) {
        const result = yield* attemptReplay(entry.steps, host, ledger, confirm);
        if (result.done) return;
      }
    }

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    for (let i = 0; i < maxSteps; i++) {
      const turn = await llm.step(messages, tools);

      if (turn.toolCalls.length === 0) {
        const step = finishStep(turn.content, ledger);
        if (memory && step.type === 'finish' && step.outcome === 'completed') {
          memory.record(key, [...recorded, { tool: 'finish', answer: turn.content.trim() }]);
        }
        yield step;
        return;
      }

      messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

      let finished = false;
      for (const call of turn.toolCalls) {
        if (call.name === 'finish') {
          const answer = String(call.arguments.answer ?? '').trim();
          const step = finishStep(answer, ledger);
          if (memory && step.type === 'finish' && step.outcome === 'completed') {
            memory.record(key, [...recorded, { tool: 'finish', answer }]);
          }
          yield step;
          finished = true;
          break;
        }
        const result = await processCall(call, host, ledger, confirm);
        for (const s of result.steps) yield s;
        if (result.recorded) recorded.push(result.recorded);
        messages.push({ role: 'tool', toolCallId: call.id, content: result.toolResult });
      }
      if (finished) return;
    }

    const guarded = guardFinish('我没能在限定步数内完成这个任务，没有可确认的结果。', ledger.entries);
    yield {
      type: 'finish',
      answer: guarded.answer,
      outcome: guarded.outcome === 'completed' ? 'failed' : guarded.outcome,
      ledger: ledger.toJSON(),
    };
  }

  return { run };
}
