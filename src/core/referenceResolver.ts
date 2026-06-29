import type { PageSnapshot, Ref } from '../types';
import type { CandidateSet } from './candidateSet';

export type Reference = { ok: true; ref: Ref; via: string } | { ok: false; clarify: string };

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseIndex(raw: string): number {
  return /^[0-9]+$/.test(raw) ? Number(raw) : (CN_NUM[raw] ?? NaN);
}

export function resolveReference(
  phrase: string,
  snapshot: PageSnapshot,
  candidates: CandidateSet,
): Reference {
  const p = phrase.trim();

  if (/换(一个|个)|下一个|其他|别的/.test(p)) {
    const next = candidates.advance();
    return next
      ? { ok: true, ref: next, via: 'next-candidate' }
      : { ok: false, clarify: '没有更多候选了，要不要我重新列一遍？' };
  }

  const ord = p.match(/第\s*([0-9]+|[一二三四五六七八九十])\s*个/);
  if (ord) {
    const n = parseIndex(ord[1]!);
    const ref = candidates.presented[n - 1];
    return ref ? { ok: true, ref, via: 'ordinal' } : { ok: false, clarify: `没有第 ${n} 个候选。` };
  }

  if (/随便|任意|都行|你来定|你定/.test(p)) {
    const ref = candidates.current();
    return ref ? { ok: true, ref, via: 'arbitrary' } : { ok: false, clarify: '当前没有候选可选。' };
  }

  if (/这个|那个|就它|就这个|选它|要它/.test(p)) {
    const ref = candidates.selected ?? candidates.current();
    return ref ? { ok: true, ref, via: 'current' } : { ok: false, clarify: '你指的是哪一个？' };
  }

  const byName = snapshot.objects.find((o) => o.label.length > 0 && p.includes(o.label));
  if (byName) return { ok: true, ref: byName.ref, via: 'name' };

  return { ok: false, clarify: '你指的是哪一个？' };
}
