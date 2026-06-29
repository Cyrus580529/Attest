import type { PageSnapshot, Ref } from '../types';
import type { HostAdapter, HostResult } from '../host/types';

export class FakeHostAdapter implements HostAdapter {
  private current: PageSnapshot;
  private readonly transitions: Map<string, PageSnapshot>;
  public readonly log: { kind: string; refId: string }[] = [];

  constructor(initial: PageSnapshot, transitions: Record<string, PageSnapshot> = {}) {
    this.current = initial;
    this.transitions = new Map(Object.entries(transitions));
  }

  snapshot(): PageSnapshot {
    return this.current;
  }

  readSurface(ref: Ref): string {
    return this.current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '';
  }

  openObject(ref: Ref): Promise<HostResult> {
    return this.transition('open', ref);
  }

  navigate(ref: Ref): Promise<HostResult> {
    return this.transition('navigate', ref);
  }

  private transition(kind: string, ref: Ref): Promise<HostResult> {
    this.log.push({ kind, refId: ref.id });
    const next = this.transitions.get(ref.id);
    if (next) this.current = next;
    return Promise.resolve({ ok: true, snapshot: this.current });
  }
}
