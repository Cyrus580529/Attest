import { describe, it, expect } from 'vitest';
import { parseContract } from '../../../src/contract/parseContract';
import { fromMemory } from '../../../src/core/speculation/sources';
import type { RecordedStep } from '../../../src/memory/pageMemory';

const board = () => {
  document.body.innerHTML = `<button data-agent-action="done">完成</button><section data-agent-surface="s">待办</section>`;
  return parseContract(document.body, '/p');
};

describe('fromMemory 预测源', () => {
  it('按录制顺序产出 (call, predict)，predict 来自 observedDiff', () => {
    const steps: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: 'done' }, observedDiff: ['surface s changed'] },
      { tool: 'finish', answer: '完成了' },
    ];
    const src = fromMemory(steps);
    const first = src.next(board());
    expect(first).not.toBeNull();
    expect(first!.call?.name).toBe('invokeAction');
    expect(first!.call?.arguments.ref).toBe('action:done');
    expect(first!.predict).toEqual({ expectDetails: ['surface s changed'] });

    const second = src.next(board());
    expect(second!.call?.name).toBe('finish');

    expect(src.next(board())).toBeNull(); // 耗尽
  });

  it('无 observedDiff 的步 → 无 predict（只走 ref 解析 + verify 闸）', () => {
    const steps: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: 'done' } },
    ];
    const src = fromMemory(steps);
    const first = src.next(board());
    expect(first!.predict).toBeUndefined();
  });

  it('录制 ref 在当前页解析不出 → 返回 { call: null } 标记失效', () => {
    const steps: RecordedStep[] = [
      { tool: 'invokeAction', ref: { by: 'name', kind: 'action', name: '不存在' } },
    ];
    const src = fromMemory(steps);
    expect(src.next(board())).toEqual({ call: null });
  });
});
