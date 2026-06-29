import { describe, it, expect, beforeEach } from 'vitest';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('domHostAdapter 执行', () => {
  it('openObject 点击对应元素并返回新快照', async () => {
    document.body.innerHTML = `<button data-agent-object="task:5" id="t5">任务5</button>`;
    let clicked = false;
    document.getElementById('t5')!.addEventListener('click', () => {
      clicked = true;
    });
    const adapter = createDomHostAdapter();
    adapter.snapshot();
    const r = await adapter.openObject({ kind: 'object', id: 'object:task:5' });

    expect(clicked).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('readSurface 读取 surface 文本', () => {
    document.body.innerHTML = `<section data-agent-surface="detail">正文内容</section>`;
    const adapter = createDomHostAdapter();
    adapter.snapshot();
    expect(adapter.readSurface({ kind: 'surface', id: 'surface:detail' })).toBe('正文内容');
  });
});
