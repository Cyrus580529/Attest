import type { PageSnapshot, Ref } from '../types';

export interface HostResult {
  ok: boolean;
  snapshot: PageSnapshot;
  note?: string;
}

export interface HostAdapter {
  snapshot(): PageSnapshot;
  readSurface(ref: Ref): string;
  openObject(ref: Ref): Promise<HostResult>;
  navigate(ref: Ref): Promise<HostResult>;
}
