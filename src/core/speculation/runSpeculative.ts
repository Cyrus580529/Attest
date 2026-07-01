import type { HostAdapter } from '../../host/types';
import type { ConfirmFn } from '../../honesty/types';
import { Ledger } from '../../honesty/ledger';
import type { AgentStep } from '../loopTypes';
import { processCall } from '../readLoop';
import { finishStep } from '../finish';
import { matchesPrediction } from './prediction';
import type { PredictionSource } from './sources';
import type { WorldModel } from '../../memory/worldModel';

export interface SpecDeps {
  host: HostAdapter;
  ledger: Ledger;
  confirm: ConfirmFn;
  grantedScopes: Set<string>;
  /** 传入则重放中的验证写也会喂给世界模型学习。 */
  worldModel?: WorldModel;
}

export interface SpecResult {
  /** true=已收尾（源耗尽/finish/用户取消）；false=需重同步（漂移/失效/未验证/error）。 */
  done: boolean;
}

/**
 * 统一投机执行器：逐步取预测源，走 processCall（即 executeWrite 五关），
 * 对写步用 diffSnapshots 证据比对预测。命中零-LLM 前进；漂移/失效/未验证 → done:false 交回调用方。
 * 对 ledger/verify 无任何旁路——纯性能层，删掉它正确性不变、只变慢。
 */
export async function* runSpeculative(
  source: PredictionSource,
  deps: SpecDeps,
): AsyncGenerator<AgentStep, SpecResult> {
  const { host, ledger, confirm, grantedScopes, worldModel } = deps;

  for (;;) {
    const step = source.next(host.snapshot());
    if (step === null) {
      yield finishStep('', ledger); // 源自然耗尽：按账本收尾
      return { done: true };
    }
    if (step.call === null) {
      return { done: false }; // 源失效（ref 解析不出）→ 重同步
    }
    if (step.call.name === 'finish') {
      yield finishStep(step.answer ?? '', ledger);
      return { done: true };
    }

    const { steps: produced } = await processCall(step.call, host, ledger, confirm, grantedScopes, worldModel);
    for (const s of produced) yield s;

    if (produced.some((s) => s.type === 'error')) return { done: false };
    if (produced.some((s) => s.type === 'cancelled')) {
      yield finishStep('', ledger); // 用户拒绝高危 → 收尾（outcome 由账本算 cancelled）
      return { done: true };
    }

    const actionStep = produced.find((s) => s.type === 'action') as
      | Extract<AgentStep, { type: 'action' }>
      | undefined;
    if (actionStep && !actionStep.verified) return { done: false }; // 未验证 → 重同步

    if (step.predict && actionStep) {
      const evidence = { changed: actionStep.verified, details: actionStep.evidence };
      const hit = matchesPrediction(evidence, step.predict);
      yield { type: 'speculate', tool: step.call.name, refId: actionStep.refId, hit };
      if (!hit) {
        yield {
          type: 'mispredict',
          tool: step.call.name,
          refId: actionStep.refId,
          expected: step.predict.expectDetails,
          actual: actionStep.evidence,
        };
        return { done: false };
      }
    } else if (step.predict) {
      // 读步无 action diff，预测无从比对，视作命中（ref 已解析成功即足够）。
      yield { type: 'speculate', tool: step.call.name, hit: true };
    }
  }
}
