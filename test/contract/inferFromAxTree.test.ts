import { describe, it, expect } from 'vitest';
import { inferFromAxTree, type AxNode } from '../../src/contract/inferFromAxTree';

// BrowserGym 的 axtree_object：CDP 风格扁平节点数组，childIds 组树，browsergym_id 即动作句柄 bid。
const N = (
  nodeId: string,
  role: string,
  name = '',
  extra: Partial<AxNode> = {},
): AxNode => ({ nodeId, role: { value: role }, name: { value: name }, ...extra });

describe('inferFromAxTree——BrowserGym AXTree → PageSnapshot', () => {
  it('四类 role 映射 + bid 表 + provenance=inferred', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', 'CRM', { childIds: ['2', '3', '4', '5'] }),
      N('2', 'button', '保存', { browsergym_id: 'a51' }),
      N('3', 'textbox', '客户名称', { browsergym_id: 'b12', value: { value: '张三' } }),
      N('4', 'listitem', '', { browsergym_id: 'c7', childIds: ['6'] }),
      N('5', 'status', '已保存 3 条记录'),
      N('6', 'StaticText', '订单 #1001'),
    ];
    const { snapshot, bids } = inferFromAxTree(nodes, '/crm');
    expect(snapshot.url).toBe('/crm');

    const act = snapshot.actions.find((a) => a.label === '保存');
    expect(act?.provenance).toBe('inferred');
    expect(bids.get(act!.ref.id)).toBe('a51');

    const ctrl = snapshot.controls.find((c) => c.name === '客户名称');
    expect(ctrl?.value).toBe('张三');
    expect(bids.get(ctrl!.ref.id)).toBe('b12');

    const obj = snapshot.objects[0];
    expect(obj?.label).toContain('订单 #1001'); // 后代文本拼进 label
    expect(bids.get(obj!.ref.id)).toBe('c7');

    expect(snapshot.surfaces.some((s) => s.text.includes('已保存 3 条记录'))).toBe(true);
  });

  it('link/menuitem 也算 action；无 bid 的可交互节点不收（点不了）', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2', '3', '4'] }),
      N('2', 'link', '客户列表', { browsergym_id: 'a1' }),
      N('3', 'menuitem', '导出', { browsergym_id: 'a2' }),
      N('4', 'button', '幽灵按钮'), // 无 bid
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions.map((a) => a.label)).toEqual(['客户列表', '导出']);
  });

  it('ignored 包装节点：跳过自身、继续下钻（CDP 语义——SuiteCRM 主帧树顶就是它）', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2'] }),
      { ...N('2', 'none', '', { childIds: ['3'] }), ignored: true },
      N('3', 'button', '登录', { browsergym_id: 'a1' }),
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions.map((a) => a.label)).toEqual(['登录']);
  });

  it('真实 bench AXTree（SuiteCRM 任务235，162 节点）：快照非空、link 带 bid', async () => {
    const { readFileSync } = await import('node:fs');
    const nodes = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-235.json', 'utf8')) as AxNode[];
    const { snapshot, bids } = inferFromAxTree(nodes, 'http://localhost:8080/');
    expect(snapshot.actions.length).toBeGreaterThan(3);
    const withBid = snapshot.actions.filter((a) => bids.has(a.ref.id));
    expect(withBid.length).toBe(snapshot.actions.length); // action 必带可执行句柄
  });

  it('hidden 属性节点整棵剪掉', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2', '3'] }),
      N('2', 'button', '可见', { browsergym_id: 'a1' }),
      N('3', 'generic', '', {
        childIds: ['4'],
        properties: [{ name: 'hidden', value: { value: true } }],
      }),
      N('4', 'button', '藏着的', { browsergym_id: 'a2' }),
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions.map((a) => a.label)).toEqual(['可见']);
  });

  it('同标签 action 去重、label 截断 80（复用真实页面硬化教训）', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2', '3', '4'] }),
      N('2', 'link', '编辑', { browsergym_id: 'a1' }),
      N('3', 'link', '编辑', { browsergym_id: 'a2' }),
      N('4', 'button', '长'.repeat(200), { browsergym_id: 'a3' }),
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions.filter((a) => a.label === '编辑')).toHaveLength(1);
    expect(snapshot.actions.every((a) => a.label.length <= 80)).toBe(true);
  });

  it('危险动词 → high risk（held 的输入）', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2', '3'] }),
      N('2', 'button', 'Delete record', { browsergym_id: 'a1' }),
      N('3', 'button', '查看', { browsergym_id: 'a2' }),
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions.find((a) => a.label === 'Delete record')?.risk).toBe('high');
    expect(snapshot.actions.find((a) => a.label === '查看')?.risk).toBe('low');
  });
});
