# Attest 切片 4b：页面记忆（编译一次 → 零-LLM 重放）实施计划

> REQUIRED SUB-SKILL: superpowers:executing-plans。Steps 用 `- [ ]`。

**Goal:** agent 把走通的 verified 轨迹按"页面签名+目标"记下，下次同类命中直接重放、零 LLM；verifier 兜底，记忆失效自动回退 LLM；高危重放仍 held。

**Architecture:** pageSignature 取页面"形状"（类型/名集，不含具体 id）→ 跨数据实例命中同签名。RecordedStep 用 name（action/control/surface 稳定）或 ordinal（object 第 N 个）重定位 → 跨实例泛化。重放每步经 refResolver+verifier 把关，任一步失配即中止回退。

## 文件结构
- `src/memory/pageSignature.ts`
- `src/memory/pageMemory.ts`
- `src/core/loop.ts`（集成）
- `src/index.ts`（导出）

---

## Task 1：pageSignature / goalKey / memoryKey
**Files:** `src/memory/pageSignature.ts`；`test/memory/pageSignature.test.ts`

测试：① 同形状不同数据签名相同；② 不同 action 集签名不同；③ goalKey 归一化；④ memoryKey 拼接。

实现：
```ts
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
```
Commit: `feat(memory): pageSignature/goalKey/memoryKey（取形状，跨数据命中）`

---

## Task 2：PageMemory + Recorded 重定位
**Files:** `src/memory/pageMemory.ts`；`test/memory/pageMemory.test.ts`

测试：① recordRef 对 object 给 ordinal、对 action 给 name；② resolveRecordedRef 跨实例（ticket:1 录、ticket:9 页）按 ordinal 命中；③ name 重定位；④ 找不到返回 null；⑤ PageMemory record/lookup。

实现：
```ts
import type { PageSnapshot, Ref } from '../types';

export type RecordedRef =
  | { by: 'name'; kind: 'action' | 'control' | 'surface'; name: string }
  | { by: 'ordinal'; type: string; index: number };

export interface RecordedStep {
  tool: string;
  ref?: RecordedRef;
  value?: string;
  answer?: string;
}

export interface MemoryEntry {
  steps: RecordedStep[];
  recordedAt: number;
}

export function recordRef(snapshot: PageSnapshot, ref: Ref): RecordedRef | undefined {
  if (ref.kind === 'object') {
    const obj = snapshot.objects.find((o) => o.ref.id === ref.id);
    if (!obj) return undefined;
    const sameType = snapshot.objects.filter((o) => o.type === obj.type);
    return { by: 'ordinal', type: obj.type, index: sameType.findIndex((o) => o.ref.id === ref.id) };
  }
  const pool =
    ref.kind === 'action' ? snapshot.actions : ref.kind === 'control' ? snapshot.controls : snapshot.surfaces;
  const node = (pool as { ref: Ref; name: string }[]).find((n) => n.ref.id === ref.id);
  return node ? { by: 'name', kind: ref.kind, name: node.name } : undefined;
}

export function resolveRecordedRef(snapshot: PageSnapshot, rec: RecordedRef): Ref | null {
  if (rec.by === 'ordinal') {
    const sameType = snapshot.objects.filter((o) => o.type === rec.type);
    return sameType[rec.index]?.ref ?? null;
  }
  const pool =
    rec.kind === 'action' ? snapshot.actions : rec.kind === 'control' ? snapshot.controls : snapshot.surfaces;
  return (pool as { ref: Ref; name: string }[]).find((n) => n.name === rec.name)?.ref ?? null;
}

export class PageMemory {
  private readonly store = new Map<string, MemoryEntry>();
  record(key: string, steps: RecordedStep[]): void {
    this.store.set(key, { steps, recordedAt: Date.now() });
  }
  lookup(key: string): MemoryEntry | null {
    return this.store.get(key) ?? null;
  }
}
```
Commit: `feat(memory): PageMemory + recordRef/resolveRecordedRef（ordinal/name 跨实例重定位）`

---

## Task 3：loop 集成（录制 + 重放优先 + 失效回退）
**Files:** `src/core/loop.ts`；`test/core/loopMemory.test.ts`

行为：
- `createAgent({ ..., memory?: PageMemory })`。
- run 开始：`key = memoryKey(host.snapshot(), userMessage)`；若 `memory.lookup(key)` 命中 → 先尝试重放：逐 RecordedStep `resolveRecordedRef` → 执行（高危 invokeAction 仍走 confirm/held）→ 写动作 verifier 对账；任一步 ref 解析失败/写未验证/高危被拒 → 中止重放、回退正常 LLM 循环（从当前状态）。全部成功 → finish（outcome 由 ledger 算）。
- 重放步 yield `{ type: 'replay'; tool; refId }`。
- 正常 LLM 循环成功 finish(completed) 且有 memory → `memory.record(key, recorded)`。
- 录制：processCall 额外返回 `recorded?: RecordedStep`（recordRef 结果 + value），loop 收集；finish 录 `{tool:'finish', answer}`。

测试（FakeLlm + FakeHost）：
1. 首次跑（无记忆）→ 完成 → memory 出现该 key。
2. 第二次同 key（FakeLlm 脚本为空）→ 零 LLM 完成 → 出现 replay step → completed。
3. 记忆失效（FakeHost 换结构使 ref 解析不出）→ 回退 LLM（脚本提供回退步）→ 仍完成。
4. 高危重放 → 仍 held（默认拒绝 → 回退/不执行）。

实现要点：抽 `runLlmLoop(messages, ledger, recorded, opts)` 为内部生成器；run 先 `attemptReplay` 再 fallback 调它。重放与正常共用执行/verify/ledger 逻辑。AgentStep 既有六态 + 新增 `{type:'replay';tool;refId}`，finish 仍带 ledger。
Commit: `feat(core): loop 集成页面记忆（录制+零-LLM重放+失效回退+高危仍held）`

---

## Task 4：导出 + 全量验证 + Live 闸
**Files:** `src/index.ts`；`docs/LIVE-ACCEPTANCE.md`

导出 pageSignature/goalKey/memoryKey、PageMemory、recordRef/resolveRecordedRef 及类型。
Live 闸补：第二次零-LLM 重放、改结构回退、跨实例命中。
全量 `npm test && npm run typecheck && npm run build`。
Commit: `feat(api): 导出页面记忆公共面 + Live 闸补记忆场景`

---

## 验收
- npm test 全绿（切片 1-4b）；typecheck 0；build 含 memory。
- 诚实测试：失效回退而非谎报；高危重放仍 held；重放 ledger 与正常同构。
- Live 闸（需 key）：第二次零-LLM、改结构回退、跨实例命中。

## 自审
- Spec 覆盖切片4 §4 全部。
- 类型一致：RecordedRef 二态、RecordedStep、MemoryEntry、recordRef/resolveRecordedRef、PageMemory、memoryKey。
- 不变量：verifier 仍唯一真相；高危重放仍 held；失效只回退不谎报。
