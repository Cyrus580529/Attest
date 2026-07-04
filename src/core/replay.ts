import { computeOutcome } from '../honesty/ledger';
import type { Outcome } from '../honesty/types';
import type { TraceEvent } from './trace';

export interface ReplayResult {
  recordedOutcome: Outcome | null;
  replayedOutcome: Outcome | null;
  matches: boolean;
}

/**
 * 从一份 trace（TraceEvent[]）里找 finish 事件，取出账本，用当前代码重跑
 * computeOutcome，和录制时的 outcome 对比——检测代码改动是否让历史判定结果变了。
 * 不重跑任何 LLM/host 调用，只吃 finish 事件里已经完整落盘的 ledger 数组。
 * 找不到 finish 事件（任务半路截断）时两边都是 null、matches:true（没什么可比的）。
 */
export function replayOutcome(trace: readonly TraceEvent[]): ReplayResult {
  const finishEvent = trace.find((e) => e.step.type === 'finish');
  if (!finishEvent || finishEvent.step.type !== 'finish') {
    return { recordedOutcome: null, replayedOutcome: null, matches: true };
  }
  const recordedOutcome = finishEvent.step.outcome;
  const replayedOutcome = computeOutcome(finishEvent.step.ledger);
  return { recordedOutcome, replayedOutcome, matches: recordedOutcome === replayedOutcome };
}
