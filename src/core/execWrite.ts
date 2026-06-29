import type { HostAdapter } from '../host/types';
import type { ConfirmFn, Intent } from '../honesty/types';
import type { AgentStep } from './loop';
import { resolveRef } from './refResolver';
import { isHighRisk } from '../honesty/riskPolicy';
import { diffSnapshots } from '../honesty/verifier';
import { Ledger } from '../honesty/ledger';
import type { RefKind } from '../types';

export interface WriteRequest {
  tool: 'setControl' | 'invokeAction';
  refId: string;
  value?: string;
}

export interface WriteResult {
  steps: AgentStep[];
  toolResult: string;
  verified: boolean;
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

  if (req.tool === 'invokeAction' && isHighRisk(before, req.refId)) {
    const action = before.actions.find((a) => a.ref.id === req.refId);
    const actionName = action?.name ?? req.refId;
    if (grantedScopes.has(actionName)) {
      confirmed = true; // 作用域已授权，本 run 内不再追问
    } else {
      const intent: Intent = {
        actionRef: req.refId,
        label: action?.label ?? req.refId,
        expectedEvidence: [`执行 ${actionName} 后页面应发生可观察变化`],
      };
      ledger.record({ kind: 'intent', refId: req.refId, label: intent.label, expectedEvidence: intent.expectedEvidence });
      steps.push({ type: 'held', tool: req.tool, refId: req.refId, intent });

      const decision = await confirm(intent);
      ledger.record({ kind: 'grant', refId: req.refId, approved: decision.approved, scope: decision.scope });
      if (!decision.approved) {
        steps.push({ type: 'cancelled', tool: req.tool, refId: req.refId, reason: 'user declined' });
        return { steps, toolResult: 'ACTION CANCELLED: 用户拒绝了该高风险操作。', verified: false };
      }
      confirmed = true;
      if (decision.scope === 'all') grantedScopes.add(actionName);
    }
  }

  const result =
    req.tool === 'setControl'
      ? await host.setControl(res.ref, req.value ?? '')
      : await host.invokeAction(res.ref);
  const evidence = diffSnapshots(before, result.snapshot);
  ledger.record({ kind: 'write', tool: req.tool, refId: req.refId, verified: evidence.changed, evidence: evidence.details });
  steps.push({ type: 'action', tool: req.tool, refId: req.refId, verified: evidence.changed, evidence: evidence.details });

  const base = evidence.changed
    ? `done; 证据: ${evidence.details.join('; ')}`
    : '已执行，但未检测到可观察变化（未验证）。';
  const toolResult = confirmed ? `（此高风险操作已由用户确认后才执行）${base}` : base;
  return { steps, toolResult, verified: evidence.changed };
}
