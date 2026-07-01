import type { PageSnapshot, Ref } from '../types';
import type { HostAdapter, HostResult } from '../host/types';
import { inferContract } from '../contract/inferContract';
import { cssPath } from './cssPath';
import type { BrowserPage } from './browserPage';

/** 从实时 HTML 解析出 snapshot + ref→元素绑定（inferContract 默认；契约页可换 parseContractWithElements）。 */
export type ParseWithElements = (root: ParentNode, url: string) => {
  snapshot: PageSnapshot;
  elements: Map<string, Element>;
};

export interface BrowserHostAdapterOptions {
  /** 把 HTML 字符串解析成可 querySelector 的 DOM（Node 里传 happy-dom 的 DOMParser 封装；浏览器可用原生）。 */
  parseHtml: (html: string) => ParentNode;
  /** 契约来源（带元素绑定）。默认 inferContract（驱动无标注页，如 benchmark 真实站）。 */
  parseWithElements?: ParseWithElements;
}

const EMPTY: PageSnapshot = { url: '', objects: [], actions: [], controls: [], surfaces: [] };

/**
 * 真实浏览器后端的 HostAdapter：把 Attest 信任核心接到 Playwright 之类的实时页面上（Route B 的桥）。
 * 关键点：真浏览器读 DOM 是异步的，而 HostAdapter.snapshot() 同步——故内部**缓存快照**，
 * 每个异步操作后刷新；调用方 run 前先 await refresh() 初始化。信任核心（verify/held/账本）原样不变。
 */
export function createBrowserHostAdapter(page: BrowserPage, opts: BrowserHostAdapterOptions) {
  const parse = opts.parseWithElements ?? inferContract;
  let current: PageSnapshot = EMPTY;
  let selectors = new Map<string, string>(); // ref.id → CSS 选择器（对实时页有效）

  /** 拉实时 HTML、重解析、重算选择器、更新缓存。异步操作后调用。 */
  async function refresh(): Promise<PageSnapshot> {
    const html = await page.content();
    const root = opts.parseHtml(html);
    const { snapshot, elements } = parse(root, page.url());
    current = snapshot;
    selectors = new Map();
    for (const [refId, el] of elements) selectors.set(refId, cssPath(el));
    return current;
  }

  function selectorFor(ref: Ref): string | undefined {
    return selectors.get(ref.id);
  }

  const adapter: HostAdapter & { refresh: () => Promise<PageSnapshot> } = {
    refresh,
    snapshot(): PageSnapshot {
      return current; // 返回缓存；调用方需先 await refresh() 初始化，动作方法内部会刷新
    },
    readSurface(ref: Ref): string {
      return current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '';
    },
    async openObject(ref: Ref): Promise<HostResult> {
      const sel = selectorFor(ref);
      if (!sel) return { ok: false, snapshot: current, note: `无 ${ref.id} 的选择器` };
      await page.click(sel);
      return { ok: true, snapshot: await refresh() };
    },
    async navigate(ref: Ref): Promise<HostResult> {
      const sel = selectorFor(ref);
      if (!sel) return { ok: false, snapshot: current, note: `无 ${ref.id} 的选择器` };
      await page.click(sel);
      return { ok: true, snapshot: await refresh() };
    },
    async setControl(ref: Ref, value: string): Promise<HostResult> {
      const sel = selectorFor(ref);
      if (!sel) return { ok: false, snapshot: current, note: `无 ${ref.id} 的选择器` };
      await page.fill(sel, value);
      return { ok: true, snapshot: await refresh() };
    },
    async invokeAction(ref: Ref): Promise<HostResult> {
      const sel = selectorFor(ref);
      if (!sel) return { ok: false, snapshot: current, note: `无 ${ref.id} 的选择器` };
      await page.click(sel); // 真实页面上「触发动作」= 点击其元素
      return { ok: true, snapshot: await refresh() };
    },
  };
  return adapter;
}
