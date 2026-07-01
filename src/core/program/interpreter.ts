import type { PageSnapshot } from '../../types';
import type { HostAdapter } from '../../host/types';
import type { ConfirmFn } from '../../honesty/types';
import { Ledger } from '../../honesty/ledger';
import type { AgentStep } from '../loop';
import { resolveRef, resolveObjectByLabel } from '../refResolver';
import type { RefResolution } from '../refResolver';
import { serializeSnapshot } from '../serialize';
import { executeWrite } from '../execWrite';
import { matchesPrediction } from '../speculation/prediction';
import type { Cond, Node, Program, Query } from './types';

const DEFAULT_MAX_NODES = 200;

export interface InterpreterDeps {
  host: HostAdapter;
  ledger: Ledger;
  confirm: ConfirmFn;
  maxNodes?: number;
}

export interface ProgramResult {
  answer: string;
  aborted: boolean;
}

/** 控制信号：继续 / 中止 / 命中 finish（带 answer）。 */
type Signal = 'continue' | 'abort' | { finish: string };

/**
 * 解释一段程序：async 递归求值，每个引用页面的节点对**实时快照**解析；
 * 写经 executeWrite（高危挂起式 held + 作用域授权 + verify）；任一节点 error 或写未验证 → 中止。
 * 不计算 outcome——由调用方对 ledger 跑 computeOutcome/guardFinish。
 */
export async function* runProgram(
  program: Program,
  deps: InterpreterDeps,
): AsyncGenerator<AgentStep, ProgramResult> {
  const { host, ledger, confirm } = deps;
  const maxNodes = deps.maxNodes ?? DEFAULT_MAX_NODES;
  const env = new Map<string, string>(); // $var 名（去 $）→ object ref id
  const grantedScopes = new Set<string>();
  let budget = maxNodes;

  function filterObjects(snap: PageSnapshot, q: Query): string[] {
    return snap.objects
      .filter((o) => q.type === undefined || o.type === q.type)
      .filter((o) => q.labelContains === undefined || o.label.includes(q.labelContains))
      .map((o) => o.ref.id);
  }

  function evalCond(snap: PageSnapshot, c: Cond): boolean {
    const surf = snap.surfaces.find((s) => s.name === c.surface);
    return surf ? surf.text.includes(c.contains) : false;
  }

  /** 解析 open 的目标对象：$var→环境→ref-id；否则先当 ref-id，再当描述按 label 解析（歧义即拒绝，不猜）。 */
  function resolveObjectOn(snap: PageSnapshot, on: string): RefResolution {
    if (on.startsWith('$')) {
      const id = env.get(on.slice(1));
      if (!id) return { ok: false, error: `未绑定变量或空引用: ${on}` };
      return resolveRef(snap, id, 'object');
    }
    const direct = resolveRef(snap, on, 'object');
    return direct.ok ? direct : resolveObjectByLabel(snap, on);
  }

  async function* fail(op: string, error: string, refId?: string): AsyncGenerator<AgentStep, Signal> {
    ledger.record({ kind: 'error', tool: op, detail: error });
    yield { type: 'error', tool: op, refId, error };
    return 'abort';
  }

  async function* runWrite(
    op: string,
    req: { tool: 'setControl' | 'invokeAction'; refId: string; value?: string },
    predict?: string[],
  ): AsyncGenerator<AgentStep, Signal> {
    const { steps } = await executeWrite(host, ledger, confirm, grantedScopes, req);
    for (const s of steps) yield s;
    if (steps.some((s) => s.type === 'error')) return 'abort';
    if (steps.some((s) => s.type === 'cancelled')) return 'continue'; // 拒绝不中止整批
    const actionStep = steps.find((s) => s.type === 'action') as
      | Extract<AgentStep, { type: 'action' }>
      | undefined;
    if (actionStep && !actionStep.verified) return 'abort'; // 写未验证 → 中止
    // 模型 lookahead：predict 只影响观测（speculate/mispredict），不污染 verify/outcome。
    if (predict && predict.length > 0 && actionStep) {
      const hit = matchesPrediction(
        { changed: actionStep.verified, details: actionStep.evidence },
        { expectDetails: predict },
      );
      yield { type: 'speculate', tool: req.tool, refId: actionStep.refId, hit };
      if (!hit) {
        yield {
          type: 'mispredict',
          tool: req.tool,
          refId: actionStep.refId,
          expected: predict,
          actual: actionStep.evidence,
        };
      }
    }
    return 'continue';
  }

  async function* evalNodes(nodes: Node[]): AsyncGenerator<AgentStep, Signal> {
    for (const node of nodes) {
      const sig = yield* evalNode(node);
      if (sig !== 'continue') return sig;
    }
    return 'continue';
  }

  async function* evalNode(node: Node): AsyncGenerator<AgentStep, Signal> {
    if (budget-- <= 0) {
      return yield* fail(node.op, `超出节点预算（maxNodes=${maxNodes}）`);
    }

    switch (node.op) {
      case 'observe': {
        const text = serializeSnapshot(host.snapshot());
        ledger.record({ kind: 'observe', tool: 'observe', detail: text });
        yield { type: 'observation', tool: 'observe', result: text };
        return 'continue';
      }
      case 'forEach': {
        const ids = filterObjects(host.snapshot(), node.query);
        for (const id of ids) {
          env.set(node.as, id);
          const sig = yield* evalNodes(node.do);
          if (sig !== 'continue') return sig;
        }
        return 'continue';
      }
      case 'if': {
        const branch = evalCond(host.snapshot(), node.cond) ? node.then : node.else ?? [];
        return yield* evalNodes(branch);
      }
      case 'open': {
        const res = resolveObjectOn(host.snapshot(), node.on);
        if (!res.ok) return yield* fail('open', res.error, node.on);
        const r = await host.openObject(res.ref);
        const text = serializeSnapshot(r.snapshot);
        ledger.record({ kind: 'observe', tool: 'openObject', detail: text });
        yield { type: 'observation', tool: 'openObject', refId: res.ref.id, result: text };
        return 'continue';
      }
      case 'read': {
        const surf = host.snapshot().surfaces.find((s) => s.name === node.surface);
        if (!surf) return yield* fail('read', `surface 未找到: ${node.surface}`);
        const text = host.readSurface(surf.ref);
        ledger.record({ kind: 'observe', tool: 'readSurface', detail: text });
        yield { type: 'observation', tool: 'readSurface', refId: surf.ref.id, result: text };
        return 'continue';
      }
      case 'setControl': {
        const ctrl = host.snapshot().controls.find((c) => c.name === node.on.control);
        if (!ctrl) return yield* fail('setControl', `control 未找到: ${node.on.control}`);
        return yield* runWrite('setControl', { tool: 'setControl', refId: ctrl.ref.id, value: node.value }, node.predict);
      }
      case 'invoke': {
        const action = host.snapshot().actions.find((a) => a.name === node.action);
        if (!action) return yield* fail('invoke', `action 未找到: ${node.action}`);
        return yield* runWrite('invoke', { tool: 'invokeAction', refId: action.ref.id }, node.predict);
      }
      case 'finish':
        return { finish: node.answer };
    }
  }

  const sig = yield* evalNodes(program.body);
  if (typeof sig === 'object') return { answer: sig.finish, aborted: false };
  return { answer: '', aborted: sig === 'abort' };
}
