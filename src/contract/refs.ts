import type { Ref, RefKind } from '../types';

/** 在单次快照解析内生成稳定且唯一的 ref id。 */
export class RefMinter {
  private readonly seen = new Map<string, number>();

  mint(kind: RefKind, key: string): Ref {
    const base = `${kind}:${key}`;
    const count = this.seen.get(base) ?? 0;
    this.seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}#${count}`;
    return { kind, id };
  }
}
