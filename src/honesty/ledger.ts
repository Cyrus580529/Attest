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

  // 未验证的写、出错的写、以及提问后未获回复的 askUser，都是"终态不明"信号，
  // 同一条恢复规则（与 slice14 的 error 恢复同形）：其后有验证成功的写=已恢复，
  // 不因一次无效果的探索/悬而未决的提问把随后全部验证过的工作拍成 failed；
  // 反之收尾停在不明状态就不许 completed（堵"提问后没等回复就径直 finish=completed"
  // 的空账本谎报——askUser 本身不写、不进 verify-or-refuse，但悬而未决不能被空账本
  // 默认规则蒙混成"没什么好做的直接完成"）。读 error 不拖垮。
  let lastDoubt = -1;
  entries.forEach((e, i) => {
    if (e.kind === 'write' && !e.verified) lastDoubt = i;
    if (e.kind === 'error' && (e.tool === 'setControl' || e.tool === 'invokeAction')) lastDoubt = i;
    if (e.kind === 'clarify' && !e.answered) lastDoubt = i;
  });
  if (lastDoubt >= 0 && !entries.slice(lastDoubt + 1).some((e) => e.kind === 'write' && e.verified)) {
    return 'failed';
  }

  // 有 verified 写，但清一色是导航类（navLike）——只是"去了个地方"，任务真正要求的
  // 变更从未发生。和上面的 doubt 信号同一套宽容：只要序列里任意一次 verified 写不是
  // 导航类，这条就不成立（不追究先后顺序）。完全不碰"空账本→completed"的既有默认
  // （writes.length===0 时 hasVerified 为 false，这条规则天然不生效）。
  const hasVerified = writes.some((w) => w.verified);
  const hasSubstantiveVerified = writes.some((w) => w.verified && !w.navLike);
  if (hasVerified && !hasSubstantiveVerified) {
    return 'failed';
  }

  if (deniedGrant && !writes.some((w) => w.verified)) return 'cancelled';
  return 'completed';
}
