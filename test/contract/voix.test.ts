import { describe, it, expect } from 'vitest';
import { parseVoix } from '../../src/contract/voix';
import type { ContractSource } from '../../src/contract/contractSource';

function build(html: string, url = '/app') {
  document.body.innerHTML = html;
  return parseVoix(document.body, url);
}

describe('parseVoix（骑 VOIX 契约：<tool>/<context> → PageSnapshot）', () => {
  it('<tool> → action（name + description 作 label）', () => {
    const snap = build(`<tool name="save" description="保存当前任务"></tool>`);
    expect(snap.actions).toHaveLength(1);
    expect(snap.actions[0]).toMatchObject({ name: 'save', label: '保存当前任务', risk: 'low' });
    expect(snap.actions[0]!.ref.kind).toBe('action');
    expect(snap.actions[0]!.provenance).toBe('authored'); // VOIX 是声明式，非推断
  });

  it('<context> → surface（name + 纯文本）', () => {
    const snap = build(`<context name="tasks">当前有 3 个任务</context>`);
    expect(snap.surfaces).toHaveLength(1);
    expect(snap.surfaces[0]).toMatchObject({ name: 'tasks', text: '当前有 3 个任务' });
    expect(snap.surfaces[0]!.ref.kind).toBe('surface');
  });

  it('危险动词的 tool → 保守判为 high-risk（held 的依据）', () => {
    const snap = build(`<tool name="delete" description="删除这个任务"></tool>`);
    expect(snap.actions[0]!.risk).toBe('high');
  });

  it('显式 risk="high" 属性覆盖推断', () => {
    const snap = build(`<tool name="ship" description="发布" risk="high"></tool>`);
    expect(snap.actions[0]!.risk).toBe('high');
  });

  it('缺 name 的 tool 跳过；context 缺 name 用回退名', () => {
    const snap = build(`<tool description="没名字"></tool><context>裸文本</context>`);
    expect(snap.actions).toHaveLength(0);
    expect(snap.surfaces).toHaveLength(1);
    expect(snap.surfaces[0]!.name).toBe('context');
  });

  it('<prop> 子元素 → action.params（name/type/required/description）', () => {
    const snap = build(
      `<tool name="create_task" description="创建任务">` +
        `<prop name="title" type="string" description="标题" required></prop>` +
        `<prop name="priority" type="number"></prop>` +
        `</tool>`,
    );
    expect(snap.actions[0]!.params).toEqual([
      { name: 'title', type: 'string', description: '标题', required: true },
      { name: 'priority', type: 'number', required: false },
    ]);
  });

  it('无 <prop> 的 tool → params 省略（undefined）', () => {
    const snap = build(`<tool name="save" description="保存"></tool>`);
    expect(snap.actions[0]!.params).toBeUndefined();
  });

  it('parseVoix 符合 ContractSource 签名（可插拔）', () => {
    const src: ContractSource = parseVoix;
    const snap = src(document.body, '/x');
    expect(snap.url).toBe('/x');
  });
});
