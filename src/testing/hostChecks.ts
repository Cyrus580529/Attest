// 第三方 HostAdapter 合规检查器：内核的信任不变量依赖宿主守约——
// 快照可重照且 ref 稳定、ref 唯一、surface 可读、写效果必须落回快照可观察
// （verify-or-refuse 就是对比前后快照，效果不可观察的宿主会让一切写都"未验证"）。
// 默认只跑只读检查；带副作用的检查（setControl/invokeAction）须显式开 mutating。
import type { HostAdapter } from '../host/types';
import type { PageSnapshot, Ref } from '../types';

export interface HostCheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface HostCheckOptions {
  /** 允许有副作用的检查（会真的写页面）：setControl 试探、可选的动作试探。 */
  mutating?: boolean;
  /** mutating 时 setControl 的试探值（默认 "attest-probe"）。 */
  probeValue?: string;
  /** mutating 时允许试探调用的"安全动作" ref id——不提供则跳过动作检查（防误触 clear_all 之类）。 */
  safeActionRef?: string;
}

function allRefs(s: PageSnapshot): Ref[] {
  return [
    ...s.objects.map((n) => n.ref),
    ...s.actions.map((n) => n.ref),
    ...s.controls.map((n) => n.ref),
    ...s.surfaces.map((n) => n.ref),
  ];
}

export async function checkHostContract(
  host: HostAdapter,
  opts: HostCheckOptions = {},
): Promise<HostCheckResult[]> {
  const results: HostCheckResult[] = [];
  const push = (name: string, pass: boolean, detail?: string) =>
    results.push(detail === undefined ? { name, pass } : { name, pass, detail });

  // 1. 快照可重照且 ref 稳定：页面未变时两次 snapshot 的 id 集必须一致（内核靠 id 重解析 ref）。
  let snap: PageSnapshot;
  try {
    snap = host.snapshot();
    const again = host.snapshot();
    const a = allRefs(snap).map((r) => r.id).sort().join('|');
    const b = allRefs(again).map((r) => r.id).sort().join('|');
    push('snapshot-repeatable', a === b, a === b ? undefined : `两次快照 id 集不同：\n${a}\nvs\n${b}`);
    snap = again;
  } catch (e) {
    push('snapshot-repeatable', false, `snapshot() 抛异常：${e instanceof Error ? e.message : String(e)}`);
    return results; // 照不了相，后续无从检查
  }

  // 2. ref 唯一：重复 id 会让 resolveRef/元素绑定歧义。
  const ids = allRefs(snap).map((r) => r.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  push('refs-unique', dup.length === 0, dup.length ? `重复 id：${[...new Set(dup)].join(', ')}` : undefined);

  // 3. ref.kind 与所在集合一致：kind 错位会让读写路径解析失败。
  const misplaced = [
    ...snap.objects.filter((n) => n.ref.kind !== 'object'),
    ...snap.actions.filter((n) => n.ref.kind !== 'action'),
    ...snap.controls.filter((n) => n.ref.kind !== 'control'),
    ...snap.surfaces.filter((n) => n.ref.kind !== 'surface'),
  ];
  push('refs-kind-consistent', misplaced.length === 0, misplaced.length ? `kind 错位：${misplaced.map((n) => n.ref.id).join(', ')}` : undefined);

  // 4. surface 可读：readSurface 对快照里列出的 surface 必须返回字符串、不抛。
  const surface = snap.surfaces[0];
  if (surface) {
    try {
      const text = host.readSurface(surface.ref);
      push('read-surface', typeof text === 'string', typeof text === 'string' ? undefined : `返回了 ${typeof text}`);
    } catch (e) {
      push('read-surface', false, `readSurface 抛异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!opts.mutating) return results;

  // ── 以下有副作用 ──

  // 5. openObject：返回 HostResult（含新快照）、不抛。
  const obj = snap.objects[0];
  if (obj) {
    try {
      const r = await host.openObject(obj.ref);
      push('open-object', typeof r.ok === 'boolean' && !!r.snapshot, undefined);
    } catch (e) {
      push('open-object', false, `openObject 抛异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 6. 写效果可观察（内核 verify 的根基）：setControl 后新快照必须反映新值。
  const ctrl = host.snapshot().controls[0];
  if (ctrl) {
    const value = opts.probeValue ?? 'attest-probe';
    try {
      await host.setControl(ctrl.ref, value);
      const after = host.snapshot().controls.find((c) => c.ref.id === ctrl.ref.id);
      const ok = after?.value === value;
      push('set-control-observable', ok, ok ? undefined : `写入 "${value}" 后快照里是 "${after?.value ?? '(控件消失)'}"——效果不可观察，verify 会永远失败`);
    } catch (e) {
      push('set-control-observable', false, `setControl 抛异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 7. 动作试探：仅当作者点名"安全动作"时才碰（防误触危险动作）。
  if (opts.safeActionRef) {
    const act = host.snapshot().actions.find((a) => a.ref.id === opts.safeActionRef);
    if (act) {
      try {
        const r = await host.invokeAction(act.ref);
        push('invoke-action', typeof r.ok === 'boolean' && !!r.snapshot, undefined);
      } catch (e) {
        push('invoke-action', false, `invokeAction 抛异常：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return results;
}
