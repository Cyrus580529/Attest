import type { LedgerEntry, Outcome } from './types';
import { computeOutcome } from './ledger';

/** 模型对任务目标的自评。账本是声明的上限：自评只能把 completed 降级为 failed，绝不能升级。 */
export interface FinishClaim {
  goalMet?: boolean;
}

export function guardFinish(
  answer: string,
  entries: readonly LedgerEntry[],
  claim?: FinishClaim,
): { answer: string; outcome: Outcome } {
  const outcome = computeOutcome(entries);
  if (outcome === 'completed') {
    // diff 只证明"有效果"，不证明"业务成功"：页面弹出错误文案同样是可验证的变化。
    // 模型读到业务失败时申报 goalMet:false → 如实降级；答案原样（模型已在叙述里说明）。
    if (claim?.goalMet === false) return { answer, outcome: 'failed' };
    return { answer, outcome };
  }

  const caveat =
    outcome === 'cancelled'
      ? '（注意：高风险操作未获确认，未执行。）'
      : '（注意：部分操作未能确认完成。）';
  return { answer: `${answer}\n${caveat}`.trim(), outcome };
}
