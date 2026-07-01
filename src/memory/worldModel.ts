import type { PageSnapshot } from '../types';
import type { Evidence } from '../honesty/types';
import type { Prediction } from '../core/speculation/prediction';
import { pageSignature } from './pageSignature';

/**
 * 世界模型：纯从「验证过的证据」学 (页面签名, 动作名) → 最近一次可观察 diff。
 * 检索式（R-WoM 风格），数据来自 Ledger 的 write 条目——绝不碰模型自述，天然诚实。
 * 签名是陈旧性闸门：签名变即查不到，错也只浪费一点上下文、绝不误动。
 */
export class WorldModel {
  private readonly store = new Map<string, string[]>();

  private key(sig: string, action: string): string {
    return `${sig}|>${action}`;
  }

  learn(snapshot: PageSnapshot, actionName: string, evidence: Evidence): void {
    if (!evidence.changed || evidence.details.length === 0) return; // 无变化不构成因果
    this.store.set(this.key(pageSignature(snapshot), actionName), evidence.details);
  }

  predict(snapshot: PageSnapshot, actionName: string): Prediction | null {
    const details = this.store.get(this.key(pageSignature(snapshot), actionName));
    return details ? { expectDetails: details } : null;
  }

  /** 序列化为可存盘的普通对象（宿主决定存哪：文件/localStorage/DB）。内核不做 I/O。 */
  toJSON(): Record<string, string[]> {
    return Object.fromEntries(this.store);
  }

  /** 从存盘数据重建——跨会话延续先验（"越用越聪明"落地）。 */
  static fromJSON(data: Record<string, string[]>): WorldModel {
    const wm = new WorldModel();
    for (const [k, v] of Object.entries(data ?? {})) wm.store.set(k, v);
    return wm;
  }
}
