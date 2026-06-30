import type { ObjectNode, PageSnapshot } from '../../types';
import type { Node, Program, Query } from './types';

/**
 * 从已校验的程序 AST 推导出**高层里程碑**计划（不逐节点摊开）。
 * 设计取舍：聊天里给舒适的概览，精确的逐步审计留给证据账本。计划来自即将执行的程序本身，可审计。
 */
export function summarizeProgram(program: Program, snapshot: PageSnapshot): string[] {
  const lines: string[] = [];
  for (const node of program.body) {
    const line = lineFor(node, snapshot);
    if (line !== undefined) lines.push(line);
  }
  return lines;
}

function matchObjects(snapshot: PageSnapshot, q: Query): ObjectNode[] {
  return snapshot.objects
    .filter((o) => q.type === undefined || o.type === q.type)
    .filter((o) => q.labelContains === undefined || o.label.includes(q.labelContains));
}

/** 顶层节点 → 一行里程碑（finish/forEach/if 各自收敛）。 */
function lineFor(node: Node, snapshot: PageSnapshot): string | undefined {
  switch (node.op) {
    case 'finish':
      return undefined; // 最终回答，不是计划动作
    case 'forEach': {
      const objs = matchObjects(snapshot, node.query);
      const what = node.query.type ?? '对象';
      if (objs.length === 0) return `（没有匹配的 ${what}）`;
      return `对 ${objs.length} 个 ${what}：${verbs(node.do, snapshot)}`;
    }
    case 'if':
      return `若「${node.cond.surface}」含“${node.cond.contains}”，则：${verbs(node.then, snapshot)}`;
    default:
      return verb(node, snapshot);
  }
}

/** 一串节点 → 简短动词描述，用「、」连接（用于 forEach/if 的收敛）。 */
function verbs(nodes: Node[], snapshot: PageSnapshot): string {
  return nodes
    .map((n) => verb(n, snapshot))
    .filter((v): v is string => v !== undefined)
    .join('、');
}

/** 单个节点 → 简短人话动词。 */
function verb(node: Node, snapshot: PageSnapshot): string | undefined {
  switch (node.op) {
    case 'observe':
      return '查看页面';
    case 'open':
      return '打开';
    case 'read':
      return `查看「${node.surface}」`;
    case 'setControl':
      return `把「${node.on.control}」设为 ${node.value}`;
    case 'invoke':
      return snapshot.actions.find((a) => a.name === node.action)?.label ?? node.action;
    case 'forEach':
      return '逐个处理';
    case 'if':
      return '按情况处理';
    case 'finish':
      return undefined;
  }
}
