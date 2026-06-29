# Attest 切片 1：地基 + 契约层 + PageSnapshot 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 Attest 仓库地基，并实现"读取页面 `data-agent-*` 契约 → 紧凑 `PageSnapshot`"的契约层（零 LLM 依赖、纯函数、完全可单测）。

**Architecture:** 纯 TS、框架无关。契约层 `parseContract(root, url)` 把任意 DOM 子树里的 `data-agent-object/action/control/surface` 解析为带稳定 `ref` 的 `PageSnapshot`。`domHostAdapter.snapshot()` 在浏览器里对 `document` 调用它。本切片不含循环、不含 LLM、不含写动作。

**Tech Stack:** TypeScript (ESM, strict)、Vitest（test runner）、happy-dom（测试用 DOM 环境）。

---

## 范围说明

本计划只覆盖 **切片 1**。完整 v1 路线见文末"剩余切片路线图"。**planRunner（长程自主）必须先单独 brainstorm + 用户拍板再立计划**（见 spec 风险 #2 与 CLAUDE.md FlowOps 切片门槛）。

## 文件结构（切片 1 创建/修改的文件）

| 文件 | 职责 |
|------|------|
| `package.json` | 包元数据（name `attest-agent`）、scripts、devDeps |
| `tsconfig.json` | TS 编译配置（strict, ESM, DOM lib） |
| `vitest.config.ts` | 测试环境 = happy-dom |
| `.gitignore` | 忽略 node_modules / dist |
| `src/types.ts` | 核心类型：`Ref`、`*Node`、`PageSnapshot`、`Risk` |
| `src/contract/refs.ts` | `mintRef`——稳定 ref id 生成 + 同快照内去重 |
| `src/contract/parseContract.ts` | DOM 子树 → `PageSnapshot` |
| `src/adapters/domHostAdapter.ts` | `snapshot()`：对 `document` 调 `parseContract` |
| `src/index.ts` | 公共导出入口 |
| `test/contract/refs.test.ts` | refs 单测 |
| `test/contract/parseContract.test.ts` | 契约解析单测 |
| `test/adapters/domHostAdapter.test.ts` | adapter 单测 |

---

## Task 0：仓库脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `test/smoke.test.ts`

- [ ] **Step 1: 写 `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 2: 写 `package.json`**

```json
{
  "name": "attest-agent",
  "version": "0.0.0",
  "description": "Trustworthy, self-verifying web agent core — proposes actions, the harness validates real page refs, every action leaves auditable evidence.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^20.11.0",
    "happy-dom": "^14.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 3: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 4: 写 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: 写冒烟测试 `test/smoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain smoke', () => {
  it('runs vitest and has a DOM document', () => {
    expect(typeof document).toBe('object');
    document.body.innerHTML = '<div id="x">hi</div>';
    expect(document.getElementById('x')?.textContent).toBe('hi');
  });
});
```

- [ ] **Step 6: 安装依赖并运行冒烟测试**

Run: `npm install && npm test`
Expected: PASS（1 passed），证明 vitest + happy-dom 的 `document` 可用。

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json tsconfig.json vitest.config.ts test/smoke.test.ts package-lock.json
git commit -m "chore: 仓库脚手架（TS + Vitest + happy-dom）"
```

---

## Task 1：核心类型 + ref 生成

**Files:**
- Create: `src/types.ts`
- Create: `src/contract/refs.ts`
- Test: `test/contract/refs.test.ts`

- [ ] **Step 1: 写 `src/types.ts`**

```ts
export type RefKind = 'object' | 'action' | 'control' | 'surface';

/** 内核生成的稳定引用。模型只能引用 harness 给出的 ref。 */
export interface Ref {
  readonly kind: RefKind;
  readonly id: string; // 同一快照内唯一，如 "object:task:42"
}

export type Risk = 'low' | 'high';

export interface ObjectNode {
  readonly ref: Ref; // kind: 'object'
  readonly type: string; // 如 "task"
  readonly objectId: string; // 如 "42"
  readonly label: string;
}

export interface ActionNode {
  readonly ref: Ref; // kind: 'action'
  readonly name: string; // 如 "apply"
  readonly label: string;
  readonly risk: Risk;
}

export interface ControlNode {
  readonly ref: Ref; // kind: 'control'
  readonly name: string;
  readonly label: string;
  readonly value: string | null;
}

export interface SurfaceNode {
  readonly ref: Ref; // kind: 'surface'
  readonly name: string;
  readonly text: string;
}

export interface PageSnapshot {
  readonly url: string;
  readonly objects: readonly ObjectNode[];
  readonly actions: readonly ActionNode[];
  readonly controls: readonly ControlNode[];
  readonly surfaces: readonly SurfaceNode[];
}
```

