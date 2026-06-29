import type { PageSnapshot, Ref, RefKind } from '../types';

export type RefResolution = { ok: true; ref: Ref } | { ok: false; error: string };

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
