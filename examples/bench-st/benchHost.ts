// Route B 桥的 Node 侧宿主：把 BrowserGym obs 变成 PageSnapshot，把 Attest 写原语
// 变成 BrowserGym 动作字符串（click/fill）。传输层注入（stdio 由 bridge.ts 提供），
// 逻辑本身可用假 execute 确定性测试。
import type { HostAdapter, HostResult } from '../../src/host/types';
import type { PageSnapshot, Ref } from '../../src/types';
import { inferFromAxTree, type AxNode } from '../../src/contract/inferFromAxTree';
import { diffSnapshots } from '../../src/honesty/verifier';

/** BrowserGym obs 里桥需要的最小面。axtree_object 兼容 {nodes:[...]} 或裸数组。 */
export interface BenchObs {
  url?: string;
  axtree_object?: { nodes?: AxNode[] } | AxNode[];
  /** BrowserGym：上一动作的执行错误（点击超时/元素过期等）——不读它就会把"没执行成"当"无变化"。 */
  last_action_error?: string;
}

export interface BenchHostDeps {
  /** 把 BrowserGym 动作字符串交给 Python 侧 env.step，回传新 obs。 */
  execute: (action: string) => Promise<BenchObs>;
  initialObs: BenchObs;
  /**
   * 写后 settle：SuiteCRM 等 Angular 页的效果在 env.step 返回的 obs 里常常还没渲染出来，
   * 补一发 noop(ms) 重取 obs（integrating.md 的不变量："效果落地后才 resolve"）。
   * 默认 'noop(700)'；传 null 关闭。
   */
  settleAction?: string | null;
}

const axNodes = (obs: BenchObs): AxNode[] => {
  const t = obs.axtree_object;
  return Array.isArray(t) ? t : (t?.nodes ?? []);
};

/** BrowserGym 动作参数是 Python 字符串字面量。JSON 双引号编码对其 pyparsing 解析器最稳
 *（\' 转义实测会让它在 answer(...) 上崩），换行压平进转义。 */
export const pyStr = (s: string): string => JSON.stringify(s.replace(/\r?\n/g, ' '));

export function createBenchHostAdapter(deps: BenchHostDeps): HostAdapter {
  let obs = deps.initialObs;
  let current!: PageSnapshot;
  let bids = new Map<string, string>();

  const refresh = (): PageSnapshot => {
    const r = inferFromAxTree(axNodes(obs), obs.url ?? '');
    current = r.snapshot;
    bids = r.bids;
    return current;
  };
  refresh();

  const settle = deps.settleAction === undefined ? 'noop(700)' : deps.settleAction;
  const act = async (action: string): Promise<HostResult> => {
    const prev = current;
    obs = await deps.execute(action);
    const err = obs.last_action_error?.trim(); // settle 前捕获——noop 会覆盖字段
    let snapshot = refresh();
    // 自适应 settle：动作成功但 obs 还没见到变化时才补 noop 等渲染——bench 的任务
    // 步数预算硬（trajectory≥20 即终局），效果已可见就别再烧一步。
    if (settle && !err && !diffSnapshots(prev, snapshot).changed) {
      obs = await deps.execute(settle);
      snapshot = refresh();
    }
    return err ? { ok: false, snapshot, note: err.slice(0, 200) } : { ok: true, snapshot };
  };

  const clickRef = async (ref: Ref): Promise<HostResult> => {
    const bid = bids.get(ref.id);
    if (!bid) return { ok: false, snapshot: current, note: `no bid for ${ref.id}` };
    let r = await act(`click(${pyStr(bid)})`);
    // bid 过期自愈：Angular 重渲染换元素——settle 后的新快照按同名 ref 重解析新 bid，重试一次
    if (!r.ok && /timeout|resolve|detach|not.*found/i.test(r.note ?? '')) {
      const again = bids.get(ref.id);
      if (again && again !== bid) r = await act(`click(${pyStr(again)})`);
    }
    return r;
  };

  return {
    snapshot: () => refresh(),
    readSurface: (ref) => current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '',
    openObject: clickRef,
    navigate: clickRef,
    async setControl(ref, value) {
      const bid = bids.get(ref.id);
      if (!bid) return { ok: false, snapshot: current, note: `no bid for ${ref.id}` };
      const r = await act(`fill(${pyStr(bid)}, ${pyStr(value)})`);
      if (r.ok || !/not an? <?input/i.test(r.note ?? '')) return r;
      // 非输入控件（下拉/自定义组件）。先试原生 select_option（真 <select> 一步到位）……
      const r2 = await act(`select_option(${pyStr(bid)}, ${pyStr(value)})`);
      if (r2.ok) return r2;
      // ……再退到通用形：点开控件，在展开后的树里按文本找选项点击。
      await act(`click(${pyStr(bid)})`);
      const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
      const isOption = (n: AxNode): boolean =>
        ['option', 'menuitem', 'listitem'].includes(clean(n.role?.value)) && Boolean(n.browsergym_id);
      const want = clean(value).toLowerCase();
      const opts = axNodes(obs).filter(isOption);
      const hit = opts.find((n) => clean(n.name?.value).toLowerCase() === want);
      if (!hit) {
        const available = opts.map((n) => clean(n.name?.value)).filter(Boolean).slice(0, 20);
        return {
          ok: false,
          snapshot: current,
          note: `控件不是文本输入且找不到选项 "${value}"。当前可选项: ${available.join(', ') || '（未见选项）'}`,
        };
      }
      return act(`click(${pyStr(hit.browsergym_id!)})`);
    },
    invokeAction: clickRef,
  };
}
