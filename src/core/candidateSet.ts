import type { PageSnapshot, Ref } from '../types';

export class CandidateSet {
  readonly domain: string;
  presented: Ref[];
  cursor = 0;
  selected: Ref | null = null;
  rejected: Ref[] = [];

  constructor(domain: string, presented: Ref[] = []) {
    this.domain = domain;
    this.presented = presented;
  }

  present(refs: Ref[]): void {
    this.presented = refs;
    this.cursor = 0;
  }

  current(): Ref | null {
    return this.presented[this.cursor] ?? null;
  }

  advance(): Ref | null {
    let i = this.cursor + 1;
    while (i < this.presented.length && this.isRejected(this.presented[i]!)) i++;
    if (i >= this.presented.length) return null;
    this.cursor = i;
    return this.presented[i]!;
  }

  select(ref: Ref): void {
    this.selected = ref;
  }

  reject(ref: Ref): void {
    if (!this.isRejected(ref)) this.rejected.push(ref);
  }

  private isRejected(ref: Ref): boolean {
    return this.rejected.some((r) => r.id === ref.id);
  }
}

export function candidatesFromSnapshot(snapshot: PageSnapshot, domain: string): CandidateSet {
  const refs = snapshot.objects.filter((o) => o.type === domain).map((o) => o.ref);
  return new CandidateSet(domain, refs);
}
