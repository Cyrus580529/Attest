import type { HostAdapter } from '../host/types';
import type { ConfirmFn, Intent } from '../honesty/types';
import type { AgentStep } from './loopTypes';
import { resolveRef } from './refResolver';
import { isHighRisk } from '../honesty/riskPolicy';
import { diffSnapshots } from '../honesty/verifier';
import { Ledger } from '../honesty/ledger';
import type { Ref, RefKind } from '../types';

export interface WriteRequest {
  tool: 'setControl' | 'invokeAction';
  refId: string;
  value?: string;
  /** 带参动作（VOIX 带 <prop> 的 tool）的调用参数。 */
  args?: Record<string, unknown>;
}

export interface WriteResult {
  steps: AgentStep[];
  toolResult: string;
  verified: boolean;
  /** 成功路径回传解析出的 ref，供读循环记忆录制（recordRef）。 */
  ref?: Ref;
  /** 本次写经 diffSnapshots 验证出的证据 details——供记忆/世界模型录制为预测。 */
  evidence?: string[];
}

/**
 * 共享写原语：resolve → 高危 held（含作用域授权）→ host 调用 → diffSnapshots 验证 → 记账。
 * 读循环、程序解释器都复用它，信任不变量（只引用真实 ref / verify-or-refuse / 高危 held）只此一处。
 */
export async function executeWrite(
  host: HostAdapter,
  ledger: Ledger,
  confirm: ConfirmFn,
  grantedScopes: Set<string>,
  req: WriteRequest,
): Promise<WriteResult> {
  const before = host.snapshot();
  const writeKind: RefKind = req.tool === 'setControl' ? 'control' : 'action';
  const res = resolveRef(before, req.refId, writeKind);
  if (!res.ok) {
    ledger.record({ kind: 'error', tool: req.tool, detail: res.error });
    return {
      steps: [{ type: 'error', tool: req.tool, refId: req.refId, error: res.error }],
      toolResult: `ERROR: ${res.error}`,
      verified: false,
    };
  }

  const steps: AgentStep[] = [];
  let confirmed = false;
  let awaitedConfirm = false;

  // 来源感知信任：高危 invoke → held（原有）；任何 inferred（推断而非声明）的写 → 也 held。
  // 因为推断的 handle 我们没那么确定它的语义，"不确定就问"。
  const targetNode =
    req.tool === 'setControl'
      ? before.controls.find((c) => c.ref.id === req.refId)
      : before.actions.find((a) => a.ref.id === req.refId);
  const highRisk = req.tool === 'invokeAction' && isHighRisk(before, req.refId);
  const inferred = targetNode?.provenance === 'inferred';

  if (highRisk || inferred) {
    const name = targetNode?.name ?? req.refId;
    if (grantedScopes.has(name)) {
      confirmed = true; // 作用域已授权，本 run 内不再追问
    } else {
      const note = highRisk ? '（高风险）' : '（来源：推断，未声明契约）';
      const intent: Intent = {
        actionRef: req.refId,
        label: `${targetNode?.label ?? req.refId}${note}`,
        expectedEvidence: [`执行 ${name} 后页面应发生可观察变化`],
      };
      ledger.record({ kind: 'intent', refId: req.refId, label: intent.label, expectedEvidence: intent.expectedEvidence });
      steps.push({ type: 'held', tool: req.tool, refId: req.refId, intent });

      awaitedConfirm = true;
      const decision = await confirm(intent);
      ledger.record({ kind: 'grant', refId: req.refId, approved: decision.approved, scope: decision.scope });
      if (!decision.approved) {
        steps.push({ type: 'cancelled', tool: req.tool, refId: req.refId, reason: 'user declined' });
        return { steps, toolResult: 'ACTION CANCELLED: 用户拒绝了该写操作。', verified: false };
      }
      confirmed = true;
      if (decision.scope === 'all') grantedScopes.add(name);
    }
  }

  // TOCTOU 防线：confirm 可能等了很久，页面早已不是提议时的样子。执行前重照快照、
  // 重解析 ref——目标消失即拒绝（refuse-before）；diff 基线也取执行前一瞬，
  // 免得把等待期间的无关变化归因成本次写的证据（污染账本和世界模型）。
  let preExec = before;
  let target = res.ref;
  if (awaitedConfirm) {
    preExec = host.snapshot();
    const re = resolveRef(preExec, req.refId, writeKind);
    if (!re.ok) {
      const error = `确认等待期间页面已变化，目标不复存在，拒绝执行（${re.error}）`;
      ledger.record({ kind: 'error', tool: req.tool, detail: error });
      steps.push({ type: 'error', tool: req.tool, refId: req.refId, error });
      return { steps, toolResult: `ERROR: ${error}`, verified: false };
    }
    target = re.ref;
  }

  const result =
    req.tool === 'setControl'
      ? await host.setControl(target, req.value ?? '')
      : await host.invokeAction(target, req.args);
  const evidence = diffSnapshots(preExec, result.snapshot);
  ledger.record({ kind: 'write', tool: req.tool, refId: req.refId, verified: evidence.changed, evidence: evidence.details });
  steps.push({ type: 'action', tool: req.tool, refId: req.refId, verified: evidence.changed, evidence: evidence.details });

  const base = evidence.changed
    ? `done; 证据: ${evidence.details.join('; ')}`
    : '已执行，但未检测到可观察变化（未验证）。';
  const toolResult = confirmed ? `（此高风险操作已由用户确认后才执行）${base}` : base;
  return { steps, toolResult, verified: evidence.changed, ref: target, evidence: evidence.details };
}
