// Replay/Regression 检查：吃一批已录制的 trace.jsonl（bench_runner.py 的 --trace-path
// 产出），拿每份 trace 的账本用当前代码重跑 computeOutcome，和录制时的 outcome 对比。
// 不重跑任何 LLM/host 调用——用来回答"这次代码改动是否让历史判定结果变了"。
// 用法：npx tsx examples/bench-st/replayCheck.ts <trace目录>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { replayOutcome } from '../../src/core/replay';
import type { TraceEvent } from '../../src/core/trace';

function loadTrace(path: string): TraceEvent[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法: npx tsx examples/bench-st/replayCheck.ts <trace目录>');
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.error(`目录里没有 .jsonl 文件: ${dir}`);
    process.exit(1);
  }
  let mismatches = 0;
  let noFinish = 0;
  for (const file of files) {
    const trace = loadTrace(join(dir, file));
    const result = replayOutcome(trace);
    if (result.recordedOutcome === null) {
      noFinish += 1;
      continue;
    }
    if (!result.matches) {
      mismatches += 1;
      console.log(`[MISMATCH] ${file}: 录制时=${result.recordedOutcome} 重跑后=${result.replayedOutcome}`);
    }
  }
  const checked = files.length - noFinish;
  console.log(`共 ${files.length} 份 trace，${noFinish} 份无 finish 事件（跳过），${checked} 份有效对比，${mismatches} 份判定结果变了`);
}

main();
