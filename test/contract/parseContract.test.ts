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

describe('parseContract — actions', () => {
  it('解析 action，默认 risk=low', () => {
    document.body.innerHTML = `<button data-agent-action="apply">申请</button>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.actions).toEqual([
      { ref: { kind: 'action', id: 'action:apply' }, name: 'apply', label: '申请', risk: 'low' },
    ]);
  });

  it('data-agent-risk="high" 标记高危动作', () => {
    document.body.innerHTML = `<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.actions[0]?.risk).toBe('high');
  });
});

describe('parseContract — controls', () => {
  it('input 控件读取 value', () => {
    document.body.innerHTML = `<input data-agent-control="bidAmount" value="200" />`;
    const snap = parseContract(document.body, 'u');
    expect(snap.controls).toEqual([
      { ref: { kind: 'control', id: 'control:bidAmount' }, name: 'bidAmount', label: '', value: '200' },
    ]);
  });

  it('非表单元素控件 value 为 null，label 取文本', () => {
    document.body.innerHTML = `<div data-agent-control="priority">高</div>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.controls[0]).toEqual({
      ref: { kind: 'control', id: 'control:priority' },
      name: 'priority',
      label: '高',
      value: null,
    });
  });
});

describe('parseContract — surfaces', () => {
  it('surface 读取可读文本', () => {
    document.body.innerHTML = `<section data-agent-surface="detail"> 任务  详情 </section>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.surfaces).toEqual([
      { ref: { kind: 'surface', id: 'surface:detail' }, name: 'detail', text: '任务 详情' },
    ]);
  });
});
