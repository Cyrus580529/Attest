import { describe, it, expect, beforeEach } from 'vitest';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';
import { parseContract } from '../../src/contract/parseContract';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import { WRITE_TOOLS, ACT_TOOLS, READ_LOOP_TOOLS } from '../../src/core/tools';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('write tools schema', () => {
  it('WRITE_TOOLS = setControl + invokeAction', () => {
    expect(WRITE_TOOLS.map((t) => t.name).sort()).toEqual(['invokeAction', 'setControl']);
  });
  it('ACT_TOOLS = 读工具 + 写工具', () => {
    expect(ACT_TOOLS).toHaveLength(READ_LOOP_TOOLS.length + WRITE_TOOLS.length);
  });
});

describe('domHostAdapter 写方法', () => {
  it('setControl 写入 input 值', async () => {
    document.body.innerHTML = `<input data-agent-control="amount" value="0" id="amt" />`;
    const adapter = createDomHostAdapter();
    adapter.snapshot();
    await adapter.setControl({ kind: 'control', id: 'control:amount' }, '300');
    expect((document.getElementById('amt') as HTMLInputElement).value).toBe('300');
  });

  it('invokeAction 点击动作元素', async () => {
    document.body.innerHTML = `<button data-agent-action="apply" id="ap">申请</button>`;
    let clicked = false;
    document.getElementById('ap')!.addEventListener('click', () => {
      clicked = true;
    });
    const adapter = createDomHostAdapter();
    adapter.snapshot();
    await adapter.invokeAction({ kind: 'action', id: 'action:apply' });
    expect(clicked).toBe(true);
  });
});

describe('FakeHostAdapter 写方法', () => {
  it('invokeAction 按 ref 转移快照', async () => {
    document.body.innerHTML = `<button data-agent-action="apply">A</button>`;
    const before = parseContract(document.body, '/p');
    document.body.innerHTML = `<section data-agent-surface="ok">已申请</section>`;
    const after = parseContract(document.body, '/done');
    const host = new FakeHostAdapter(before, { 'action:apply': after });
    const r = await host.invokeAction({ kind: 'action', id: 'action:apply' });
    expect(r.snapshot.url).toBe('/done');
    expect(host.log).toEqual([{ kind: 'invoke', refId: 'action:apply' }]);
  });
});
