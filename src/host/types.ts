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
  setControl(ref: Ref, value: string): Promise<HostResult>;
  /** args：带参动作（如 VOIX 带 <prop> 的 tool）的调用参数；无参动作可省略。 */
  invokeAction(ref: Ref, args?: Record<string, unknown>): Promise<HostResult>;
}