- [ ] **Step 2: 写失败测试 `test/contract/refs.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { RefMinter } from '../../src/contract/refs';

describe('RefMinter', () => {
  it('生成 kind:key 形式的 id', () => {
    const m = new RefMinter();
    const ref = m.mint('object', 'task:42');
    expect(ref).toEqual({ kind: 'object', id: 'object:task:42' });
  });

  it('同快照内重复 key 追加 #n 去重', () => {
    const m = new RefMinter();
    const a = m.mint('action', 'apply');
    const b = m.mint('action', 'apply');
    expect(a.id).toBe('action:apply');
    expect(b.id).toBe('action:apply#1');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run test/contract/refs.test.ts`
Expected: FAIL（找不到模块 `../../src/contract/refs`）。

- [ ] **Step 4: 写最小实现 `src/contract/refs.ts`**

```ts
import type { Ref, RefKind } from '../types';

/** 在单次快照解析内生成稳定且唯一的 ref id。 */
export class RefMinter {
  private readonly seen = new Map<string, number>();

  mint(kind: RefKind, key: string): Ref {
    const base = `${kind}:${key}`;
    const count = this.seen.get(base) ?? 0;
    this.seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}#${count}`;
    return { kind, id };
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/contract/refs.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无错误退出。

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/contract/refs.ts test/contract/refs.test.ts
git commit -m "feat(contract): 核心类型 + RefMinter（稳定唯一 ref）"
```

---

## Task 2：解析 objects

**Files:**
- Create: `src/contract/parseContract.ts`
- Test: `test/contract/parseContract.test.ts`

- [ ] **Step 1: 写失败测试 `test/contract/parseContract.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('parseContract — objects', () => {
  it('把 data-agent-object="type:id" 解析为 ObjectNode', () => {
    document.body.innerHTML = `
      <div data-agent-object="task:42">修复登录页</div>
      <div data-agent-object="task:43">  优化   首页  </div>
    `;
    const snap = parseContract(document.body, 'https://app.test/tasks');

    expect(snap.url).toBe('https://app.test/tasks');
    expect(snap.objects).toEqual([
      { ref: { kind: 'object', id: 'object:task:42' }, type: 'task', objectId: '42', label: '修复登录页' },
      { ref: { kind: 'object', id: 'object:task:43' }, type: 'task', objectId: '43', label: '优化 首页' },
    ]);
  });

  it('缺少 ":" 的对象声明被跳过', () => {
    document.body.innerHTML = `<div data-agent-object="broken">x</div>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.objects).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/contract/parseContract.test.ts`
Expected: FAIL（找不到 `parseContract`）。

- [ ] **Step 3: 写最小实现 `src/contract/parseContract.ts`**

```ts
import type { ObjectNode, PageSnapshot } from '../types';
import { RefMinter } from './refs';

function cleanText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

export function parseContract(root: ParentNode, url: string): PageSnapshot {
  const minter = new RefMinter();

  const objects: ObjectNode[] = [];
  for (const el of root.querySelectorAll('[data-agent-object]')) {
    const decl = el.getAttribute('data-agent-object') ?? '';
    const sep = decl.indexOf(':');
    if (sep <= 0 || sep === decl.length - 1) continue; // 需要 "type:id"
    const type = decl.slice(0, sep);
    const objectId = decl.slice(sep + 1);
    objects.push({
      ref: minter.mint('object', `${type}:${objectId}`),
      type,
      objectId,
      label: cleanText(el.textContent),
    });
  }

  return { url, objects, actions: [], controls: [], surfaces: [] };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/contract/parseContract.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/contract/parseContract.ts test/contract/parseContract.test.ts
git commit -m "feat(contract): 解析 data-agent-object 为 ObjectNode"
```

---

## Task 3：解析 actions（含 risk）

**Files:**
- Modify: `src/contract/parseContract.ts`
- Modify: `test/contract/parseContract.test.ts`

- [ ] **Step 1: 追加失败测试到 `test/contract/parseContract.test.ts`**

在文件末尾追加：

```ts
describe('parseContract — actions', () => {
  it('解析 action，默认 risk=low', () => {
    document.body.innerHTML = `<button data-agent-action="apply">申请</button>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.actions).toEqual([
      { ref: { kind: 'action', id: 'action:apply' }, name: 'apply', label: '申请', risk: 'low' },
    ]);
  });

  it('data-agent-risk="high" 标记高危动作', () => {
    document.body.innerHTML = `<button data-agent-action="redeem" data-agent-risk="high">兑换</button>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.actions[0]?.risk).toBe('high');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/contract/parseContract.test.ts`
Expected: FAIL（`actions` 为空数组，断言不符）。

- [ ] **Step 3: 在 `parseContract.ts` 中实现 actions 解析**

在 `import` 行追加 `ActionNode`、`Risk`：

```ts
import type { ActionNode, ObjectNode, PageSnapshot, Risk } from '../types';
```

在 objects 循环之后、`return` 之前插入：

```ts
  const actions: ActionNode[] = [];
  for (const el of root.querySelectorAll('[data-agent-action]')) {
    const name = el.getAttribute('data-agent-action') ?? '';
    if (!name) continue;
    const risk: Risk = el.getAttribute('data-agent-risk') === 'high' ? 'high' : 'low';
    actions.push({
      ref: minter.mint('action', name),
      name,
      label: cleanText(el.textContent),
      risk,
    });
  }
```

把 `return` 改为：

```ts
  return { url, objects, actions, controls: [], surfaces: [] };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/contract/parseContract.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/contract/parseContract.ts test/contract/parseContract.test.ts
git commit -m "feat(contract): 解析 data-agent-action（含 high-risk 标记）"
```

---

## Task 4：解析 controls + surfaces

**Files:**
- Modify: `src/contract/parseContract.ts`
- Modify: `test/contract/parseContract.test.ts`

- [ ] **Step 1: 追加失败测试到 `test/contract/parseContract.test.ts`**

在文件末尾追加：

```ts
describe('parseContract — controls', () => {
  it('input 控件读取 value', () => {
    document.body.innerHTML = `<input data-agent-control="bidAmount" value="200" />`;
    const snap = parseContract(document.body, 'u');
    expect(snap.controls).toEqual([
      { ref: { kind: 'control', id: 'control:bidAmount' }, name: 'bidAmount', label: '', value: '200' },
    ]);
  });

  it('非表单元素控件 value 为 null，label 取文本', () => {
    document.body.innerHTML = `<div data-agent-control="priority">高</div>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.controls[0]).toEqual({
      ref: { kind: 'control', id: 'control:priority' },
      name: 'priority',
      label: '高',
      value: null,
    });
  });
});

