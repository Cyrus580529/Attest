import { describe, it, expect } from 'vitest';
import { RefMinter } from '../../src/contract/refs';

describe('RefMinter', () => {
  it('生成 kind:key 形式的 id', () => {
    const m = new RefMinter();
    const ref = m.mint('object', 'task:42');
    expect(ref).toEqual({ kind: 'object', id: 'object:task:42' });
  });

  it('同快照内重复 key 追加 #n 去重', () => {
    const m = new RefMinter();
    const a = m.mint('action', 'apply');
    const b = m.mint('action', 'apply');
    expect(a.id).toBe('action:apply');
    expect(b.id).toBe('action:apply#1');
  });
});
