import { describe, it, expect, beforeEach } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('parseContract — objects', () => {
  it('把 data-agent-object="type:id" 解析为 ObjectNode', () => {
    document.body.innerHTML = `
      <div data-agent-object="task:42">修复登录页</div>
      <div data-agent-object="task:43">  优化   首页  </div>
    `;
    const snap = parseContract(document.body, 'https://app.test/tasks');

    expect(snap.url).toBe('https://app.test/tasks');
    expect(snap.objects).toEqual([
      { ref: { kind: 'object', id: 'object:task:42' }, type: 'task', objectId: '42', label: '修复登录页' },
      { ref: { kind: 'object', id: 'object:task:43' }, type: 'task', objectId: '43', label: '优化 首页' },
    ]);
  });

  it('缺少 ":" 的对象声明被跳过', () => {
    document.body.innerHTML = `<div data-agent-object="broken">x</div>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.objects).toEqual([]);
  });
});
