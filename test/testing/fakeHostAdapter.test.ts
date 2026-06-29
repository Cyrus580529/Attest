import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';

function listSnap() {
  document.body.innerHTML = `<div data-agent-object="task:1">列表项</div>`;
  return parseContract(document.body, '/list');
}
function detailSnap() {
  document.body.innerHTML = `<section data-agent-surface="detail">详情正文</section>`;
  return parseContract(document.body, '/detail');
}

describe('FakeHostAdapter', () => {
  it('openObject 按 ref 转移到目标快照并记录', async () => {
    const detail = detailSnap();
    const host = new FakeHostAdapter(listSnap(), { 'object:task:1': detail });
    const r = await host.openObject({ kind: 'object', id: 'object:task:1' });

    expect(r.ok).toBe(true);
    expect(host.snapshot().url).toBe('/detail');
    expect(host.log).toEqual([{ kind: 'open', refId: 'object:task:1' }]);
  });

  it('readSurface 从当前快照读文本', () => {
    const host = new FakeHostAdapter(detailSnap());
    expect(host.readSurface({ kind: 'surface', id: 'surface:detail' })).toBe('详情正文');
  });
});
