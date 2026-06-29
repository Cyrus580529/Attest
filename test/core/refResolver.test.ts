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
