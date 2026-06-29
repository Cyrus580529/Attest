# Attest 切片 4a：长程自主 + 跨回合引用 + 示范应用 实施计划

> REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development。Steps 用 `- [ ]`。

**Goal:** 实现跨回合引用（CandidateSet + ReferenceResolver）与长程追踪（PlanRunner），附极小非 SkillFlow 示范页。Page Memory 留 4b。

**Architecture:** 三者为确定性纯工具，全用 FakeLlm+FakeHost 测；loop 深度编排靠 LLM live 调，不提前过度集成。

## 文件结构
- `src/core/candidateSet.ts` — CandidateSet + candidatesFromSnapshot
- `src/core/referenceResolver.ts` — resolveReference（指代解析）
- `src/core/planRunner.ts` — PlanRunner（visited/synthesis）
- `examples/mini-board/` — 示范页 + 接线
- `src/index.ts` — 导出

---

## Task 1：CandidateSet
**Files:** `src/core/candidateSet.ts`；`test/core/candidateSet.test.ts`

测试：candidatesFromSnapshot 按 domain 收集 object 候选；advance 换一个跳过 rejected；到末尾返回 null；select 记录。

实现 `src/core/candidateSet.ts`：
```ts
import type { PageSnapshot, Ref } from '../types';

export class CandidateSet {
  readonly domain: string;
  presented: Ref[];
  cursor = 0;
  selected: Ref | null = null;
  rejected: Ref[] = [];

  constructor(domain: string, presented: Ref[] = []) {
    this.domain = domain;
    this.presented = presented;
  }

  present(refs: Ref[]): void {
    this.presented = refs;
    this.cursor = 0;
  }

  current(): Ref | null {
    return this.presented[this.cursor] ?? null;
  }

  advance(): Ref | null {
    let i = this.cursor + 1;
    while (i < this.presented.length && this.isRejected(this.presented[i]!)) i++;
    if (i >= this.presented.length) return null;
    this.cursor = i;
    return this.presented[i]!;
  }

  select(ref: Ref): void {
    this.selected = ref;
  }

  reject(ref: Ref): void {
    if (!this.isRejected(ref)) this.rejected.push(ref);
  }

  private isRejected(ref: Ref): boolean {
    return this.rejected.some((r) => r.id === ref.id);
  }
}

export function candidatesFromSnapshot(snapshot: PageSnapshot, domain: string): CandidateSet {
  const refs = snapshot.objects.filter((o) => o.type === domain).map((o) => o.ref);
  return new CandidateSet(domain, refs);
}
```
Commit: `feat(core): CandidateSet + candidatesFromSnapshot（跨回合候选）`

---

## Task 2：ReferenceResolver
**Files:** `src/core/referenceResolver.ts`；`test/core/referenceResolver.test.ts`

测试：换一个→推进；就它/这个→当前或已选；第二个→序号；明确名称匹配；无法判定→clarify。