describe('parseContract — surfaces', () => {
  it('surface 读取可读文本', () => {
    document.body.innerHTML = `<section data-agent-surface="detail"> 任务  详情 </section>`;
    const snap = parseContract(document.body, 'u');
    expect(snap.surfaces).toEqual([
      { ref: { kind: 'surface', id: 'surface:detail' }, name: 'detail', text: '任务 详情' },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/contract/parseContract.test.ts`
Expected: FAIL（`controls`/`surfaces` 为空）。

- [ ] **Step 3: 在 `parseContract.ts` 中实现 controls + surfaces**

把 import 行改为：

```ts
import type {
  ActionNode,
  ControlNode,
  ObjectNode,
  PageSnapshot,
  Risk,
  SurfaceNode,
} from '../types';
```

在 actions 循环之后、`return` 之前插入：

```ts
  const controls: ControlNode[] = [];
  for (const el of root.querySelectorAll('[data-agent-control]')) {
    const name = el.getAttribute('data-agent-control') ?? '';
    if (!name) continue;
    const hasValue = 'value' in el;
    const value = hasValue ? String((el as { value: unknown }).value) : null;
    controls.push({
      ref: minter.mint('control', name),
      name,
      label: hasValue ? cleanText(el.getAttribute('aria-label')) : cleanText(el.textContent),
      value,
    });
  }

  const surfaces: SurfaceNode[] = [];
  for (const el of root.querySelectorAll('[data-agent-surface]')) {
    const name = el.getAttribute('data-agent-surface') ?? '';
    if (!name) continue;
    surfaces.push({
      ref: minter.mint('surface', name),
      name,
      text: cleanText(el.textContent),
    });
  }
```

把 `return` 改为：

```ts
  return { url, objects, actions, controls, surfaces };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/contract/parseContract.test.ts`
Expected: PASS（7 passed）。

注：input 控件 `label` 取 `aria-label`（无则空串），因为表单元素的 `textContent` 通常为空。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/contract/parseContract.ts test/contract/parseContract.test.ts
git commit -m "feat(contract): 解析 data-agent-control 与 data-agent-surface"
```

---

## Task 5：domHostAdapter.snapshot() + 公共入口

**Files:**
- Create: `src/adapters/domHostAdapter.ts`
- Create: `src/index.ts`
- Test: `test/adapters/domHostAdapter.test.ts`

- [ ] **Step 1: 写失败测试 `test/adapters/domHostAdapter.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('domHostAdapter.snapshot', () => {
  it('对 document.body 解析契约，url 取自 location', () => {
    document.body.innerHTML = `<div data-agent-object="task:7">写测试</div>`;
    const adapter = createDomHostAdapter();
    const snap = adapter.snapshot();

    expect(snap.objects).toHaveLength(1);
    expect(snap.objects[0]?.objectId).toBe('7');
    expect(typeof snap.url).toBe('string');
  });

  it('可传入自定义 root', () => {
    document.body.innerHTML = `
      <div id="scope"><button data-agent-action="apply">a</button></div>
      <button data-agent-action="other">b</button>
    `;
    const scope = document.getElementById('scope')!;
    const adapter = createDomHostAdapter({ root: scope });
    const snap = adapter.snapshot();

    expect(snap.actions.map((a) => a.name)).toEqual(['apply']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/adapters/domHostAdapter.test.ts`
Expected: FAIL（找不到 `createDomHostAdapter`）。

- [ ] **Step 3: 写最小实现 `src/adapters/domHostAdapter.ts`**

```ts
import type { PageSnapshot } from '../types';
import { parseContract } from '../contract/parseContract';

export interface DomHostAdapterOptions {
  /** 解析根，默认 document.body */
  root?: ParentNode;
  /** url 提供器，默认 location.href */
  getUrl?: () => string;
}

export interface HostAdapter {
  snapshot(): PageSnapshot;
}

export function createDomHostAdapter(options: DomHostAdapterOptions = {}): HostAdapter {
  const getUrl = options.getUrl ?? (() => location.href);
  return {
    snapshot(): PageSnapshot {
      const root = options.root ?? document.body;
      return parseContract(root, getUrl());
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/adapters/domHostAdapter.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 5: 写公共入口 `src/index.ts`**

```ts
export type {
  Ref,
  RefKind,
  Risk,
  ObjectNode,
  ActionNode,
  ControlNode,
  SurfaceNode,
  PageSnapshot,
} from './types';
export { parseContract } from './contract/parseContract';
export { RefMinter } from './contract/refs';
export { createDomHostAdapter } from './adapters/domHostAdapter';
export type { HostAdapter, DomHostAdapterOptions } from './adapters/domHostAdapter';
```

- [ ] **Step 6: 全量测试 + 类型检查 + 构建**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部 PASS；`dist/` 生成 `index.js` + `index.d.ts`，无 TS 错误。

- [ ] **Step 7: Commit**

```bash
git add src/adapters/domHostAdapter.ts src/index.ts test/adapters/domHostAdapter.test.ts
git commit -m "feat(adapters): domHostAdapter.snapshot + 公共入口导出"
```

---

## 切片 1 验收

- [ ] `npm test` 全绿（smoke + refs + parseContract + domHostAdapter）。
- [ ] `npm run typecheck` 0 错误。
- [ ] `npm run build` 产出 `dist/index.d.ts`，公共 API 类型完整。
- [ ] 手动确认：一段含全部四类 `data-agent-*` 属性的 HTML，经 `parseContract` 后产出结构正确、ref 唯一的 `PageSnapshot`。

---

## 剩余切片路线图（各自单独立计划）

> 不在本计划展开。每个切片需先 spec 已覆盖、再写自己的 bite-sized 计划；planRunner 切片**先 brainstorm**。

- **切片 2 — 读循环 + LLM 适配 + refResolver**：`llmAdapter`（OpenAI tool-calling）、单 tool-calling 循环的读路径（`observePage`/`readSurface`/`openObject`/`navigate`/`finish`）、`refResolver` 校验 ref（非法即 error）。验收必须跑真实 LLM 回合，断言 `plannerSource=llm`、无 fallback。
- **切片 3 — 诚实层 + 写动作 + held**：`verifier`、`ledger`（Evidence Ledger）、`narrationGuard`、`riskPolicy`；接入 `setControl`/`invokeAction`，高危 held。
- **切片 4 — 长程自主（planRunner）+ 跨回合引用 + 示范应用**：**先 brainstorm**。`candidateSet`/`planRunner`、"换一个/就它"引用解析、极小非 SkillFlow 示范应用、真实 LLM 多步任务验收 + Ledger 对账。

---

## 自审记录

- **Spec 覆盖**：本切片对应 spec §2.1（contract 层）、§4（data-agent-* 微协议）、§8（domHostAdapter.snapshot）、§10（仓库结构 src/contract、src/adapters）。其余 spec 章节（循环/诚实/planRunner/llm）明确划入切片 2-4。
- **占位扫描**：无 TBD/TODO；每个代码步骤含完整代码。
- **类型一致性**：`Ref`/`*Node`/`PageSnapshot` 在 `types.ts` 定义后，parseContract、refs、domHostAdapter、index 引用一致；`RefMinter.mint(kind,key)` 签名全程一致；`parseContract(root,url)` 签名全程一致；`createDomHostAdapter(options)` 与测试一致。
