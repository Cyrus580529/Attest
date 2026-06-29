import type { PageSnapshot, Ref } from '../types';
import type { HostAdapter, HostResult } from '../host/types';
import { parseContractWithElements } from '../contract/parseContract';

export interface DomHostAdapterOptions {
  root?: ParentNode;
  getUrl?: () => string;
}

const EMPTY: PageSnapshot = { url: '', objects: [], actions: [], controls: [], surfaces: [] };

export function createDomHostAdapter(options: DomHostAdapterOptions = {}): HostAdapter {
  const getUrl = options.getUrl ?? (() => location.href);
  let elements = new Map<string, Element>();
  let current: PageSnapshot = EMPTY;

  function refresh(): PageSnapshot {
    const root = options.root ?? document.body;
    const parsed = parseContractWithElements(root, getUrl());
    current = parsed.snapshot;
    elements = parsed.elements;
    return current;
  }

  function clickRef(ref: Ref): HostResult {
    const el = elements.get(ref.id);
    if (!el) return { ok: false, snapshot: current, note: `element for ${ref.id} not found` };
    (el as HTMLElement).click();
    return { ok: true, snapshot: refresh() };
  }

  return {
    snapshot(): PageSnapshot {
      return refresh();
    },
    readSurface(ref: Ref): string {
      return current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '';
    },
    openObject(ref: Ref): Promise<HostResult> {
      return Promise.resolve(clickRef(ref));
    },
    navigate(ref: Ref): Promise<HostResult> {
      return Promise.resolve(clickRef(ref));
    },
    setControl(ref: Ref, value: string): Promise<HostResult> {
      const el = elements.get(ref.id);
      if (!el) return Promise.resolve({ ok: false, snapshot: current, note: `element for ${ref.id} not found` });
      if ('value' in el) {
        (el as HTMLInputElement).value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return Promise.resolve({ ok: true, snapshot: refresh() });
    },
    invokeAction(ref: Ref): Promise<HostResult> {
      return Promise.resolve(clickRef(ref));
    },
  };
}
