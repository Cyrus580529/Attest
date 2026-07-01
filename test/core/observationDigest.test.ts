import { describe, it, expect } from 'vitest';
import { observationDigest } from '../../src/core/finish';
import type { LedgerEntry } from '../../src/honesty/types';

const obs = (tool: string, detail: string): LedgerEntry => ({ kind: 'observe', tool, detail });

describe('observationDigest', () => {
  it('抽读观察原文，非纯计数', () => {
    const out = observationDigest([obs('readSurface', '订单状态：已发货，单号 SF123')]);
    expect(out).toContain('已发货');
    expect(out).toContain('SF123');
  });

  it('同内容去重（重复读同一 surface 只留一次）', () => {
    const out = observationDigest([obs('readSurface', '相同文本'), obs('readSurface', '相同文本')]);
    expect(out.match(/相同文本/g)).toHaveLength(1);
  });

  it('每条截断、总数封顶', () => {
    const many = Array.from({ length: 10 }, (_, i) => obs('readSurface', `观察${i}-${'x'.repeat(500)}`));
    const out = observationDigest(many, { maxItems: 3, maxCharsPerItem: 50 });
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3); // 封顶 3
    expect(out).toContain('…'); // 有截断
    expect(out).toContain('观察9'); // 最近优先
    expect(out).not.toContain('观察0'); // 超出封顶的旧观察被丢
  });

  it('忽略非读观察（observePage/写/错误）', () => {
    const entries: LedgerEntry[] = [
      { kind: 'observe', tool: 'observePage', detail: '契约快照一大坨' },
      { kind: 'write', tool: 'invokeAction', refId: 'a', verified: true, evidence: [] },
    ];
    expect(observationDigest(entries)).toBe('');
  });
});
