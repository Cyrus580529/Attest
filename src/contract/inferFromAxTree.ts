// Route B：从 BrowserGym 的 axtree_object（CDP 风格可访问性树）推断契约。
// ContractSource 家族的 ARIA-inferred 成员——同一信任内核驱动 bench 的未标注页面。
// 一切 handle 皆 inferred：写路径全 held（bench 模式下 held 映射为 send_msg_to_user）。
// 复用 inferContract 真实页面硬化的教训：hidden 剪枝、同标签去重、label 截断。
import type { ActionNode, ControlNode, ObjectNode, PageSnapshot, Risk, SurfaceNode } from '../types';
import { RefMinter } from './refs';

export interface AxNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  childIds?: string[];
  browsergym_id?: string;
  ignored?: boolean;
}

export interface AxTreeInferResult {
  snapshot: PageSnapshot;
  /** ref id → BrowserGym bid（bench 动作句柄：click(bid)/fill(bid, v)）。 */
  bids: Map<string, string>;
}

const ACTION_ROLES = new Set(['button', 'link', 'menuitem', 'tab']);
const CONTROL_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'slider']);
const OBJECT_ROLES = new Set(['listitem', 'row', 'article']);
const SURFACE_ROLES = new Set(['status', 'alert', 'region']);
const HIGH_RISK = /delete|remove|destroy|删除|删|清空|移除|pay|支付|purchase|checkout|confirm|确认|submit|提交|发送|send/i;
const MAX_LABEL = 80;

const clip = (s: string): string => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);
const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

function isHidden(n: AxNode): boolean {
  if (n.ignored) return true;
  return (n.properties ?? []).some((p) => p.name === 'hidden' && p.value?.value === true);
}

/** 自身 name + 后代文本拼接（有界深度，防环）。 */
function textOf(n: AxNode, byId: Map<string, AxNode>, depth = 6): string {
  if (depth <= 0 || isHidden(n)) return '';
  const parts = [clean(n.name?.value)];
  for (const cid of n.childIds ?? []) {
    const child = byId.get(cid);
    if (child) parts.push(textOf(child, byId, depth - 1));
  }
  return parts.filter(Boolean).join(' ').trim();
}

export function inferFromAxTree(nodes: AxNode[], url: string): AxTreeInferResult {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const referenced = new Set(nodes.flatMap((n) => n.childIds ?? []));
  const roots = nodes.filter((n) => !referenced.has(n.nodeId));

  const minter = new RefMinter();
  const bids = new Map<string, string>();
  const objects: ObjectNode[] = [];
  const actions: ActionNode[] = [];
  const controls: ControlNode[] = [];
  const surfaces: SurfaceNode[] = [];
  const seenAction = new Set<string>();
  let oi = 0;

  const visit = (n: AxNode | undefined): void => {
    if (!n || isHidden(n)) return; // hidden/ignored 整棵剪掉
    const role = clean(n.role?.value);
    const name = clean(n.name?.value);

    if (ACTION_ROLES.has(role) && n.browsergym_id) {
      const label = clip(name || textOf(n, byId));
      if (label && !seenAction.has(label)) {
        seenAction.add(label);
        const risk: Risk = HIGH_RISK.test(label) ? 'high' : 'low';
        const ref = minter.mint('action', label);
        actions.push({ ref, name: label, label, risk, provenance: 'inferred' });
        bids.set(ref.id, n.browsergym_id);
      }
    } else if (CONTROL_ROLES.has(role) && n.browsergym_id) {
      const label = clip(name || role);
      const ref = minter.mint('control', label);
      controls.push({
        ref,
        name: label,
        label,
        value: n.value?.value === undefined ? null : clean(n.value.value),
        provenance: 'inferred',
      });
      bids.set(ref.id, n.browsergym_id);
    } else if (OBJECT_ROLES.has(role)) {
      const label = clip(textOf(n, byId));
      if (label) {
        oi += 1;
        const ref = minter.mint('object', `item:${oi}`);
        objects.push({ ref, type: 'item', objectId: String(oi), label, provenance: 'inferred' });
        if (n.browsergym_id) bids.set(ref.id, n.browsergym_id);
        return; // 对象吞掉后代（行内文本已并入 label；行内按钮通常也有独立 bid，需要时再放开）
      }
    } else if (SURFACE_ROLES.has(role)) {
      const label = clip(name || role);
      const ref = minter.mint('surface', label);
      surfaces.push({ ref, name: label, text: textOf(n, byId), provenance: 'inferred' });
      if (n.browsergym_id) bids.set(ref.id, n.browsergym_id);
      return;
    }

    for (const cid of n.childIds ?? []) visit(byId.get(cid));
  };

  for (const r of roots) visit(r);
  return { snapshot: { url, objects, actions, controls, surfaces }, bids };
}
