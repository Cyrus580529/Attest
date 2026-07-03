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

  it('自适应 settle：动作后 obs 已见变化 → 跳过 settle noop（bench 20 步预算，开销减半）', async () => {
    const sent: string[] = [];
    const host = createBenchHostAdapter({
      initialObs: obs1,
      execute: async (a) => { sent.push(a); return obs2; }, // 效果立即可见
    });
    const save = host.snapshot().actions.find((x) => x.label === '保存')!;
    const r = await host.invokeAction(save.ref);
    expect(sent).toEqual(['click("a51")']); // 无 noop
    expect(r.ok).toBe(true);
  });

  const NOT_INPUT = 'Error: Locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element';
  const selObs = (value: string, extraNodes: AxNode[] = [], err?: string): BenchObs => ({
    url: '/crm',
    last_action_error: err,
    axtree_object: {
      nodes: [
        N('1', 'RootWebArea', '', { childIds: ['2', ...extraNodes.map((n) => n.nodeId)] }),
        N('2', 'combobox', 'PRIORITY', { browsergym_id: 'c1', value: { value } }),
        ...extraNodes,
      ],
    },
  });

  it('setControl 非输入控件：fill 报错 → 回退 select_option（原生 select 一步到位）', async () => {
    const sent: string[] = [];
    const host = createBenchHostAdapter({
      initialObs: selObs('Medium'),
      settleAction: null,
      execute: async (a) => {
        sent.push(a);
        return a.startsWith('fill(') ? selObs('Medium', [], NOT_INPUT) : selObs('High');
      },
    });
    const ctrl = host.snapshot().controls[0]!;
    const r = await host.setControl(ctrl.ref, 'High');
    expect(sent).toEqual(['fill("c1", "High")', 'select_option("c1", "High")']);
    expect(r.ok).toBe(true);
  });

  it('setControl 自定义下拉：select_option 也失败 → 点开控件、按文本点选项', async () => {
    const options = [
      N('10', 'option', 'Low', { browsergym_id: 'o1' }),
      N('11', 'option', 'High', { browsergym_id: 'o2' }),
    ];
    const sent: string[] = [];
    const host = createBenchHostAdapter({
      initialObs: selObs('Medium'),
      settleAction: null,
      execute: async (a) => {
        sent.push(a);
        if (a.startsWith('fill(')) return selObs('Medium', [], NOT_INPUT);
        if (a.startsWith('select_option(')) return selObs('Medium', [], 'Error: not a <select> element');
        if (a === 'click("c1")') return selObs('Medium', options); // 下拉展开
        return selObs('High'); // 点了选项
      },
    });
    const ctrl = host.snapshot().controls[0]!;
    const r = await host.setControl(ctrl.ref, 'High');
    expect(sent).toEqual(['fill("c1", "High")', 'select_option("c1", "High")', 'click("c1")', 'click("o2")']);
    expect(r.ok).toBe(true);
  });

  it('setControl 自定义下拉：目标选项不存在 → ok:false 且 note 列出真实可选项', async () => {
    const options = [
      N('10', 'option', 'Low', { browsergym_id: 'o1' }),
      N('11', 'option', 'High', { browsergym_id: 'o2' }),
    ];
    const host = createBenchHostAdapter({
      initialObs: selObs('Medium'),
      settleAction: null,
      execute: async (a) => {
        if (a.startsWith('fill(')) return selObs('Medium', [], NOT_INPUT);
        if (a.startsWith('select_option(')) return selObs('Medium', [], 'Error: not a <select> element');
        return selObs('Medium', options);
      },
    });
    const ctrl = host.snapshot().controls[0]!;
    const r = await host.setControl(ctrl.ref, 'Urgent');
    expect(r.ok).toBe(false);
    expect(r.note).toContain('Low');
    expect(r.note).toContain('High');
  });
});
