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

  it('提交类动词（save/保存 与 submit/delete 同族——持久化状态变更）推断为高危', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2', '3'] }),
      N('2', 'button', 'Save', { browsergym_id: 'a1' }),
      N('3', 'button', '保存草稿', { browsergym_id: 'a2' }),
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions.map((a) => a.risk)).toEqual(['high', 'high']);
  });

  it('链接组 li（内容全为多个链接=展开的菜单）：不吞为对象，逐链接推断为 action', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2'] }),
      N('2', 'listitem', '', { browsergym_id: 'li1', childIds: ['3', '4', '5'] }),
      N('3', 'link', 'More', { browsergym_id: 'm0' }),
      N('4', 'link', 'Tasks', { browsergym_id: 'm1' }),
      N('5', 'link', 'Notes', { browsergym_id: 'm2' }),
    ];
    const { snapshot, bids } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions.map((a) => a.label)).toEqual(['More', 'Tasks', 'Notes']);
    expect(bids.get(snapshot.actions[1]!.ref.id)).toBe('m1');
    expect(snapshot.objects).toHaveLength(0); // 不再吞成巨型对象（其主链接句柄=More，点了反把菜单关上）
  });

  it('真实夹具：SuiteCRM More 菜单展开后，Tasks/Calls 等菜单项是可点 action', async () => {
    const { readFileSync } = await import('node:fs');
    const obs = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-nav-more-open.json', 'utf8'));
    const nodes = (obs.axtree_object?.nodes ?? obs.axtree_object) as AxNode[];
    const { snapshot, bids } = inferFromAxTree(nodes, obs.url as string);
    const tasks = snapshot.actions.find((a) => a.label === 'Tasks');
    expect(tasks).toBeDefined();
    expect(bids.get(tasks!.ref.id)).toBeTruthy();
    expect(snapshot.actions.some((a) => a.label === 'Calls')).toBe(true);
    // 菜单 blob 不再作为对象出现
    expect(snapshot.objects.some((o) => o.label.includes('Campaigns') && o.label.includes('Tasks'))).toBe(false);
  });

  it('导航 li（内容恰为单个链接）推断为 action 而非对象——SuiteCRM 模块菜单是这个形状', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2'] }),
      N('2', 'list', '', { childIds: ['3', '5'] }),
      N('3', 'listitem', '', { childIds: ['4'] }),
      N('4', 'link', 'Accounts', { browsergym_id: 'n1' }),
      N('5', 'listitem', '', { childIds: ['6', '7'] }), // 多内容 li 仍是对象
      N('6', 'link', '打开', { browsergym_id: 'n2' }),
      N('7', 'StaticText', '订单 #1001 · 金额 500'),
    ];
    const { snapshot, bids } = inferFromAxTree(nodes, '/p');
    const nav = snapshot.actions.find((a) => a.label === 'Accounts');
    expect(nav).toBeTruthy();
    expect(bids.get(nav!.ref.id)).toBe('n1');
    expect(snapshot.objects).toHaveLength(1);
    expect(snapshot.objects[0]!.label).toContain('订单 #1001');
  });

  it('行对象的点击句柄绑到主链接（名字链接）——点行中心会误触行内动作', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2'] }),
      N('2', 'row', '', { browsergym_id: 'row9', childIds: ['3', '4', '5'] }),
      N('3', 'cell', '', { childIds: ['3a'] }),
      N('3a', 'link', 'Wayne Enterprises', { browsergym_id: 'name1' }),
      N('4', 'cell', 'National City'),
      N('5', 'cell', '', { childIds: ['5a'] }),
      N('5a', 'link', 'Log Call', { browsergym_id: 'act1' }),
    ];
    const { snapshot, bids } = inferFromAxTree(nodes, '/p');
    const row = snapshot.objects[0]!;
    expect(row.label.startsWith('Wayne Enterprises')).toBe(true);
    expect(bids.get(row.ref.id)).toBe('name1'); // 主链接，不是 row9
  });

  it('真实 accounts 列表页：Wayne 行的句柄=其名字链接的 bid', async () => {
    const { readFileSync } = await import('node:fs');
    const obs = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-accounts.json', 'utf8'));
    const nodes = (obs.axtree_object?.nodes ?? obs.axtree_object) as AxNode[];
    const { snapshot, bids } = inferFromAxTree(nodes, obs.url);
    const wayne = snapshot.objects.find((o) => o.label.startsWith('Wayne Enterprises'))!;
    const nameLink = nodes.find((n) => n.role?.value === 'link' && n.name?.value === 'Wayne Enterprises')!;
    expect(bids.get(wayne.ref.id)).toBe(nameLink.browsergym_id);
  });

  it('真实 AXTree：模块导航（Accounts/Contacts/Leads）成为 action，label 不重复', async () => {
    const { readFileSync } = await import('node:fs');
    const nodes = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-235.json', 'utf8')) as AxNode[];
    const { snapshot } = inferFromAxTree(nodes, 'http://localhost:8080/');
    const labels = snapshot.actions.map((a) => a.label);
    for (const want of ['Accounts', 'Contacts', 'Leads']) expect(labels).toContain(want);
    expect(labels.some((l) => /^(\S+) \1$/.test(l))).toBe(false); // 无 "Accounts Accounts" 式重复
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

  it('无名控件认领文档序紧邻的前置文本标签（SuiteCRM 表单无 label 关联）', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2', '3', '4', '5'] }),
      N('2', 'StaticText', 'OFFICE PHONE'),
      N('3', 'textbox', '', { browsergym_id: 'b1' }),
      N('4', 'StaticText', 'FAX'),
      N('5', 'textbox', '', { browsergym_id: 'b2' }),
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.controls.map((c) => c.name)).toEqual(['OFFICE PHONE', 'FAX']);
  });

  it('真实编辑态表单（SuiteCRM record edit）：控件不再是无名氏', async () => {
    const { readFileSync } = await import('node:fs');
    const obs = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-editform.json', 'utf8'));
    const nodes = (obs.axtree_object?.nodes ?? obs.axtree_object) as AxNode[];
    const { snapshot } = inferFromAxTree(nodes, obs.url);
    const names = snapshot.controls.map((c) => c.name);
    expect(names).toContain('OFFICE PHONE');
    expect(names).toContain('WEBSITE');
    // 匿名兜底名（'textbox'）不得超过 2 个
    expect(names.filter((n2) => n2 === 'textbox').length).toBeLessThanOrEqual(2);
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
