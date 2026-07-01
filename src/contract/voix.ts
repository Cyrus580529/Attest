// 骑 VOIX 契约（arXiv 2511.11287 / github.com/svenschultze/VOIX）：页面用 <tool>/<context> 声明能力，
// Attest 补它明确不做的三样——outcome 验证、信任、契约漂移。
// VOIX 运行时：调用 = 在 tool 元素上派发 `call` 事件（参数在 e.detail）；带 `return` 的 tool 由 handler
// 派发 `return` 事件回传结果。<prop> 声明参数（本刀先不接参数，留待下一刀动 invokeAction 签名）。
import type { ActionNode, PageSnapshot, Risk, SurfaceNode } from '../types';
import { RefMinter } from './refs';

// 保守风险启发式：VOIX 不定义 risk，危险动词→high（Attest 据此 held）。可被显式 risk="high" 覆盖。
const HIGH_RISK = /delete|remove|destroy|删除|删|清空|移除|pay|支付|purchase|checkout|confirm|确认|submit|提交|发送|send|ship|发布|deploy/i;

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export interface VoixParseResult {
  snapshot: PageSnapshot;
  /** ref.id → 声明元素（<tool>/<context>），供 host 适配器派发 call 事件 / 读 context。 */
  elements: Map<string, Element>;
}

function parse(root: ParentNode, url: string): VoixParseResult {
  const minter = new RefMinter();
  const elements = new Map<string, Element>();

  const actions: ActionNode[] = [];
  for (const el of root.querySelectorAll('tool')) {
    const name = clean(el.getAttribute('name'));
    if (!name) continue; // 无 name 无从引用，跳过
    const description = clean(el.getAttribute('description')) || name;
    const risk: Risk =
      el.getAttribute('risk') === 'high' || HIGH_RISK.test(`${name} ${description}`) ? 'high' : 'low';
    const ref = minter.mint('action', name);
    actions.push({ ref, name, label: description, risk, provenance: 'authored' });
    elements.set(ref.id, el);
  }

  const surfaces: SurfaceNode[] = [];
  for (const el of root.querySelectorAll('context')) {
    const name = clean(el.getAttribute('name')) || 'context';
    const ref = minter.mint('surface', name);
    surfaces.push({ ref, name, text: clean(el.textContent), provenance: 'authored' });
    elements.set(ref.id, el);
  }

  // VOIX 无「对象列表」「表单控件」概念，故 objects/controls 为空——内核照常工作。
  return { snapshot: { url, objects: [], actions, controls: [], surfaces }, elements };
}

/** VOIX 页面 → PageSnapshot（ContractSource 实现）。 */
export function parseVoix(root: ParentNode, url: string): PageSnapshot {
  return parse(root, url).snapshot;
}

/** 同 parseVoix，另附 ref→元素绑定，供 host 适配器驱动。 */
export function parseVoixWithElements(root: ParentNode, url: string): VoixParseResult {
  return parse(root, url);
}
