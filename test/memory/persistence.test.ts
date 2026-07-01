import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { WorldModel } from '../../src/memory/worldModel';
import { RecipeBook } from '../../src/memory/recipeBook';
import type { Program } from '../../src/core/program/types';

const snap = () => {
  document.body.innerHTML = `<button data-agent-action="save">保存</button>`;
  return parseContract(document.body, '/p');
};

/** 模拟一趟"存盘再读盘"（经 JSON 字符串往返，等价文件/localStorage）。 */
const roundtrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('WorldModel 持久化', () => {
  it('toJSON → fromJSON 往返后先验仍在（跨会话记忆）', () => {
    const wm = new WorldModel();
    wm.learn(snap(), 'save', { changed: true, details: ['surface s changed'] });

    const restored = WorldModel.fromJSON(roundtrip(wm.toJSON()));
    expect(restored.predict(snap(), 'save')).toEqual({ expectDetails: ['surface s changed'] });
  });

  it('空模型往返仍为空', () => {
    const restored = WorldModel.fromJSON(roundtrip(new WorldModel().toJSON()));
    expect(restored.predict(snap(), 'save')).toBeNull();
  });
});

describe('RecipeBook 持久化', () => {
  it('toJSON → fromJSON 往返后配方可召回', () => {
    const program: Program = { body: [{ op: 'invoke', action: 'save' }, { op: 'finish', answer: 'ok' }] };
    const rb = new RecipeBook();
    rb.record('sig-1', { program, goal: '保存', recordedAt: 123 });

    const restored = RecipeBook.fromJSON(roundtrip(rb.toJSON()));
    const recalled = restored.recall('sig-1', 3);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toEqual({ program, goal: '保存', recordedAt: 123 });
  });

  it('往返后 record 去重语义仍生效（同签名不同签名互不串）', () => {
    const rb = new RecipeBook();
    rb.record('a', { program: { body: [{ op: 'finish', answer: 'x' }] }, goal: 'A', recordedAt: 1 });
    const restored = RecipeBook.fromJSON(roundtrip(rb.toJSON()));
    expect(restored.recall('b', 3)).toHaveLength(0); // 不同签名不召回
    expect(restored.recall('a', 3)).toHaveLength(1);
  });
});
