import { describe, it, expect } from 'vitest';
import { createBenchHostAdapter, pyStr, type BenchObs } from '../../examples/bench-st/benchHost';
import type { AxNode } from '../../src/contract/inferFromAxTree';

const N = (nodeId: string, role: string, name = '', extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
});

const obs1: BenchObs = {
  url: '/crm',
  axtree_object: {
    nodes: [
      N('1', 'RootWebArea', '', { childIds: ['2', '3', '4'] }),
      N('2', 'button', '保存', { browsergym_id: 'a51' }),
      N('3', 'textbox', '名称', { browsergym_id: 'b12', value: { value: '' } }),
      N('4', 'status', '就绪'),
    ],
  },
};
const obs2: BenchObs = {
  url: '/crm',
  axtree_object: {
    nodes: [
      N('1', 'RootWebArea', '', { childIds: ['2', '3', '4'] }),
      N('2', 'button', '保存', { browsergym_id: 'a51' }),
      N('3', 'textbox', '名称', { browsergym_id: 'b12', value: { value: '张三' } }),
      N('4', 'status', '已保存'),
    ],
  },
};

describe('BenchHostAdapter——obs→快照、写→BrowserGym 动作串', () => {
  it('invokeAction 发 click(bid) + settle noop 重取 obs（Angular 异步渲染后才是真快照）', async () => {
    const sent: string[] = [];
    const host = createBenchHostAdapter({
      initialObs: obs1,
      execute: async (a) => { sent.push(a); return sent.length > 1 ? obs2 : obs1; }, // 效果只在 settle 后可见
    });
    const before = host.snapshot();
    const save = before.actions.find((x) => x.label === '保存')!;
    const r = await host.invokeAction(save.ref);
    expect(sent).toEqual(['click("a51")', 'noop(700)']);
    expect(r.ok).toBe(true);
    expect(r.snapshot.surfaces[0]?.text).toBe('已保存');
  });

  it('setControl 发 fill(bid, value)，值转义成 Python 字面量；settleAction:null 可关', async () => {
    const sent: string[] = [];
    const host = createBenchHostAdapter({
      initialObs: obs1,
      settleAction: null,
      execute: async (a) => { sent.push(a); return obs2; },
    });
    const ctrl = host.snapshot().controls[0]!;
    await host.setControl(ctrl.ref, "O'Brien\n第二行");
    expect(sent).toEqual(['fill("b12", "O\'Brien 第二行")']);
  });

  it('快照可重照（同 obs 两照 id 集一致）；bid 缺失 → ok:false 不发动作', async () => {
    const host = createBenchHostAdapter({ initialObs: obs1, execute: async () => obs2 });
    const a = host.snapshot(); const b = host.snapshot();
    expect(a.actions[0]?.ref.id).toBe(b.actions[0]?.ref.id);
    const r = await host.invokeAction({ kind: 'action', id: 'action:不存在' });
    expect(r.ok).toBe(false);
  });

  it('pyStr 是合法双引号字面量（反斜杠/双引号转义、换行压平）', () => {
    expect(pyStr(String.raw`a\b"c`)).toBe(String.raw`"a\\b\"c"`);
    expect(pyStr('x\ny')).toBe('"x y"');
  });
});
