/**
 * Code-as-Action 的程序 AST。模型经 `runProgram` 一次交出结构化 JSON 程序，
 * harness 逐节点对实时快照校验+求值——不引入新信任模型，只编排被严格把关的原语。
 */

/** 对象过滤。只用契约真实暴露的字段：type（精确）、labelContains（label 子串）。 */
export interface Query {
  type?: string;
  labelContains?: string;
}

export interface Cond {
  surface: string;
  contains: string;
}

export type Node =
  | { op: 'observe' }
  | { op: 'forEach'; query: Query; as: string; do: Node[] }
  | { op: 'if'; cond: Cond; then: Node[]; else?: Node[] }
  | { op: 'open'; on: string } // "$var"（forEach 绑定）或字面 object ref id
  | { op: 'read'; surface: string } // surface 名
  | { op: 'setControl'; on: { control: string }; value: string } // control 名
  | { op: 'invoke'; action: string } // action 名
  | { op: 'finish'; answer: string };

export interface Program {
  body: Node[];
}

const KNOWN_OPS = new Set([
  'observe',
  'forEach',
  'if',
  'open',
  'read',
  'setControl',
  'invoke',
  'finish',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateNode(node: unknown, path: string, errors: string[]): void {
  if (!isObject(node)) {
    errors.push(`${path}: 节点必须是对象`);
    return;
  }
  const op = node.op;
  if (typeof op !== 'string' || !KNOWN_OPS.has(op)) {
    errors.push(`${path}: 未知或缺失 op "${String(op)}"`);
    return;
  }

  const need = (cond: boolean, msg: string) => {
    if (!cond) errors.push(`${path}(${op}): ${msg}`);
  };
  const validateBody = (body: unknown, key: string) => {
    if (!Array.isArray(body)) {
      errors.push(`${path}(${op}): ${key} 必须是数组`);
      return;
    }
    body.forEach((n, i) => validateNode(n, `${path}.${key}[${i}]`, errors));
  };

  switch (op) {
    case 'observe':
      break;
    case 'forEach':
      need(isObject(node.query), '缺 query');
      need(typeof node.as === 'string' && node.as.length > 0, '缺 as');
      validateBody(node.do, 'do');
      break;
    case 'if': {
      const cond = node.cond;
      need(
        isObject(cond) && typeof cond.surface === 'string' && typeof cond.contains === 'string',
        '缺 cond{surface,contains}',
      );
      validateBody(node.then, 'then');
      if (node.else !== undefined) validateBody(node.else, 'else');
      break;
    }
    case 'open':
      need(typeof node.on === 'string' && node.on.length > 0, '缺 on');
      break;
    case 'read':
      need(typeof node.surface === 'string' && node.surface.length > 0, '缺 surface');
      break;
    case 'setControl':
      need(isObject(node.on) && typeof (node.on as { control?: unknown }).control === 'string', '缺 on{control}');
      need(typeof node.value === 'string', '缺 value');
      break;
    case 'invoke':
      need(typeof node.action === 'string' && node.action.length > 0, '缺 action');
      break;
    case 'finish':
      need(typeof node.answer === 'string', '缺 answer');
      break;
  }
}

/** 结构校验。返回错误列表，空数组表示合法。只查形状，不碰快照。 */
export function validateProgram(program: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(program) || !Array.isArray(program.body)) {
    errors.push('program.body 必须是数组');
    return errors;
  }
  program.body.forEach((n, i) => validateNode(n, `body[${i}]`, errors));
  return errors;
}
