import type { ObjectNode, PageSnapshot } from '../types';
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

  return { url, objects, actions: [], controls: [], surfaces: [] };
}
