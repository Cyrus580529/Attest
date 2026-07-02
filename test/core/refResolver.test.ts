import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { resolveRef, resolveObjectByLabel } from '../../src/core/refResolver';

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

  it('前缀重复（模型多加一层）：object:object:task:42 → object:task:42', () => {
    const r = resolveRef(snap(), 'object:object:task:42', 'object');
    expect(r.ok && r.ref.id).toBe('object:task:42');
  });

  it('前缀重复：surface:surface:detail → surface:detail', () => {
    const r = resolveRef(snap(), 'surface:surface:detail', 'surface');
    expect(r.ok && r.ref.id).toBe('surface:detail');
  });

  it('剥一层后仍不存在 → 报错（不乱猜）', () => {
    const r = resolveRef(snap(), 'object:object:task:999', 'object');
    expect(r.ok).toBe(false);
  });
});

describe('resolveObjectByLabel（按描述/标签解析对象，歧义即拒绝）', () => {
  function board() {
    document.body.innerHTML = `
      <li data-agent-object="item:1">登录超时 500</li>
      <li data-agent-object="item:2">支付回调失败</li>
      <li data-agent-object="item:3">导出 CSV 乱码</li>
    `;
    return parseContract(document.body, '/b');
  }

  it('精确 label 匹配 → 解析', () => {
    const r = resolveObjectByLabel(board(), '登录超时 500');
    expect(r.ok && r.ref.id).toBe('object:item:1');
  });

  it('唯一子串（label 含短语）→ 解析', () => {
    const r = resolveObjectByLabel(board(), '支付');
    expect(r.ok && r.ref.id).toBe('object:item:2');
  });

  it('短语含 label → 解析', () => {
    const r = resolveObjectByLabel(board(), '把"导出 CSV 乱码"这条删掉');
    expect(r.ok && r.ref.id).toBe('object:item:3');
  });

  it('多个命中 → error（不猜）', () => {
    document.body.innerHTML = `<li data-agent-object="item:1">登录页问题</li><li data-agent-object="item:2">登录超时</li>`;
    const r = resolveObjectByLabel(parseContract(document.body, '/b'), '登录');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/多个|具体/);
  });

  it('零命中 → error', () => {
    const r = resolveObjectByLabel(board(), '不存在的东西');
    expect(r.ok).toBe(false);
  });
});
