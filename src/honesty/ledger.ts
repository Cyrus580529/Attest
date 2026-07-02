import type { LedgerEntry, Outcome } from './types';

export class Ledger {
  private readonly _entries: LedgerEntry[] = [];

  record(entry: LedgerEntry): void {
    this._entries.push(entry);
  }

  get entries(): readonly LedgerEntry[] {
    return this._entries;
  }

  toJSON(): LedgerEntry[] {
    return [...this._entries];
  }
}

export function computeOutcome(entries: readonly LedgerEntry[]): Outcome {
  const writes = entries.filter(
    (e): e is Extract<LedgerEntry, { kind: 'write' }> => e.kind === 'write',
  );
  const deniedGrant = entries.some((e) => e.kind === 'grant' && !e.approved);

  if (writes.some((w) => !w.verified)) return 'failed';
  // 写尝试以 error 告终（ref 失效/TOCTOU 拒绝/host 崩溃）也不算完成——除非其后有
  // 验证成功的写（模型已恢复）。读 error 不拖垮：模型可改道，收尾如实即可。
  let lastWriteError = -1;
  entries.forEach((e, i) => {
    if (e.kind === 'error' && (e.tool === 'setControl' || e.tool === 'invokeAction')) lastWriteError = i;
  });
  if (
    lastWriteError >= 0 &&
    !entries.slice(lastWriteError + 1).some((e) => e.kind === 'write' && e.verified)
  ) {
    return 'failed';
  }
  if (deniedGrant && !writes.some((w) => w.verified)) return 'cancelled';
  return 'completed';
}
