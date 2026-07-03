import type { PageSnapshot } from '../types';
import type { Evidence } from './types';

export function diffSnapshots(before: PageSnapshot, after: PageSnapshot): Evidence {
  const details: string[] = [];

  if (before.url !== after.url) {
    details.push(`url: ${before.url} → ${after.url}`);
  }

  // 四类节点的出现/消失都是可观察变化——tab/手风琴/向导换面板时对象可能纹丝不动、
  // 换掉的是控件和动作；toast/告示则是 surface 出现。只看对象会对这些全盲。
  const setDiff = (kind: string, beforeIds: Set<string>, afterIds: Set<string>): void => {
    for (const id of afterIds) if (!beforeIds.has(id)) details.push(`${kind} appeared: ${id}`);
    for (const id of beforeIds) if (!afterIds.has(id)) details.push(`${kind} gone: ${id}`);
  };
  const ids = (xs: readonly { ref: { id: string } }[]): Set<string> => new Set(xs.map((x) => x.ref.id));
  setDiff('object', ids(before.objects), ids(after.objects));
  setDiff('control', ids(before.controls), ids(after.controls));
  setDiff('action', ids(before.actions), ids(after.actions));
  setDiff('surface', ids(before.surfaces), ids(after.surfaces));

  const beforeCtrl = new Map(before.controls.map((c) => [c.ref.id, c.value]));
  for (const c of after.controls) {
    if (beforeCtrl.has(c.ref.id) && beforeCtrl.get(c.ref.id) !== c.value) {
      details.push(`control ${c.ref.id}: ${beforeCtrl.get(c.ref.id)} → ${c.value}`);
    }
  }

  const beforeSurf = new Map(before.surfaces.map((s) => [s.ref.id, s.text]));
  for (const s of after.surfaces) {
    if (beforeSurf.has(s.ref.id) && beforeSurf.get(s.ref.id) !== s.text) {
      details.push(`surface ${s.ref.id} changed`);
    }
  }

  return { changed: details.length > 0, details };
}
