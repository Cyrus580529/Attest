import { describe, it, expect } from 'vitest';
import { RecipeBook } from '../../src/memory/recipeBook';
import type { Program } from '../../src/core/program/types';

const prog = (answer: string): Program => ({ body: [{ op: 'finish', answer }] });

describe('RecipeBook', () => {
  it('record 后同签名可召回', () => {
    const book = new RecipeBook();
    book.record('sig', { program: prog('a'), goal: '做A', recordedAt: 1 });
    const out = book.recall('sig', 3);
    expect(out).toHaveLength(1);
    expect(out[0]?.goal).toBe('做A');
  });

  it('未知签名召回空', () => {
    expect(new RecipeBook().recall('nope', 3)).toEqual([]);
  });

  it('AST 相同的程序去重（重复 record 仍只一条）', () => {
    const book = new RecipeBook();
    book.record('sig', { program: prog('a'), goal: '第一次', recordedAt: 1 });
    book.record('sig', { program: prog('a'), goal: '第二次', recordedAt: 2 });
    expect(book.recall('sig', 3)).toHaveLength(1);
  });

  it('不同程序累积，召回按上限截断', () => {
    const book = new RecipeBook();
    book.record('sig', { program: prog('a'), goal: 'A', recordedAt: 1 });
    book.record('sig', { program: prog('b'), goal: 'B', recordedAt: 2 });
    book.record('sig', { program: prog('c'), goal: 'C', recordedAt: 3 });
    book.record('sig', { program: prog('d'), goal: 'D', recordedAt: 4 });
    expect(book.recall('sig', 3)).toHaveLength(3);
  });

  it('召回最近优先', () => {
    const book = new RecipeBook();
    book.record('sig', { program: prog('a'), goal: 'A', recordedAt: 1 });
    book.record('sig', { program: prog('b'), goal: 'B', recordedAt: 2 });
    book.record('sig', { program: prog('c'), goal: 'C', recordedAt: 3 });
    const out = book.recall('sig', 3);
    expect(out.map((r) => r.goal)).toEqual(['C', 'B', 'A']);
  });

  it('签名互不串台', () => {
    const book = new RecipeBook();
    book.record('s1', { program: prog('a'), goal: 'A', recordedAt: 1 });
    expect(book.recall('s2', 3)).toEqual([]);
  });
});
