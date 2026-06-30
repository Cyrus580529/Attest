import type { PageSnapshot, Ref, RefKind } from '../types';

export type RefResolution = { ok: true; ref: Ref } | { ok: false; error: string };

/**
 * 按描述/标签把短语解析成对象 ref：精确 label 匹配优先，否则唯一子串匹配（双向：label 含短语 / 短语含 label）。
 * 多个命中或零命中 → 拒绝（不猜）——契合红线：只匹配页面真实暴露的 label。
 */
export function resolveObjectByLabel(snapshot: PageSnapshot, phrase: string): RefResolution {
  const p = phrase.trim();
  if (!p) return { ok: false, error: '空引用' };

  const exact = snapshot.objects.filter((o) => o.label === p);
  if (exact.length === 1) return { ok: true, ref: exact[0]!.ref };
  if (exact.length > 1) return { ok: false, error: `"${p}" 精确匹配多个对象，无法确定` };

  const hits = snapshot.objects.filter(
    (o) => o.label.length > 0 && (o.label.includes(p) || p.includes(o.label)),
  );
  if (hits.length === 1) return { ok: true, ref: hits[0]!.ref };
  if (hits.length > 1) {
    return { ok: false, error: `"${p}" 匹配多个对象（${hits.map((o) => o.label).join('、')}），请说得更具体` };
  }
  return { ok: false, error: `没有对象的标签匹配 "${p}"` };
}

export function resolveRef(
  snapshot: PageSnapshot,
  refId: string,
  expectedKind: RefKind,
): RefResolution {
  const all: Ref[] = [
    ...snapshot.objects.map((n) => n.ref),
    ...snapshot.actions.map((n) => n.ref),
    ...snapshot.controls.map((n) => n.ref),
    ...snapshot.surfaces.map((n) => n.ref),
  ];
  let found = all.find((r) => r.id === refId);
  // 容错：模型常省略 kind 前缀（detail→surface:detail、ticket:101→object:ticket:101）。
  // 用工具的 expectedKind 补全后再找；仍只接受真实存在的 ref，不放任猜测。
  if (!found && !refId.startsWith(`${expectedKind}:`)) {
    found = all.find((r) => r.id === `${expectedKind}:${refId}`);
  }
  if (!found) {
    return { ok: false, error: `ref "${refId}" not found in current page` };
  }
  if (found.kind !== expectedKind) {
    return { ok: false, error: `ref "${refId}" is a ${found.kind}, expected ${expectedKind}` };
  }
  return { ok: true, ref: found };
}
