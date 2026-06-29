import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { candidatesFromSnapshot } from '../../src/core/candidateSet';
import { resolveReference } from '../../src/core/referenceResolver';

function setup() {
  document.body.innerHTML = `
    <div data-agent-object="task:1">修复登录</div>
    <div data-agent-object="task:2">优化首页</div>
  `;
  const snap = parseContract(document.body, '/list');
  const cs = candidatesFromSnapshot(snap, 'task');
  return { snap, cs };
}

describe('resolveReference', () => {
  it('"换一个" 推进候选', () => {
    const { snap, cs } = setup();
    const r = resolveReference('换一个', snap, cs);
    expect(r.ok && r.ref.id).toBe('object:task:2');
  });

  it('"就它/这个" 取当前或已选', () => {
    const { snap, cs } = setup();
    const r = resolveReference('就它吧', snap, cs);
    expect(r.ok && r.ref.id).toBe('object:task:1');
  });

  it('"第二个" 取序号', () => {
    const { snap, cs } = setup();
    const r = resolveReference('看第二个', snap, cs);
    expect(r.ok && r.ref.id).toBe('object:task:2');
  });

  it('明确名称匹配', () => {
    const { snap, cs } = setup();
    const r = resolveReference('打开优化首页', snap, cs);
    expect(r.ok && r.ref.id).toBe('object:task:2');
  });

  it('无指代线索 → 要求澄清', () => {
    const { snap, cs } = setup();
    const r = resolveReference('我拿不定主意', snap, cs);
    expect(r.ok).toBe(false);
  });
});
