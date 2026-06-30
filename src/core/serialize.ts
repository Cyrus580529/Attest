import type { ObjectNode, PageSnapshot } from '../types';

export interface SerializeOptions {
  /**
   * 渐进披露：某类型对象数超过此值则折叠为轮廓（总数+样例+钻取提示），不逐个列。
   * 不传 = 全列（默认；读循环 / observe / open 的按需取详走这条，保证完整细节）。
   */
  maxPerType?: number;
}

const SAMPLE_COUNT = 3;

function objectLine(o: ObjectNode): string {
  return `object ${o.ref.id} — ${o.label}`;
}

function outlineObjects(objects: readonly ObjectNode[], maxPerType: number): string[] {
  const byType = new Map<string, ObjectNode[]>();
  for (const o of objects) {
    const arr = byType.get(o.type) ?? [];
    arr.push(o);
    byType.set(o.type, arr);
  }
  const lines: string[] = [];
  for (const [type, objs] of byType) {
    if (objs.length <= maxPerType) {
      for (const o of objs) lines.push(objectLine(o));
    } else {
      const samples = objs.slice(0, SAMPLE_COUNT).map((o) => `${o.ref.id} — ${o.label}`).join('; ');
      lines.push(
        `objects type=${type}: 共 ${objs.length} 个（例: ${samples} …还有 ${objs.length - SAMPLE_COUNT} 个；` +
          `用 forEach{query:{type:"${type}"}} 遍历，或 query.labelContains 过滤具体项）`,
      );
    }
  }
  return lines;
}

export function serializeSnapshot(s: PageSnapshot, opts: SerializeOptions = {}): string {
  const lines: string[] = [`url: ${s.url}`];
  if (opts.maxPerType === undefined) {
    for (const o of s.objects) lines.push(objectLine(o));
  } else {
    lines.push(...outlineObjects(s.objects, opts.maxPerType));
  }
  for (const a of s.actions) {
    lines.push(`action ${a.ref.id}${a.risk === 'high' ? ' [high-risk]' : ''} — ${a.label}`);
  }
  for (const c of s.controls) lines.push(`control ${c.ref.id} = ${c.value ?? ''} — ${c.label}`);
  for (const su of s.surfaces) lines.push(`surface ${su.ref.id} — ${su.name}`);
  return lines.join('\n');
}
