import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { diffSnapshots } from '../../src/honesty/verifier';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

describe('diffSnapshots', () => {
  it('无变化 → changed=false', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`);
    const b = build(`<div data-agent-object="task:1">A</div>`);
    expect(diffSnapshots(a, b)).toEqual({ changed: false, details: [] });
  });

  it('url 变化被记录', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`, '/list');
    const b = build(`<div data-agent-object="task:1">A</div>`, '/done');
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('/list') && d.includes('/done'))).toBe(true);
  });

  it('控件值变化被记录', () => {
    const a = build(`<input data-agent-control="amount" value="100" />`);
    const b = build(`<input data-agent-control="amount" value="200" />`);
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('control:amount'))).toBe(true);
  });

  it('对象出现/消失被记录', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`);
    const b = build(`<div data-agent-object="task:2">B</div>`);
    const ev = diffSnapshots(a, b);
    expect(ev.details.some((d) => d.includes('appeared') && d.includes('object:task:2'))).toBe(true);
    expect(ev.details.some((d) => d.includes('gone') && d.includes('object:task:1'))).toBe(true);
  });

  it('控件出现/消失被记录（tab/手风琴/向导换面板）', () => {
    const a = build(`<input data-agent-control="phone" value="" />`);
    const b = build(`<input data-agent-control="fax" value="" />`);
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('appeared') && d.includes('control:fax'))).toBe(true);
    expect(ev.details.some((d) => d.includes('gone') && d.includes('control:phone'))).toBe(true);
  });

  it('动作出现/消失被记录', () => {
    const a = build(`<button data-agent-action="edit">编辑</button>`);
    const b = build(`<button data-agent-action="save">保存</button>`);
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('appeared') && d.includes('action:save'))).toBe(true);
    expect(ev.details.some((d) => d.includes('gone') && d.includes('action:edit'))).toBe(true);
  });

  it('surface 出现被记录（toast/告示是最经典的验证信号）', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`);
    const b = build(`<div data-agent-object="task:1">A</div><section data-agent-surface="toast">Record deleted</section>`);
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('appeared') && d.includes('surface:toast'))).toBe(true);
  });

  it('真实夹具：SuiteCRM record 编辑态 tab 切换（OVERVIEW→MORE INFORMATION）是可观察变化', async () => {
    const { readFileSync } = await import('node:fs');
    const { inferFromAxTree } = await import('../../src/contract/inferFromAxTree');
    const load = (f: string) => {
      const obs = JSON.parse(readFileSync(`test/fixtures/real/${f}`, 'utf8'));
      const nodes = obs.axtree_object?.nodes ?? obs.axtree_object;
      return inferFromAxTree(nodes, obs.url).snapshot;
    };
    const ev = diffSnapshots(load('ax-suitecrm-tab-overview.json'), load('ax-suitecrm-tab-moreinfo.json'));
    expect(ev.changed).toBe(true);
    // 旧面板控件消失（OFFICE PHONE），新面板控件出现（INDUSTRY）
    expect(ev.details.some((d) => d.includes('gone') && d.includes('OFFICE PHONE'))).toBe(true);
    expect(ev.details.some((d) => d.includes('appeared') && d.includes('INDUSTRY'))).toBe(true);
  });
});
