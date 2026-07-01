import type { Evidence } from '../../honesty/types';

/**
 * 预测：对「可观察 diff」的断言，词汇与 diffSnapshots.details 对齐。
 * expectDetails 里每个子串都必须出现在实际 evidence.details 的某一条里（满足档）。
 */
export interface Prediction {
  expectDetails: string[];
  /** 弱断言：至少要有可观察变化（等价 evidence.changed）。 */
  expectChanged?: boolean;
}

/** 接受测试：实际证据是否满足预测（满足档：predict ⊆ actual，页面多做别的不算失败）。 */
export function matchesPrediction(evidence: Evidence, predict: Prediction): boolean {
  if (predict.expectChanged && !evidence.changed) return false;
  return predict.expectDetails.every((want) => evidence.details.some((got) => got.includes(want)));
}