实现 `src/core/referenceResolver.ts`：
```ts
import type { PageSnapshot, Ref } from '../types';
import type { CandidateSet } from './candidateSet';

export type Reference = { ok: true; ref: Ref; via: string } | { ok: false; clarify: string };

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseIndex(raw: string): number {
  return /^[0-9]+$/.test(raw) ? Number(raw) : (CN_NUM[raw] ?? NaN);
}

export function resolveReference(
  phrase: string,
  snapshot: PageSnapshot,
  candidates: CandidateSet,
): Reference {
  const p = phrase.trim();

  if (/换(一个|个)|下一个|其他|别的/.test(p)) {
    const next = candidates.advance();
    return next
      ? { ok: true, ref: next, via: 'next-candidate' }
      : { ok: false, clarify: '没有更多候选了，要不要我重新列一遍？' };
  }

  const ord = p.match(/第\s*([0-9]+|[一二三四五六七八九十])\s*个/);
  if (ord) {
    const n = parseIndex(ord[1]!);
    const ref = candidates.presented[n - 1];
    return ref ? { ok: true, ref, via: 'ordinal' } : { ok: false, clarify: `没有第 ${n} 个候选。` };
  }

  if (/随便|任意|都行|你来定|你定/.test(p)) {
    const ref = candidates.current();
    return ref ? { ok: true, ref, via: 'arbitrary' } : { ok: false, clarify: '当前没有候选可选。' };
  }

  if (/这个|那个|就它|就这个|选它|要它/.test(p)) {
    const ref = candidates.selected ?? candidates.current();
    return ref ? { ok: true, ref, via: 'current' } : { ok: false, clarify: '你指的是哪一个？' };
  }

  const byName = snapshot.objects.find((o) => o.label.length > 0 && p.includes(o.label));
  if (byName) return { ok: true, ref: byName.ref, via: 'name' };

  return { ok: false, clarify: '你指的是哪一个？' };
}
```
Commit: `feat(core): ReferenceResolver（换一个/就它/第N个/随便选/名称）`

---

## Task 3：PlanRunner
**Files:** `src/core/planRunner.ts`；`test/core/planRunner.test.ts`

测试：markVisited/hasVisited；remaining 过滤已访问；addFinding/summary 累积汇总。

实现 `src/core/planRunner.ts`：
```ts
export class PlanRunner {
  readonly goal: string;
  private readonly visitedSet = new Set<string>();
  private readonly synthesis: string[] = [];

  constructor(goal: string) {
    this.goal = goal;
  }

  markVisited(refId: string): void {
    this.visitedSet.add(refId);
  }

  hasVisited(refId: string): boolean {
    return this.visitedSet.has(refId);
  }

  remaining(candidateIds: string[]): string[] {
    return candidateIds.filter((id) => !this.visitedSet.has(id));
  }

  addFinding(text: string): void {
    this.synthesis.push(text);
  }

  summary(): string {
    return this.synthesis.join('\n');
  }

  get visited(): string[] {
    return [...this.visitedSet];
  }
}
```
Commit: `feat(core): PlanRunner（visited/synthesis 长程追踪）`

---

## Task 4：示范应用 examples/mini-board
**Files:** `examples/mini-board/index.html`、`examples/mini-board/main.ts`；`test/examples/miniBoard.test.ts`

测试：读取 index.html，注入 body，parseContract 后断言含 ticket 对象、open 动作、detail surface、resolve 高危动作。

`examples/mini-board/index.html`：含 `data-agent-surface="board"`、三个 `data-agent-object="ticket:10x"`、`data-agent-action="open"`、`data-agent-surface="detail"`、`data-agent-action="resolve" data-agent-risk="high"`。

`examples/mini-board/main.ts`：createAgent(createOpenAiAdapter + createDomHostAdapter + confirm)，注释说明 live 用法。

Commit: `feat(examples): mini-board 非 SkillFlow 示范页`

---

## Task 5：导出 + 全量验证 + Live 闸更新
`src/index.ts` 追加：CandidateSet/candidatesFromSnapshot、resolveReference/Reference、PlanRunner。
`docs/LIVE-ACCEPTANCE.md` 追加 4a 场景（长程多详情综合、换一个/就它引用、高危 held）。
全量 `npm test && npm run typecheck && npm run build`。
Commit: `feat(api): 导出 4a 公共面 + Live 闸补长程/引用场景`

---

## 验收
- npm test 全绿；typecheck 0；build 含新模块。
- Live 闸（需 key）：长程综合、换一个/就它、高危 held——未跑前标"代码完成、待 live 验收"。

## 自审
- Spec 覆盖切片4 §2/§3/§5；Page Memory(§4)留 4b。
- 类型一致：CandidateSet 方法集、Reference 二态、resolveReference(phrase,snapshot,candidates)、PlanRunner 方法集一致。
- YAGNI：只交付可测工具 + 示范页。
