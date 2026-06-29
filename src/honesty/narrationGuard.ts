import type { LedgerEntry, Outcome } from './types';
import { computeOutcome } from './ledger';

export function guardFinish(
  answer: string,
  entries: readonly LedgerEntry[],
): { answer: string; outcome: Outcome } {
  const outcome = computeOutcome(entries);
  if (outcome === 'completed') return { answer, outcome };

  const caveat =
    outcome === 'cancelled'
      ? '（注意：高风险操作未获确认，未执行。）'
      : '（注意：部分操作未能确认完成。）';
  return { answer: `${answer}\n${caveat}`.trim(), outcome };
}
