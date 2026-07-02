import type { PageSnapshot } from '../types';
import type { Evidence } from '../honesty/types';
import type { Prediction } from '../core/speculation/prediction';
import { pageSignature } from './pageSignature';

/**
 * 世界模型：纯从「验证过的证据」学 (页面签名, 动作名) → 最近一次可观察 diff。
 * 检索式（R-WoM 风格），数据来自 Ledger 的 write 条目——绝不碰模型自述，天然诚实。
 * 签名是陈旧性闸门：签名变即查不到，错也只浪费一点上下文、绝不误动。
 *
 * 漂移检测（切片15）：同一签名下已知动作不再产生已知效果 = 页面行为漂移的确定性证据。
 * - 写时裁定（STALE 谱系）：每次执行落账即裁定旧条目，绝不留给模型自己判断陈旧性；
 * - 两级阈值（DDM 谱系）：第 1 次落空降 suspect（注入带警示），连续第 2 次判漂移
 *   → 上报事件 + 自愈（有新行为就采纳、无行为就逐出）；命中即回 active 清零；
 * - 形状比较（精确优先，SkillGuard 谱系）：diff 按结构形状比对（object:task:9 与
 *   object:task:10 同构），实例差异绝不误报漂移。
 */

export interface PriorLookup {
  details: string[];
  /** active=可信先验；suspect=最近一次未按已知效果发生，注入时带警示。 */
  status: 'active' | 'suspect';
}

export interface DriftEvent {
  action: string;
  /** 漂移前的已知效果（先验原文）。 */
  expected: string[];
  /** 实际观察到的效果（空数组 = 已知有效的动作不再产生任何可观察变化）。 */
  observed: string[];
}

interface Entry {
  details: string[];
  misses: number;
}

/**
 * diff detail 的泛化形：剥掉实例 id / 具体值，只留「什么种类的东西发生了什么」。
 * 既是漂移裁定的比较单位，也是先验注入/predict 用的期望形——泛化后必然是
 * 同形实际 diff 的子串（前缀），predict 照抄即可跨实例命中（apply:1 学的，apply:2 也中）。
 */
export function genericExpectation(detail: string): string {
  const obj = /^(object (?:appeared|gone): object:[^:]+):/.exec(detail);
  if (obj) return obj[1]!;
  const ctrl = /^(control control:.+?): /.exec(detail);
  if (ctrl) return ctrl[1]!;
  if (detail.startsWith('url: ')) return 'url:';
  return detail; // surface … changed 已是形状级
}

/** 命中判定：已知效果的每个形状都出现在实际 diff 里（页面多做别的不算落空）。 */
function shapeHit(known: string[], actual: string[]): boolean {
  const got = new Set(actual.map(genericExpectation));
  return known.every((k) => got.has(genericExpectation(k)));
}

const DRIFT_THRESHOLD = 2; // 连续落空次数达此值 → 判漂移

export class WorldModel {
  private readonly store = new Map<string, Entry>();
  private readonly noEffect = new Map<string, number>();
  private drift: DriftEvent[] = [];

  private key(sig: string, action: string): string {
    return `${sig}|>${action}`;
  }

  /** 写时裁定：每次执行的证据（含"无变化"）都在此刻裁定先验 命中/落空/漂移。 */
  learn(snapshot: PageSnapshot, actionName: string, evidence: Evidence): void {
    const k = this.key(pageSignature(snapshot), actionName);
    const entry = this.store.get(k);

    if (evidence.changed && evidence.details.length > 0) {
      this.noEffect.delete(k); // 有效果 → 清负样本
      if (!entry) {
        this.store.set(k, { details: evidence.details, misses: 0 });
      } else if (shapeHit(entry.details, evidence.details)) {
        this.store.set(k, { details: evidence.details, misses: 0 }); // 命中：刷新为最新原文
      } else {
        entry.misses += 1;
        if (entry.misses >= DRIFT_THRESHOLD) {
          this.drift.push({ action: actionName, expected: entry.details, observed: evidence.details });
          this.store.set(k, { details: evidence.details, misses: 0 }); // 自愈：采纳新行为
        }
      }
      return;
    }

    // 无可观察变化
    if (entry) {
      entry.misses += 1;
      if (entry.misses >= DRIFT_THRESHOLD) {
        this.drift.push({ action: actionName, expected: entry.details, observed: [] });
        this.store.delete(k); // 无新行为可采纳 → 逐出
      }
    } else {
      this.noEffect.set(k, (this.noEffect.get(k) ?? 0) + 1);
    }
  }

  /** 带状态的先验查询（注入用）：只回 active/suspect——漂移在写时已解决，绝不外泄陈旧条目。 */
  lookup(snapshot: PageSnapshot, actionName: string): PriorLookup | null {
    const entry = this.store.get(this.key(pageSignature(snapshot), actionName));
    if (!entry) return null;
    return { details: entry.details, status: entry.misses > 0 ? 'suspect' : 'active' };
  }

  /** 负先验：该动作被确认「执行了但无可观察效果」的连续次数。 */
  noEffectCount(snapshot: PageSnapshot, actionName: string): number {
    return this.noEffect.get(this.key(pageSignature(snapshot), actionName)) ?? 0;
  }

  predict(snapshot: PageSnapshot, actionName: string): Prediction | null {
    const found = this.lookup(snapshot, actionName);
    return found ? { expectDetails: found.details } : null;
  }

  /** 取出并清空积累的漂移事件（宿主/循环上报用）。 */
  drainDrift(): DriftEvent[] {
    const out = this.drift;
    this.drift = [];
    return out;
  }

  /** 序列化为可存盘的普通对象（宿主决定存哪：文件/localStorage/DB）。内核不做 I/O。 */
  toJSON(): WorldModelJSON {
    return {
      version: 2,
      entries: Object.fromEntries(
        [...this.store].map(([k, e]) => [k, { details: e.details, misses: e.misses }]),
      ),
      noEffect: Object.fromEntries(this.noEffect),
    };
  }

  /** 从存盘数据重建——兼容 v1 旧格式（Record<key, details[]>），跨会话延续先验。 */
  static fromJSON(data: WorldModelJSON | Record<string, string[]> | null | undefined): WorldModel {
    const wm = new WorldModel();
    if (!data) return wm;
    if ('version' in data && data.version === 2) {
      const v2 = data as WorldModelJSON;
      for (const [k, e] of Object.entries(v2.entries ?? {})) wm.store.set(k, { details: e.details, misses: e.misses });
      for (const [k, n] of Object.entries(v2.noEffect ?? {})) wm.noEffect.set(k, n);
      return wm;
    }
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) wm.store.set(k, { details: v, misses: 0 });
    }
    return wm;
  }
}

export interface WorldModelJSON {
  version: 2;
  entries: Record<string, { details: string[]; misses: number }>;
  noEffect: Record<string, number>;
}
