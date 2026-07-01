import type { PageSnapshot, Ref } from '../types';

export type RecordedRef =
  | { by: 'name'; kind: 'action' | 'control' | 'surface'; name: string }
  | { by: 'ordinal'; type: string; index: number };

export interface RecordedStep {
  tool: string;
  ref?: RecordedRef;
  value?: string;
  answer?: string;
  /** 录制时该写步经验证的 diff details——重放时作预测，抓页面行为漂移。 */
  observedDiff?: string[];
}

export interface MemoryEntry {
  steps: RecordedStep[];
  recordedAt: number;
}

export function recordRef(snapshot: PageSnapshot, ref: Ref): RecordedRef | undefined {
  if (ref.kind === 'object') {
    const obj = snapshot.objects.find((o) => o.ref.id === ref.id);
    if (!obj) return undefined;
    const sameType = snapshot.objects.filter((o) => o.type === obj.type);
    return { by: 'ordinal', type: obj.type, index: sameType.findIndex((o) => o.ref.id === ref.id) };
  }
  const pool =
    ref.kind === 'action' ? snapshot.actions : ref.kind === 'control' ? snapshot.controls : snapshot.surfaces;
  const node = (pool as readonly { ref: Ref; name: string }[]).find((n) => n.ref.id === ref.id);
  return node ? { by: 'name', kind: ref.kind, name: node.name } : undefined;
}

export function resolveRecordedRef(snapshot: PageSnapshot, rec: RecordedRef): Ref | null {
  if (rec.by === 'ordinal') {
    const sameType = snapshot.objects.filter((o) => o.type === rec.type);
    return sameType[rec.index]?.ref ?? null;
  }
  const pool =
    rec.kind === 'action' ? snapshot.actions : rec.kind === 'control' ? snapshot.controls : snapshot.surfaces;
  return (pool as readonly { ref: Ref; name: string }[]).find((n) => n.name === rec.name)?.ref ?? null;
}

export class PageMemory {
  private readonly store = new Map<string, MemoryEntry>();

  record(key: string, steps: RecordedStep[]): void {
    this.store.set(key, { steps, recordedAt: Date.now() });
  }

  lookup(key: string): MemoryEntry | null {
    return this.store.get(key) ?? null;
  }
}
