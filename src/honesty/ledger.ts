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

  // 未验证的写与出错的写都是"终态不明"信号，同一条恢复规则（与 slice14 的 error
  // 恢复同形）：其后有验证成功的写=已恢复，不因一次无效果的探索性点击把随后全部
  // 验证过的工作拍成 failed；反之收尾停在不明状态就不许 completed。读 error 不拖垮。
  let lastDoubt = -1;
  entries.forEach((e, i) => {
    if (e.kind === 'write' && !e.verified) lastDoubt = i;
    if (e.kind === 'error' && (e.tool === 'setControl' || e.tool === 'invokeAction')) lastDoubt = i;
  });
  if (lastDoubt >= 0 && !entries.slice(lastDoubt + 1).some((e) => e.kind === 'write' && e.verified)) {
    return 'failed';
  }
  if (deniedGrant && !writes.some((w) => w.verified)) return 'cancelled';
  return 'completed';
}
