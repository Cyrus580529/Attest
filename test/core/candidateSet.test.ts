import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { CandidateSet, candidatesFromSnapshot } from '../../src/core/candidateSet';

function snap() {
  document.body.innerHTML = `
    <div data-agent-object="task:1">A</div>
    <div data-agent-object="task:2">B</div>
    <div data-agent-object="task:3">C</div>
    <div data-agent-object="product:9">P</div>
  `;
  return parseContract(document.body, '/list');
}

describe('candidatesFromSnapshot', () => {
  it('按 domain 收集对象候选', () => {
    const cs = candidatesFromSnapshot(snap(), 'task');
    expect(cs.presented.map((r) => r.id)).toEqual(['object:task:1', 'object:task:2', 'object:task:3']);
    expect(cs.current()?.id).toBe('object:task:1');
  });
});

describe('CandidateSet', () => {
  it('advance 换一个，跳过 rejected', () => {
    const cs = candidatesFromSnapshot(snap(), 'task');
    cs.reject(cs.current()!);
    expect(cs.advance()?.id).toBe('object:task:2');
  });

  it('advance 到末尾返回 null', () => {
    const cs = candidatesFromSnapshot(snap(), 'task');
    cs.advance();
    cs.advance();
    expect(cs.advance()).toBeNull();
  });

  it('select 记录选中', () => {
    const cs = candidatesFromSnapshot(snap(), 'task');
    cs.select(cs.current()!);
    expect(cs.selected?.id).toBe('object:task:1');
  });
});
