// 【实验/可行性探针】从语义化 HTML + ARIA 推断契约（无 data-agent-*）。
// 目标：验证"让契约自动长出来"是否可行——同样的信任内核驱动未标注页面。
// 推断的 handle 来源 = inferred（与 parseContract 的 authored 区分）；这里先用文本启发式给动作定风险（保守：危险动词→high）。
import type { ActionNode, ControlNode, ObjectNode, PageSnapshot, Risk, SurfaceNode } from '../types';
import { RefMinter } from './refs';

const HIGH_RISK = /delete|remove|destroy|删除|删|清空|移除|pay|支付|purchase|checkout|confirm|确认|submit|提交|发送|send/i;

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function labelFor(root: ParentNode, el: Element): string {
  const id = el.getAttribute('id');
  if (!id) return '';
  const lbl = root.querySelector(`label[for="${CSS.escape(id)}"]`);
  return lbl ? clean(lbl.textContent) : '';
}

export interface InferResult {
  snapshot: PageSnapshot;
  elements: Map<string, Element>;
}

export function inferContract(root: ParentNode, url: string): InferResult {
  const minter = new RefMinter();
  const elements = new Map<string, Element>();
  const objects: ObjectNode[] = [];
  const actions: ActionNode[] = [];
  const controls: ControlNode[] = [];
  const surfaces: SurfaceNode[] = [];

  // 对象：列表项 / 文章 / 卡片 / 行
  let oi = 0;
  for (const el of root.querySelectorAll('li, [role="listitem"], article, [role="article"], [role="row"]')) {
    const label = clean(el.textContent);
    if (!label) continue;
    oi += 1;
    const ref = minter.mint('object', `item:${oi}`);
    objects.push({ ref, type: 'item', objectId: String(oi), label });
    elements.set(ref.id, el);
  }

  // 动作：按钮 / role=button / submit / 链接
  for (const el of root.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[href]')) {
    const label = clean(el.textContent) || clean(el.getAttribute('aria-label')) || clean((el as HTMLInputElement).value);
    if (!label) continue;
    const risk: Risk = HIGH_RISK.test(label) ? 'high' : 'low';
    const ref = minter.mint('action', label);
    actions.push({ ref, name: label, label, risk });
    elements.set(ref.id, el);
  }

  // 控件：表单输入（input/select/textarea，排除按钮型 input）
  for (const el of root.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), select, textarea')) {
    const name =
      clean(el.getAttribute('aria-label')) ||
      labelFor(root, el) ||
      clean(el.getAttribute('name')) ||
      clean(el.getAttribute('placeholder')) ||
      'field';
    const value = 'value' in el ? String((el as HTMLInputElement).value) : null;
    const ref = minter.mint('control', name);
    controls.push({ ref, name, label: name, value });
    elements.set(ref.id, el);
  }

  // surface：语义区域 / 状态 / 输出
  for (const el of root.querySelectorAll('[role="region"], [role="status"], [role="alert"], output, section[aria-label]')) {
    const name = clean(el.getAttribute('aria-label')) || clean(el.getAttribute('role')) || 'region';
    const ref = minter.mint('surface', name);
    surfaces.push({ ref, name, text: clean(el.textContent) });
    elements.set(ref.id, el);
  }

  return { snapshot: { url, objects, actions, controls, surfaces }, elements };
}
