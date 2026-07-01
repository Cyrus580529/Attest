import type { PageSnapshot, Ref } from '../types';
import type { HostAdapter, HostResult } from '../host/types';
import { parseVoixWithElements } from '../contract/voix';

export interface VoixHostAdapterOptions {
  root?: ParentNode;
  getUrl?: () => string;
  /** 带 return 的 tool 等 return 事件的超时（ms），防 handler 从不回传时挂死。默认 3000。 */
  returnTimeoutMs?: number;
}

const EMPTY: PageSnapshot = { url: '', objects: [], actions: [], controls: [], surfaces: [] };

/**
 * 骑 VOIX 契约的 host 适配器：调用 = 在 <tool> 元素上派发 `call` 事件；带 `return` 的 tool 等其
 * `return` 事件回传结果。信任核心不变——写后仍由 diffSnapshots 按可观察状态验证（VOIX 自己不做的那步）。
 */
export function createVoixHostAdapter(options: VoixHostAdapterOptions = {}): HostAdapter {
  const getUrl = options.getUrl ?? (() => location.href);
  const timeoutMs = options.returnTimeoutMs ?? 3000;
  let elements = new Map<string, Element>();
  let current: PageSnapshot = EMPTY;

  function refresh(): PageSnapshot {
    const root = options.root ?? document.body;
    const parsed = parseVoixWithElements(root, getUrl());
    current = parsed.snapshot;
    elements = parsed.elements;
    return current;
  }

  function notSupported(what: string): HostResult {
    return { ok: false, snapshot: current, note: `VOIX 契约无${what}` };
  }

  async function callTool(ref: Ref): Promise<HostResult> {
    const el = elements.get(ref.id) as HTMLElement | undefined;
    if (!el) return { ok: false, snapshot: current, note: `找不到 ${ref.id} 对应的 <tool>` };

    let returned: unknown;
    if (el.hasAttribute('return')) {
      // 先挂一次性 return 监听（sync handler 会在 dispatch 内同步回传，异步则稍后），带超时防挂死。
      const waitReturn = new Promise<unknown>((resolve) => {
        el.addEventListener('return', (e) => resolve((e as CustomEvent).detail), { once: true });
      });
      const timeout = new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), timeoutMs));
      el.dispatchEvent(new CustomEvent('call', { detail: {} }));
      returned = await Promise.race([waitReturn, timeout]);
    } else {
      el.dispatchEvent(new CustomEvent('call', { detail: {} }));
      await Promise.resolve(); // 让同步/微任务 handler 落地后再快照
    }

    const snapshot = refresh();
    return { ok: true, snapshot, note: returned !== undefined ? JSON.stringify(returned) : undefined };
  }

  return {
    snapshot(): PageSnapshot {
      return refresh();
    },
    readSurface(ref: Ref): string {
      return current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '';
    },
    openObject(): Promise<HostResult> {
      return Promise.resolve(notSupported('对象（object）'));
    },
    navigate(): Promise<HostResult> {
      return Promise.resolve(notSupported('导航目标'));
    },
    setControl(): Promise<HostResult> {
      return Promise.resolve(notSupported('控件（带参 tool 走 invokeAction+args，后续切片）'));
    },
    invokeAction(ref: Ref): Promise<HostResult> {
      return callTool(ref);
    },
  };
}
