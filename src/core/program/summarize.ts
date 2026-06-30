import type { ObjectNode, PageSnapshot } from '../../types';
import type { Node, Program, Query } from './types';

/**
 * 从已通过校验的程序 AST 推导出人话计划（用对象标题/动作名，而非 ref id）。
 * 关键：计划来自“即将真实执行的程序”本身，不是模型的自述——所见即所跑，可审计。
 */
export function summarizeProgram(program: Program, snapshot: PageSnapshot): string[] {
  const lines: string[] = [];
  walk(program.body, undefined, snapshot, lines, '');
  return lines;
}

function matchObjects(snapshot: PageSnapshot, q: Query): ObjectNode[] {
  return snapshot.objects
    .filter((o) => q.type === undefined || o.type === q.type)
    .filter((o) => q.labelContains === undefined || o.label.includes(q.labelContains));
}

function objFor(on: string, ctx: ObjectNode | undefined, snapshot: PageSnapshot): ObjectNode | undefined {
  if (on.startsWith('$')) return ctx;
  return snapshot.objects.find((o) => o.ref.id === on);
}

function walk(
  nodes: Node[],
  ctx: ObjectNode | undefined,
  snapshot: PageSnapshot,
  lines: string[],
  indent: string,
): void {
  for (const node of nodes) {
    switch (node.op) {
      case 'observe':
        lines.push(`${indent}查看当前页面`);
        break;
      case 'forEach': {
        const objs = matchObjects(snapshot, node.query);
        if (objs.length === 0) {
          lines.push(`${indent}（没有匹配的${node.query.type ?? '对象'}）`);
          break;
        }
        for (const obj of objs) walk(node.do, obj, snapshot, lines, indent);
        break;
      }
      case 'if':
        lines.push(`${indent}若「${node.cond.surface}」含“${node.cond.contains}”，则：`);
        walk(node.then, ctx, snapshot, lines, `${indent}　`);
        if (node.else && node.else.length > 0) {
          lines.push(`${indent}否则：`);
          walk(node.else, ctx, snapshot, lines, `${indent}　`);
        }
        break;
      case 'open': {
        const obj = objFor(node.on, ctx, snapshot);
        lines.push(`${indent}打开「${obj?.label ?? node.on}」`);
        break;
      }
      case 'read':
        lines.push(`${indent}查看「${node.surface}」区域`);
        break;
      case 'setControl':
        lines.push(`${indent}把「${node.on.control}」设为 ${node.value}`);
        break;
      case 'invoke': {
        const label = snapshot.actions.find((a) => a.name === node.action)?.label ?? node.action;
        lines.push(`${indent}${label}${ctx ? `（${ctx.label}）` : ''}`);
        break;
      }
      case 'finish':
        // finish 是最终回答，不是计划动作
        break;
    }
  }
}
