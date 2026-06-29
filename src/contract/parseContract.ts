import type { ActionNode, ObjectNode, PageSnapshot, Risk } from '../types';
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

  return { url, objects, actions, controls: [], surfaces: [] };
}
