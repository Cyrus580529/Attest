import type { PageSnapshot } from '../../types';
import type { LlmToolCall } from '../../llm/types';
import type { RecordedStep } from '../../memory/pageMemory';
import { resolveRecordedRef } from '../../memory/pageMemory';
import type { WorldModel } from '../../memory/worldModel';
import type { Prediction } from './prediction';

/** 一步投机：要执行的工具调用 + 可选预测；call=null 表示源在当前页失效（ref 解析不出）。 */
export type SpecStep =
  | { call: LlmToolCall; predict?: Prediction; answer?: string }
  | { call: null };

/** 预测源：有状态游标，next 按实时快照解析 ref、产出下一步；返回 null 表示自然耗尽。 */
export interface PredictionSource {
  next(snapshot: PageSnapshot): SpecStep | null;
}

/**
 * 记忆轨迹 → 预测源：按录制顺序重解析 ref，observedDiff 作预测。
 * observedDiff 缺失（老记忆/读步）且传了 worldModel 时，用世界模型为 action 步补预测。
 */
export function fromMemory(steps: RecordedStep[], worldModel?: WorldModel): PredictionSource {
  let i = 0;
  return {
    next(snapshot: PageSnapshot): SpecStep | null {
      if (i >= steps.length) return null;
      const step = steps[i++];
      if (!step) return null;
      if (step.tool === 'finish') {
        return {
          call: { id: 'spec_finish', name: 'finish', arguments: { answer: step.answer ?? '' } },
          answer: step.answer,
        };
      }
      let refArg: Record<string, unknown> = {};
      if (step.ref) {
        const ref = resolveRecordedRef(snapshot, step.ref);
        if (!ref) return { call: null };
        refArg = { ref: ref.id };
      }
      const call: LlmToolCall = {
        id: `spec_${step.tool}_${i}`,
        name: step.tool,
        arguments: { ...refArg, ...(step.value !== undefined ? { value: step.value } : {}) },
      };
      let predict: Prediction | undefined =
        step.observedDiff && step.observedDiff.length > 0 ? { expectDetails: step.observedDiff } : undefined;
      if (!predict && worldModel && step.ref?.by === 'name' && step.ref.kind === 'action') {
        predict = worldModel.predict(snapshot, step.ref.name) ?? undefined;
      }
      return { call, predict };
    },
  };
}
