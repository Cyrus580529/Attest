import type {
  ActionNode,
  ControlNode,
  ObjectNode,
  PageSnapshot,
  Risk,
  SurfaceNode,
} from '../types';
import { RefMinter } from './refs';

function cleanText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

export function parseContract(root: ParentNode, url: string): PageSnapshot {
  const minter = new RefMinter();

  const objects: ObjectNode[] = [];
  for (const el of root.querySelectorAll('[data-agent-object]')) {
    const decl = el.getAttribute('data-agent-object') ?? '';
    const sep = decl.indexOf(':');
    if (sep <= 0 || sep === decl.length - 1) continue; // 需要 "type:id"
    const type = decl.slice(0, sep);
    const objectId = decl.slice(sep + 1);
    objects.push({
      ref: minter.mint('object', `${type}:${objectId}`),
      type,
      objectId,
      label: cleanText(el.textContent),
    });
  }

  const actions: ActionNode[] = [];
  for (const el of root.querySelectorAll('[data-agent-action]')) {
    const name = el.getAttribute('data-agent-action') ?? '';
    if (!name) continue;
    const risk: Risk = el.getAttribute('data-agent-risk') === 'high' ? 'high' : 'low';
    actions.push({
      ref: minter.mint('action', name),
      name,
      label: cleanText(el.textContent),
      risk,
    });
  }

  const controls: ControlNode[] = [];
  for (const el of root.querySelectorAll('[data-agent-control]')) {
    const name = el.getAttribute('data-agent-control') ?? '';
    if (!name) continue;
    const hasValue = 'value' in el;
    const value = hasValue ? String((el as { value: unknown }).value) : null;
    controls.push({
      ref: minter.mint('control', name),
      name,
      label: hasValue ? cleanText(el.getAttribute('aria-label')) : cleanText(el.textContent),
      value,
    });
  }

  const surfaces: SurfaceNode[] = [];
  for (const el of root.querySelectorAll('[data-agent-surface]')) {
    const name = el.getAttribute('data-agent-surface') ?? '';
    if (!name) continue;
    surfaces.push({
      ref: minter.mint('surface', name),
      name,
      text: cleanText(el.textContent),
    });
  }

  return { url, objects, actions, controls, surfaces };
}

export interface ContractParseResult {
  snapshot: PageSnapshot;
  elements: Map<string, Element>;
}

export function parseContractWithElements(root: ParentNode, url: string): ContractParseResult {
  const snapshot = parseContract(root, url);
  const elements = new Map<string, Element>();

  const bind = (selector: string, nodes: readonly { ref: { id: string } }[]) => {
    const els = Array.from(root.querySelectorAll(selector));
    nodes.forEach((node, i) => {
      const el = els[i];
      if (el && !elements.has(node.ref.id)) elements.set(node.ref.id, el);
    });
  };
  bind('[data-agent-object]', snapshot.objects);
  bind('[data-agent-action]', snapshot.actions);
  bind('[data-agent-control]', snapshot.controls);
  bind('[data-agent-surface]', snapshot.surfaces);

  return { snapshot, elements };
}
