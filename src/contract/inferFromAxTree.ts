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
const HIGH_RISK = /delete|remove|destroy|删除|删|清空|移除|pay|支付|purchase|checkout|confirm|确认|submit|提交|发送|send|save|保存/i;
const MAX_LABEL = 80;

const clip = (s: string): string => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);
const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

/** hidden 属性 = 真不可见，整棵剪。ignored 是 CDP 的"本节点不入树"——跳过自己、必须继续下钻
 *（SuiteCRM 主帧的树顶就是个 ignored 'none' 包装，按 hidden 剪会剪掉整页——真实 bench 夹具抓到的）。 */
function isPruned(n: AxNode): boolean {
  return (n.properties ?? []).some((p) => p.name === 'hidden' && p.value?.value === true);
}

/** 节点文本：CDP 的 computed name 已聚合内容——有 name 用 name（再拼后代会出"Accounts Accounts"
 * 式重复），无 name 才聚合后代（有界深度，防环）。 */
function textOf(n: AxNode, byId: Map<string, AxNode>, depth = 6): string {
  if (depth <= 0 || isPruned(n)) return '';
  const own = clean(n.name?.value);
  if (own) return own;
  const parts: string[] = [];
  for (const cid of n.childIds ?? []) {
    const child = byId.get(cid);
    if (child) parts.push(textOf(child, byId, depth - 1));
  }
  return parts.filter(Boolean).join(' ').trim();
}

/** 收集带 bid 的可交互后代（link/button 等），供"导航 li"判定。 */
function interactiveDescendants(n: AxNode, byId: Map<string, AxNode>, depth = 6): AxNode[] {
  if (depth <= 0 || isPruned(n)) return [];
  const out: AxNode[] = [];
  for (const cid of n.childIds ?? []) {
    const child = byId.get(cid);
    if (!child) continue;
    if (!child.ignored && ACTION_ROLES.has(clean(child.role?.value)) && child.browsergym_id) out.push(child);
    out.push(...interactiveDescendants(child, byId, depth - 1));
  }
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

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

  // 无名控件的标签认领：SuiteCRM 等表单不做 label 关联，字段标题是 DFS 序上紧邻的
  // 前置 StaticText——途中记住最近短文本，控件缺名时在近距离内认领（实测 15/15 命中）。
  // 只记「像标签」的文本（含字母）：必填星号 "*"、字段值（日期 07/03/2026）、时间分隔符
  // " : " 都紧邻控件却不是标签，会冒充字段名——按「无字母即噪音」跳过（legacy 会议表单实证）。
  let visitIdx = 0;
  let lastText: { text: string; at: number } | null = null;
  const NEARBY = 10;
  const looksLikeLabel = (s: string): boolean => /[a-zA-Z一-鿿]/.test(s);

  const visit = (n: AxNode | undefined): void => {
    if (!n || isPruned(n)) return; // hidden 整棵剪掉
    visitIdx += 1;
    if (n.ignored) {
      // CDP ignored：本节点不入树但子树照常——只下钻，不参与分类
      for (const cid of n.childIds ?? []) visit(byId.get(cid));
      return;
    }
    const role = clean(n.role?.value);
    const name = clean(n.name?.value);
    if (role === 'StaticText' && name && name.length <= 40 && looksLikeLabel(name)) lastText = { text: name, at: visitIdx };

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
      const nearby = lastText !== null && visitIdx - (lastText as { at: number }).at <= NEARBY ? (lastText as { text: string }).text : '';
      const label = clip(name || nearby || role);
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
      const raw = textOf(n, byId);
      const label = clip(raw);
      if (label) {
        // 导航 li：内容恰为单个链接（文本一致）——是"可去的地方"不是"数据行"，
        // 推断为 action 才能让模型导航（SuiteCRM 模块菜单实测就是这个形状）。
        const links = interactiveDescendants(n, byId);
        const first = links[0];
        if (links.length === 1 && first && norm(textOf(first, byId)) === norm(label)) {
          if (!seenAction.has(label)) {
            seenAction.add(label);
            const ref = minter.mint('action', label);
            actions.push({ ref, name: label, label, risk: HIGH_RISK.test(label) ? 'high' : 'low', provenance: 'inferred' });
            bids.set(ref.id, first.browsergym_id!);
          }
          return;
        }
        // 链接组 li：内容全为可交互项（多个链接拼起来=全部文本，无数据性文字）——
        // 是展开的菜单/导航组不是数据行。吞成对象会藏掉全部菜单项，且对象主链接=组名
        // （如 More），点了反把菜单关上（真实 More 菜单实测）。下钻让每项自成 action。
        if (links.length >= 2 && norm(links.map((l) => textOf(l, byId)).join(' ')) === norm(raw)) {
          for (const cid of n.childIds ?? []) visit(byId.get(cid));
          return;
        }
        oi += 1;
        const ref = minter.mint('object', `item:${oi}`);
        objects.push({ ref, type: 'item', objectId: String(oi), label, provenance: 'inferred' });
        // 点击句柄优先绑"主链接"（文本为行 label 前缀的第一个链接=名字链接）：
        // 列表行中央布满内联动作（Log Call…），点行本身等于乱点；点名字链接才进详情。
        const primary = links.find((l) => norm(label).startsWith(norm(textOf(l, byId))) && textOf(l, byId));
        const handle = primary?.browsergym_id ?? n.browsergym_id;
        if (handle) bids.set(ref.id, handle);
        return; // 对象吞掉后代（行内文本已并入 label；行内按钮通常也有独立 bid，需要时再放开）
      }
    } else if (SURFACE_ROLES.has(role) || role === 'tabpanel') {
      const label = clip(name || role);
      const ref = minter.mint('surface', label);
      // tabpanel 的 name 是页签标题，内容在后代——聚合后代文本（真实面板嵌套深，
      // 深度放宽到 14）；status/alert 的 name 即内容。
      const text =
        role === 'tabpanel'
          ? (n.childIds ?? [])
              .map((cid) => {
                const child = byId.get(cid);
                return child ? textOf(child, byId, 14) : '';
              })
              .filter(Boolean)
              .join(' ')
          : textOf(n, byId);
      surfaces.push({ ref, name: label, text, provenance: 'inferred' });
      if (n.browsergym_id) bids.set(ref.id, n.browsergym_id);
      // tabpanel 是"内容区域"不是叶子告示：面板里还有控件/动作（编辑态表单就在里面），
      // 吞掉后代会让整个面板不可操作——surface 供读取，后代照常分类。
      if (role !== 'tabpanel') return;
    }

    for (const cid of n.childIds ?? []) visit(byId.get(cid));
  };

  for (const r of roots) visit(r);
  return { snapshot: { url, objects, actions, controls, surfaces }, bids };
}
