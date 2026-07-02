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

/** 对象出现/消失 detail 的「方向+类型」形（与 worldModel.genericExpectation 的对象分支同构）。 */
const OBJECT_FORM = /^(object (?:appeared|gone): object:[^:]+):/;
function objectForm(detail: string): string | null {
  return OBJECT_FORM.exec(detail)?.[1] ?? null;
}

/**
 * 接受测试：实际证据是否满足预测（满足档：predict ⊆ actual，页面多做别的不算失败）。
 * 对象实例宽容：实例 id 是页面指派的、预测时不可知——object 出现/消失按「方向+类型」比对
 * （record:1 学的预测，record:2 出现也命中）；control 值是模型自己选的、可预测，保持严格。
 */
export function matchesPrediction(evidence: Evidence, predict: Prediction): boolean {
  if (predict.expectChanged && !evidence.changed) return false;
  return predict.expectDetails.every((want) => {
    const wantForm = objectForm(want);
    return evidence.details.some((got) => got.includes(want) || (wantForm !== null && wantForm === objectForm(got)));
  });
}
