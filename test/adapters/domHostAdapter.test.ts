import { describe, it, expect, beforeEach } from 'vitest';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('domHostAdapter.snapshot', () => {
  it('对 document.body 解析契约，url 取自 location', () => {
    document.body.innerHTML = `<div data-agent-object="task:7">写测试</div>`;
    const adapter = createDomHostAdapter();
    const snap = adapter.snapshot();

    expect(snap.objects).toHaveLength(1);
    expect(snap.objects[0]?.objectId).toBe('7');
    expect(typeof snap.url).toBe('string');
  });

  it('可传入自定义 root', () => {
    document.body.innerHTML = `
      <div id="scope"><button data-agent-action="apply">a</button></div>
      <button data-agent-action="other">b</button>
    `;
    const scope = document.getElementById('scope')!;
    const adapter = createDomHostAdapter({ root: scope });
    const snap = adapter.snapshot();

    expect(snap.actions.map((a) => a.name)).toEqual(['apply']);
  });
});
