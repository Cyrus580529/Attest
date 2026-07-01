import type { Program } from '../core/program/types';

/** 一段被验证成功过的程序，连同它当初达成的目标（作为给模型看的说明标签）。 */
export interface Recipe {
  program: Program;
  goal: string;
  recordedAt: number;
}

/**
 * 配方库：按页面签名累积「成功过的程序」，召回时作为先验注入上下文。
 * 不做 verbatim 重放——只给模型参考，吻合与否由模型判断（躲开关键字圈套）。
 * key 由调用方传入（页面签名），本类不计算签名、不碰 outcome。
 */
export class RecipeBook {
  private readonly store = new Map<string, Recipe[]>();

  /** 录制一条配方；AST 相同的视为同一条，重录刷新为最近（不重复堆叠）。 */
  record(signature: string, recipe: Recipe): void {
    const list = this.store.get(signature) ?? [];
    const ast = JSON.stringify(recipe.program);
    const deduped = list.filter((r) => JSON.stringify(r.program) !== ast);
    deduped.push(recipe);
    this.store.set(signature, deduped);
  }

  /** 召回该签名下最近 limit 条去重配方，最近优先。 */
  recall(signature: string, limit: number): Recipe[] {
    const list = this.store.get(signature) ?? [];
    return [...list].reverse().slice(0, limit);
  }

  /** 序列化为可存盘的普通对象（宿主决定存哪）。内核不做 I/O。 */
  toJSON(): Record<string, Recipe[]> {
    return Object.fromEntries(this.store);
  }

  /** 从存盘数据重建——跨会话延续配方先验。 */
  static fromJSON(data: Record<string, Recipe[]>): RecipeBook {
    const rb = new RecipeBook();
    for (const [k, v] of Object.entries(data ?? {})) rb.store.set(k, v);
    return rb;
  }
}
