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
  const found = all.find((r) => r.id === refId);
  if (!found) {
    return { ok: false, error: `ref "${refId}" not found in current page` };
  }
  if (found.kind !== expectedKind) {
    return { ok: false, error: `ref "${refId}" is a ${found.kind}, expected ${expectedKind}` };
  }
  return { ok: true, ref: found };
}
