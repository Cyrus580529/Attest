import type { PageSnapshot } from '../types';

export function serializeSnapshot(s: PageSnapshot): string {
  const lines: string[] = [`url: ${s.url}`];
  for (const o of s.objects) lines.push(`object ${o.ref.id} — ${o.label}`);
  for (const a of s.actions) {
    lines.push(`action ${a.ref.id}${a.risk === 'high' ? ' [high-risk]' : ''} — ${a.label}`);
  }
  for (const c of s.controls) lines.push(`control ${c.ref.id} = ${c.value ?? ''} — ${c.label}`);
  for (const su of s.surfaces) lines.push(`surface ${su.ref.id} — ${su.name}`);
  return lines.join('\n');
}
