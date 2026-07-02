import type { Outcome } from './types';

/** 模型对任务目标的自评。账本是声明的上限：自评只能把 completed 降级为 failed，绝不能升级。 */
export interface FinishClaim {
  goalMet?: boolean;
}

/**
 * 自评降级（只降不升）：diff 只证明"有效果"，不证明"业务成功"——页面弹出错误文案
 * 同样是可验证变化。模型读到业务失败时申报 goalMet:false → completed 如实降为 failed；
 * cancelled/partial/failed 不受自评影响（已是更精确的原因，且升级方向被挡死）。
 */
export function applyClaim(outcome: Outcome, claim?: FinishClaim): Outcome {
  return claim?.goalMet === false && outcome === 'completed' ? 'failed' : outcome;
}
