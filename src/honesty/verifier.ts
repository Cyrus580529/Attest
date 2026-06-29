import type { PageSnapshot } from '../types';
import type { Evidence } from './types';

export function diffSnapshots(before: PageSnapshot, after: PageSnapshot): Evidence {
  const details: string[] = [];

  if (before.url !== after.url) {
    details.push(`url: ${before.url} → ${after.url}`);
  }

  const beforeObj = new Set(before.objects.map((o) => o.ref.id));
  const afterObj = new Set(after.objects.map((o) => o.ref.id));
  for (const id of afterObj) if (!beforeObj.has(id)) details.push(`object appeared: ${id}`);
  for (const id of beforeObj) if (!afterObj.has(id)) details.push(`object gone: ${id}`);

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
