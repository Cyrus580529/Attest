// 【实验/可行性探针】从语义化 HTML + ARIA 推断契约（无 data-agent-*）。
// 目标：验证"让契约自动长出来"是否可行——同样的信任内核驱动未标注页面。
// 推断的 handle 来源 = inferred（与 parseContract 的 authored 区分）；写路径对 inferred 一律 held。
// 硬化基于真实页面夹具（test/fixtures/real：HN/GitHub 登录/Wikipedia）暴露的四类垃圾：
// 隐藏控件（csrf token）混入、同标签动作爆炸、导航 li 冒充数据对象、超长 label。
import type { ActionNode, ControlNode, ObjectNode, PageSnapshot, Risk, SurfaceNode } from '../types';
import { RefMinter } from './refs';
import { collectScopes, queryAllDeep } from './queryAllDeep';

const HIGH_RISK = /delete|remove|destroy|删除|删|清空|移除|pay|支付|purchase|checkout|confirm|确认|submit|提交|发送|send|save|保存/i;
const MAX_LABEL = 80;

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function clip(s: string): string {
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s;
}

/** 属性级可见性：hidden 属性或 aria-hidden 祖先链。不解析 CSS（display:none 拿不到，如实不装懂）。 */
function isHidden(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true') return true;
    cur = cur.parentElement;
  }
  return false;
}

function labelFor(root: ParentNode, el: Element): string {
  const id = el.getAttribute('id');
  if (!id) return '';
  // 不用 CSS.escape：它是浏览器全局，纯 Node 环境（如夹具评估）没有；逐个比对 for 属性更稳。
  for (const lbl of root.querySelectorAll('label[for]')) {
    if (lbl.getAttribute('for') === id) return clean(lbl.textContent);
  }
  return '';
}

export interface InferResult {
  snapshot: PageSnapshot;
  elements: Map<string, Element>;
}

export function inferContract(root: ParentNode, url: string): InferResult {
  const scopes = collectScopes(root);
  const minter = new RefMinter();
  const elements = new Map<string, Element>();
  const objects: ObjectNode[] = [];
  const actions: ActionNode[] = [];
  const controls: ControlNode[] = [];
  const surfaces: SurfaceNode[] = [];

  // 对象：列表项 / 文章 / 卡片 / 行 / 带 id 的表格行（HN athing 型布局）。
  // 跳过：容器 li（内含 li 的是菜单壳）、nav/footer 里的 li（导航不是数据）、隐藏元素。
  let oi = 0;
  for (const el of queryAllDeep(root, 'li, [role="listitem"], article, [role="article"], [role="row"], tr[id]', scopes)) {
    if (isHidden(el)) continue;
    if (el.tagName === 'LI' && (el.querySelector('li') || el.closest('nav, footer'))) continue;
    const label = clip(clean(el.textContent));
    if (!label) continue;
    oi += 1;
    const ref = minter.mint('object', `item:${oi}`);
    objects.push({ ref, type: 'item', objectId: String(oi), label, provenance: 'inferred' });
    elements.set(ref.id, el);
  }

  // 动作：按钮 / role=button / submit / 链接。同标签去重只留第一个（真实页面同名链接成群）。
  const seenAction = new Set<string>();
  for (const el of queryAllDeep(root, 'button, [role="button"], input[type="submit"], input[type="button"], a[href]', scopes)) {
    if (isHidden(el)) continue;
    const label = clip(clean(el.textContent) || clean(el.getAttribute('aria-label')) || clean((el as HTMLInputElement).value));
    if (!label || seenAction.has(label)) continue;
    seenAction.add(label);
    const risk: Risk = HIGH_RISK.test(label) ? 'high' : 'low';
    const ref = minter.mint('action', label);
    actions.push({ ref, name: label, label, risk, provenance: 'inferred' });
    elements.set(ref.id, el);
  }

  // 控件：表单输入（input/select/textarea；排除按钮型与 hidden——csrf token 不是给人也不是给 agent 填的）
  for (const el of queryAllDeep(
    root,
    'input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea',
    scopes,
  )) {
    if (isHidden(el)) continue;
    const name = clip(
      clean(el.getAttribute('aria-label')) ||
        labelFor(root, el) ||
        clean(el.getAttribute('name')) ||
        clean(el.getAttribute('placeholder')) ||
        'field',
    );
    const value = 'value' in el ? String((el as HTMLInputElement).value) : null;
    const ref = minter.mint('control', name);
    controls.push({ ref, name, label: name, value, provenance: 'inferred' });
    elements.set(ref.id, el);
  }

  // surface：语义区域 / 状态 / 输出
  for (const el of queryAllDeep(root, '[role="region"], [role="status"], [role="alert"], output, section[aria-label]', scopes)) {
    if (isHidden(el)) continue;
    const name = clip(clean(el.getAttribute('aria-label')) || clean(el.getAttribute('role')) || 'region');
    const ref = minter.mint('surface', name);
    surfaces.push({ ref, name, text: clean(el.textContent), provenance: 'inferred' });
    elements.set(ref.id, el);
  }

  return { snapshot: { url, objects, actions, controls, surfaces }, elements };
}
