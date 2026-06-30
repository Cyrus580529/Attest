import type { LlmMessage } from '../llm/types';
import { FINISH_TOOL } from './tools';
import { serializeSnapshot, serializeSurfaceTexts } from './serialize';
import { validateProgram, type Program } from './program/types';
import { runProgram } from './program/interpreter';
import { summarizeProgram } from './program/summarize';
import { Ledger } from '../honesty/ledger';
import { pageSignature } from '../memory/pageSignature';
import { factualLedgerSummary, formatRecipes, programFinish } from './finish';
import type { AgentStep, LoopDeps } from './loopTypes';

/** 播种时同类型对象超此数则折叠为轮廓（渐进披露）；模型按需 forEach/open/read 钻取全详。 */
const SEED_MAX_PER_TYPE = 20;

/**
 * Code-as-Action 模式：召回配方先验 → 播种观察 → 模型交 runProgram → 解释器驱动 →
 * 复盘（看真实结果再 finish）→ 由账本算 outcome；completed 程序录入配方库。
 *
 * 播种用渐进披露轮廓（大页面只露类型+数量+样例，省 token、随规模线性扩展）；
 * 解释器的 observe/open/read 仍取全详，做到"按需钻取"。
 */
export async function* runProgramLoop(deps: LoopDeps, userMessage: string): AsyncGenerator<AgentStep> {
  const { llm, host, tools, systemPrompt, confirm, recipes, maxSteps } = deps;
  const ledger = new Ledger();
  const recipeSignature = recipes ? pageSignature(host.snapshot()) : '';
  const seeded = serializeSnapshot(host.snapshot(), { maxPerType: SEED_MAX_PER_TYPE });
  const recalled = recipes ? recipes.recall(recipeSignature, 3) : [];
  const prior = recalled.length > 0 ? `\n\n${formatRecipes(recalled)}` : '';
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${userMessage}\n\n当前页面：\n${seeded}${prior}` },
  ];

  for (let i = 0; i < maxSteps; i++) {
    const turn = await llm.step(messages, tools);

    if (turn.toolCalls.length === 0) {
      yield programFinish(ledger, turn.content.trim());
      return;
    }
    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

    let done = false;
    for (const call of turn.toolCalls) {
      if (call.name === 'finish') {
        yield programFinish(ledger, String(call.arguments.answer ?? '').trim());
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
        if (turn.content.trim()) yield { type: 'thinking', text: turn.content.trim() };
        const planItems = summarizeProgram(program, host.snapshot());
        if (planItems.length > 0) yield { type: 'plan', items: planItems };
        const result = yield* runProgram(program, { host, ledger, confirm });

        // 复盘（reflect）：把账本真相 + 最终页面可见文本喂回模型，限定只能 finish，让它基于真相作答。
        // 账本="我做了什么"（不可篡改）；surface 文本="现在屏上是什么"（读取类任务据此转述所读）。
        const visible = serializeSurfaceTexts(host.snapshot());
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content:
            `程序执行完毕。真实结果（来自证据账本，不可篡改）：${factualLedgerSummary(ledger.entries)}。` +
            (visible ? `\n当前页面可见文本——${visible}` : ''),
        });
        messages.push({
          role: 'user',
          content:
            '请基于上面的真实结果，用一两句话给用户准确的最终回答（调用 finish）。绝不要声称被取消或未验证的动作已完成。',
        });
        const reflect = await llm.step(messages, [FINISH_TOOL]);
        const reflectCall = reflect.toolCalls.find((c) => c.name === 'finish');
        const reflectAnswer = (reflectCall ? String(reflectCall.arguments.answer ?? '') : reflect.content).trim();
        const fin = programFinish(ledger, reflectAnswer || result.answer.trim() || '（程序已执行）', result.aborted);
        // 录制：只在程序真正 completed 且未 abort 时入库——partial/cancelled/failed 不背书为可复用配方。
        if (recipes && fin.type === 'finish' && fin.outcome === 'completed' && !result.aborted) {
          recipes.record(recipeSignature, { program, goal: userMessage, recordedAt: Date.now() });
        }
        yield fin;
        done = true;
        break;
      }
      ledger.record({ kind: 'error', tool: call.name, detail: `unknown tool "${call.name}"` });
      yield { type: 'error', tool: call.name, error: `unknown tool "${call.name}"` };
      messages.push({ role: 'tool', toolCallId: call.id, content: 'ERROR: unknown tool' });
    }
    if (done) return;
  }

  yield programFinish(ledger, '我没能在限定步数内完成这个任务，没有可确认的结果。', true);
}
