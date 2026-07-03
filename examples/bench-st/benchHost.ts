// Route B 桥的 Node 侧宿主：把 BrowserGym obs 变成 PageSnapshot，把 Attest 写原语
// 变成 BrowserGym 动作字符串（click/fill）。传输层注入（stdio 由 bridge.ts 提供），
// 逻辑本身可用假 execute 确定性测试。
import type { HostAdapter, HostResult } from '../../src/host/types';
import type { PageSnapshot, Ref } from '../../src/types';
import { inferFromAxTree, type AxNode } from '../../src/contract/inferFromAxTree';

/** BrowserGym obs 里桥需要的最小面。axtree_object 兼容 {nodes:[...]} 或裸数组。 */
export interface BenchObs {
  url?: string;
  axtree_object?: { nodes?: AxNode[] } | AxNode[];
}

export interface BenchHostDeps {
  /** 把 BrowserGym 动作字符串交给 Python 侧 env.step，回传新 obs。 */
  execute: (action: string) => Promise<BenchObs>;
  initialObs: BenchObs;
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

  const act = async (action: string): Promise<HostResult> => {
    obs = await deps.execute(action);
    return { ok: true, snapshot: refresh() };
  };

  const clickRef = async (ref: Ref): Promise<HostResult> => {
    const bid = bids.get(ref.id);
    if (!bid) return { ok: false, snapshot: current, note: `no bid for ${ref.id}` };
    return act(`click(${pyStr(bid)})`);
  };

  return {
    snapshot: () => refresh(),
    readSurface: (ref) => current.surfaces.find((s) => s.ref.id === ref.id)?.text ?? '',
    openObject: clickRef,
    navigate: clickRef,
    async setControl(ref, value) {
      const bid = bids.get(ref.id);
      if (!bid) return { ok: false, snapshot: current, note: `no bid for ${ref.id}` };
      return act(`fill(${pyStr(bid)}, ${pyStr(value)})`);
    },
    invokeAction: clickRef,
  };
}
