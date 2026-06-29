import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { resolveRef } from '../../src/core/refResolver';

function snap() {
  document.body.innerHTML = `
    <div data-agent-object="task:42">T</div>
    <section data-agent-surface="detail">D</section>
  `;
  return parseContract(document.body, 'u');
}

describe('resolveRef', () => {
  it('ref 存在且 kind 匹配 → ok', () => {
    const r = resolveRef(snap(), 'object:task:42', 'object');
    expect(r).toEqual({ ok: true, ref: { kind: 'object', id: 'object:task:42' } });
  });

  it('ref 不存在 → error', () => {
    const r = resolveRef(snap(), 'object:task:999', 'object');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not found');
  });

  it('ref 存在但 kind 不符 → error 指出实际 kind', () => {
    const r = resolveRef(snap(), 'surface:detail', 'object');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('is a surface');
  });
});

describe('resolveRef 容错（模型省略 kind 前缀）', () => {
  it('object 省略前缀：task:42 → object:task:42', () => {
    const r = resolveRef(snap(), 'task:42', 'object');
    expect(r.ok && r.ref.id).toBe('object:task:42');
  });

  it('surface 省略前缀：detail → surface:detail', () => {
    const r = resolveRef(snap(), 'detail', 'surface');
    expect(r.ok && r.ref.id).toBe('surface:detail');
  });

  it('补全后仍不存在 → 报错（不乱猜）', () => {
    const r = resolveRef(snap(), 'detail', 'object'); // object:detail 不存在
    expect(r.ok).toBe(false);
  });
});
