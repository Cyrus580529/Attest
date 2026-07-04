import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { inferContract } from '../../src/contract/inferContract';
import type { PageSnapshot } from '../../src/types';

// ── 合成小例：每条硬化规则一测 ──
describe('inferContract 硬化（合成例）', () => {
  it('隐藏元素不进契约：type=hidden / hidden 属性 / aria-hidden 祖先', () => {
    document.body.innerHTML =
      '<input type="hidden" name="csrf_token" value="x" />' +
      '<input name="visible" value="1" />' +
      '<button hidden>看不见的按钮</button>' +
      '<div aria-hidden="true"><button>装饰按钮</button></div>' +
      '<button>真按钮</button>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.controls.map((c) => c.name)).toEqual(['visible']);
    expect(snapshot.actions.map((a) => a.label)).toEqual(['真按钮']);
  });

  it('同标签 action 去重，只留第一个', () => {
    document.body.innerHTML = '<a href="/1">隐藏</a><a href="/2">隐藏</a><a href="/3">隐藏</a><a href="/4">打开</a>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.actions.map((a) => a.label)).toEqual(['隐藏', '打开']);
  });

  it('label 超长截断到 80 字符', () => {
    document.body.innerHTML = `<button>${'长'.repeat(200)}</button>`;
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.actions[0]!.label.length).toBeLessThanOrEqual(80);
  });

  it('容器 li（内含 li 的菜单容器）跳过，只取叶子', () => {
    document.body.innerHTML = '<ul><li>父菜单<ul><li>子项A</li><li>子项B</li></ul></li></ul>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.objects.map((o) => o.label)).toEqual(['子项A', '子项B']);
  });

  it('nav/footer 里的 li 不当数据对象（那是导航，不是数据）', () => {
    document.body.innerHTML =
      '<nav><ul><li>首页</li><li>关于</li></ul></nav>' +
      '<ul><li>订单 #1</li></ul>' +
      '<footer><ul><li>条款</li></ul></footer>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.objects.map((o) => o.label)).toEqual(['订单 #1']);
  });

  it('带 id 的表格行当对象候选（HN athing 型布局）', () => {
    document.body.innerHTML =
      '<table><tr id="story-1"><td>故事一</td></tr><tr><td>布局行不算</td></tr><tr id="story-2"><td>故事二</td></tr></table>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.objects.map((o) => o.label)).toEqual(['故事一', '故事二']);
  });

  it('<nav> 里的链接打上 category:nav；<nav> 外的按钮不受影响', () => {
    document.body.innerHTML = '<nav><a href="/accounts">Accounts</a></nav><button>Save</button>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.actions.find((a) => a.label === 'Accounts')?.category).toBe('nav');
    expect(snapshot.actions.find((a) => a.label === 'Save')?.category).toBeUndefined();
  });

  it('role=tab 元素被识别为 action 且打上 category:nav', () => {
    document.body.innerHTML = '<div role="tab">Overview</div>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.actions[0]?.label).toBe('Overview');
    expect(snapshot.actions[0]?.category).toBe('nav');
  });
});

// ── 真实页面集成：质量水位线 ──
function loadFixture(name: string): PageSnapshot {
  const html = readFileSync(`test/fixtures/real/${name}.html`, 'utf8');
  const w = new Window({
    settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true },
  });
  w.document.write(html);
  return inferContract(w.document.body as unknown as ParentNode, `/${name}`).snapshot;
}

describe('inferContract 真实页面水位线', () => {
  it('HN：表格行成为对象（不再 0 对象），action 无重复标签', () => {
    const s = loadFixture('hn');
    expect(s.objects.length).toBeGreaterThan(10); // athing 行
    const labels = s.actions.map((a) => a.label);
    expect(labels.length).toBe(new Set(labels).size);
  });

  it('GitHub 登录页：隐藏 token 控件绝不入契约，登录表单控件在', () => {
    const s = loadFixture('github-login');
    expect(s.controls.some((c) => c.name === 'authenticity_token')).toBe(false);
    expect(s.controls.some((c) => /login|username|email/i.test(c.name))).toBe(true);
    expect(s.controls.some((c) => /password/i.test(c.name))).toBe(true);
  });

  it('Wikipedia：导航 li 不再当对象，无超长 label', () => {
    const s = loadFixture('wikipedia');
    expect(s.objects.some((o) => o.label === 'Main page')).toBe(false);
    for (const n of [...s.objects, ...s.actions]) {
      expect(n.label.length).toBeLessThanOrEqual(80);
    }
  });
});
