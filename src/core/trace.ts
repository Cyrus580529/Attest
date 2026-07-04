import type { AgentStep } from './loopTypes';

export interface TraceEvent {
  seq: number;
  ts: string;
  step: AgentStep;
}

/**
 * 把一次任务运行的 AgentStep 序列序列化成稳定的逐行事件格式（trace.jsonl 的内核侧产出）。
 * 内核只序列化、不做 I/O——落盘/上传是宿主的事（沿用切片9 WorldModel 持久化的先例）。
 * now 可注入固定时钟，方便测试；默认取系统时间。
 */
export function serializeTrace(
  steps: readonly AgentStep[],
  now: () => string = () => new Date().toISOString(),
): TraceEvent[] {
  return steps.map((step, seq) => ({ seq, ts: now(), step }));
}
