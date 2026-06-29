import type { PageSnapshot } from '../types';

export function pageSignature(s: PageSnapshot): string {
  const uniqSorted = (xs: string[]) => [...new Set(xs)].sort().join(',');
  const route = s.url.split('?')[0] ?? s.url;
  const objTypes = uniqSorted(s.objects.map((o) => o.type));
  const actNames = uniqSorted(s.actions.map((a) => a.name));
  const ctrlNames = uniqSorted(s.controls.map((c) => c.name));
  const surfNames = uniqSorted(s.surfaces.map((x) => x.name));
  return `${route}|obj:${objTypes}|act:${actNames}|ctrl:${ctrlNames}|surf:${surfNames}`;
}

export function goalKey(goal: string): string {
  return goal.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function memoryKey(s: PageSnapshot, goal: string): string {
  return `${pageSignature(s)}|>${goalKey(goal)}`;
}
