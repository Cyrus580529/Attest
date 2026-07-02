import type {
  ActionNode,
  ControlNode,
  ObjectNode,
  PageSnapshot,
  Risk,
  SurfaceNode,
} from '../types';
import { RefMinter } from './refs';
import { collectScopes, queryAllDeep } from './queryAllDeep';

function cleanText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

export interface ContractParseResult {
  snapshot: PageSnapshot;
  elements: Map<string, Element>;
}

/**
 * 解析 data-agent-* 契约并绑定元素映射。单趟完成（解析即绑定，杜绝二次查询错位），
 * 深遍历穿透 open shadow root 与同源 iframe（closed shadow / 跨域 iframe 不可及，如实跳过）。
 */
export function parseContractWithElements(root: ParentNode, url: string): ContractParseResult {
  const minter = new RefMinter();
  const elements = new Map<string, Element>();
  const scopes = collectScopes(root);
  const bind = (id: string, el: Element) => {
    if (!elements.has(id)) elements.set(id, el);
  };

  const objects: ObjectNode[] = [];
  for (const el of queryAllDeep(root, '[data-agent-object]', scopes)) {
    const decl = el.getAttribute('data-agent-object') ?? '';
    const sep = decl.indexOf(':');
    if (sep <= 0 || sep === decl.length - 1) continue; // 需要 "type:id"
    const type = decl.slice(0, sep);
    const objectId = decl.slice(sep + 1);
    const ref = minter.mint('object', `${type}:${objectId}`);
    objects.push({ ref, type, objectId, label: cleanText(el.textContent) });
    bind(ref.id, el);
  }

  const actions: ActionNode[] = [];
  for (const el of queryAllDeep(root, '[data-agent-action]', scopes)) {
    const name = el.getAttribute('data-agent-action') ?? '';
    if (!name) continue;
    const risk: Risk = el.getAttribute('data-agent-risk') === 'high' ? 'high' : 'low';
    const ref = minter.mint('action', name);
    actions.push({ ref, name, label: cleanText(el.textContent), risk });
    bind(ref.id, el);
  }

  const controls: ControlNode[] = [];
  for (const el of queryAllDeep(root, '[data-agent-control]', scopes)) {
    const name = el.getAttribute('data-agent-control') ?? '';
    if (!name) continue;
    const hasValue = 'value' in el;
    const value = hasValue ? String((el as { value: unknown }).value) : null;
    const ref = minter.mint('control', name);
    controls.push({
      ref,
      name,
      label: hasValue ? cleanText(el.getAttribute('aria-label')) : cleanText(el.textContent),
      value,
    });
    bind(ref.id, el);
  }

  const surfaces: SurfaceNode[] = [];
  for (const el of queryAllDeep(root, '[data-agent-surface]', scopes)) {
    const name = el.getAttribute('data-agent-surface') ?? '';
    if (!name) continue;
    const ref = minter.mint('surface', name);
    surfaces.push({ ref, name, text: cleanText(el.textContent) });
    bind(ref.id, el);
  }

  return { snapshot: { url, objects, actions, controls, surfaces }, elements };
}

export function parseContract(root: ParentNode, url: string): PageSnapshot {
  return parseContractWithElements(root, url).snapshot;
}
