# 切片19 实施计划：trace.jsonl 产品化 + nav 类型归因

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 堵住 CRM Hard 诊断发现的 `computeOutcome` 真实漏洞（全部是导航类的 verified 写也判 completed），同时把 `AgentStep` 序列产品化成稳定的 `trace.jsonl` 结构。

**Architecture:** 给 `ActionNode` 加 `category?: 'nav'`（两处契约推断——AXTree 与 DOM——各自打标）；写路径把这个标签带进账本的 `write` 条目（`navLike`）；`computeOutcome` 用它加一条"全部 verified 写都是导航 → 不判 completed"的规则，和既有的 `lastDoubt` 恢复机制同形。`trace.jsonl` 是对已有 `AgentStep[]` 序列的纯序列化包装，不新建数据模型。

**Tech Stack:** TypeScript, Vitest。不涉及新依赖。

---

## 前置说明

- 设计文档：`docs/specs/2026-07-04-attest-slice19-trace-and-nav-outcome-design.md`（已用户批准）。
- 本计划涉及的所有真实 SuiteCRM AXTree 断言已在写计划前用 Node 脚本对夹具逐个验证过（不是猜的）：
  - `test/fixtures/real/ax-suitecrm-235.json` 里 `Accounts`/`Contacts`/`Leads` 链接的祖先链确实包含 `role=navigation`（节点102）。
  - `test/fixtures/real/ax-suitecrm-editform.json` 里 `Save` 按钮的祖先链**不**包含 `navigation`/`menubar`/`tablist`。
  - `test/fixtures/real/ax-suitecrm-tab-moreinfo.json` 里存在 `role=tab` 节点（`OVERVIEW`/`MORE INFORMATION`/`OTHER`）。
  - `test/fixtures/real/ax-suitecrm-nav-more-open.json` 里 `Tasks` 链接（More 菜单展开项）的祖先链也包含 `role=navigation`（节点98）——这是正确的，因为它仍是模块切换。
- 现有测试文件用的都是 predicate 风格断言（`.some()`/`.find()`），没有对 write/action 条目做过精确对象相等断言——新增可选字段不会破坏现有测试。

---

### Task 1: `ActionNode.category` + `inferFromAxTree.ts` 打标 + 测试

**Files:**
- Modify: `src/types.ts`
- Modify: `src/contract/inferFromAxTree.ts`
- Test: `test/contract/inferFromAxTree.test.ts`

- [ ] **Step 1: 给 `ActionNode` 加 `category` 字段**

在 `src/types.ts` 里找到 `ActionNode` 接口（第30-38行），加一行：

```ts
export interface ActionNode {
  readonly ref: Ref; // kind: 'action'
  readonly name: string; // 如 "apply"
  readonly label: string;
  readonly risk: Risk;
  readonly provenance?: Provenance;
  /** 语义分类：'nav' = 导航/切视图类动作（模块链接、tab），不代表任务真正要求的变更。 */
  readonly category?: 'nav';
  /** 可选：调用时需要的参数（VOIX 带参 tool）。无参动作省略。 */
  readonly params?: readonly ParamSpec[];
}
```

- [ ] **Step 2: 写失败的合成测试（先写测试，此时应该失败）**

在 `test/contract/inferFromAxTree.test.ts` 末尾、`});`（第268行）之前加两个 `it`：

```ts
  it('role=tab 一律打上 category:nav', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2'] }),
      N('2', 'tab', 'OVERVIEW', { browsergym_id: 't1' }),
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions[0]?.category).toBe('nav');
  });

  it('link 身处 role=navigation 地标内 → category:nav；地标外的同类 link 不受影响', () => {
    const nodes: AxNode[] = [
      N('1', 'RootWebArea', '', { childIds: ['2', '5'] }),
      N('2', 'navigation', '', { childIds: ['3'] }),
      N('3', 'link', 'Accounts', { browsergym_id: 'n1' }),
      N('5', 'link', '保存', { browsergym_id: 'n2' }),
    ];
    const { snapshot } = inferFromAxTree(nodes, '/p');
    expect(snapshot.actions.find((a) => a.label === 'Accounts')?.category).toBe('nav');
    expect(snapshot.actions.find((a) => a.label === '保存')?.category).toBeUndefined();
  });

  it('真实 AXTree：模块导航（Accounts/Contacts/Leads）打上 category:nav', async () => {
    const { readFileSync } = await import('node:fs');
    const nodes = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-235.json', 'utf8')) as AxNode[];
    const { snapshot } = inferFromAxTree(nodes, 'http://localhost:8080/');
    for (const want of ['Accounts', 'Contacts', 'Leads']) {
      expect(snapshot.actions.find((a) => a.label === want)?.category).toBe('nav');
    }
  });

  it('真实夹具：MORE INFORMATION 等 tab 页签打上 category:nav', async () => {
    const { readFileSync } = await import('node:fs');
    const obs = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-tab-moreinfo.json', 'utf8'));
    const nodes = (obs.axtree_object?.nodes ?? obs.axtree_object) as AxNode[];
    const { snapshot } = inferFromAxTree(nodes, obs.url as string);
    expect(snapshot.actions.find((a) => a.label === 'OVERVIEW')?.category).toBe('nav');
  });

  it('真实夹具：Save 按钮不在导航地标内，不打 category', async () => {
    const { readFileSync } = await import('node:fs');
    const obs = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-editform.json', 'utf8'));
    const nodes = (obs.axtree_object?.nodes ?? obs.axtree_object) as AxNode[];
    const { snapshot } = inferFromAxTree(nodes, obs.url);
    expect(snapshot.actions.find((a) => a.label === 'Save')?.category).toBeUndefined();
  });

  it('真实夹具：More 菜单展开后的 Tasks（仍是模块切换）打上 category:nav', async () => {
    const { readFileSync } = await import('node:fs');
    const obs = JSON.parse(readFileSync('test/fixtures/real/ax-suitecrm-nav-more-open.json', 'utf8'));
    const nodes = (obs.axtree_object?.nodes ?? obs.axtree_object) as AxNode[];
    const { snapshot } = inferFromAxTree(nodes, obs.url as string);
    expect(snapshot.actions.find((a) => a.label === 'Tasks')?.category).toBe('nav');
  });
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run test/contract/inferFromAxTree.test.ts`
Expected: 新增的几个用例 FAIL（`category` 目前恒为 `undefined`，`toBe('nav')` 断言不通过）。

- [ ] **Step 4: 实现打标逻辑**

在 `src/contract/inferFromAxTree.ts` 里，`OBJECT_ROLES`/`SURFACE_ROLES` 声明附近（第27-28行后）加一个新常量：

```ts
const NAV_ROLES = new Set(['navigation', 'menubar', 'tablist']);
```

然后把 `visit` 函数（第93-183行）整体替换为：

```ts
  const visit = (n: AxNode | undefined, insideNav = false): void => {
    if (!n || isPruned(n)) return; // hidden 整棵剪掉
    visitIdx += 1;
    const role = clean(n.role?.value);
    const nowInsideNav = insideNav || NAV_ROLES.has(role);
    if (n.ignored) {
      // CDP ignored：本节点不入树但子树照常——只下钻，不参与分类
      for (const cid of n.childIds ?? []) visit(byId.get(cid), nowInsideNav);
      return;
    }
    const name = clean(n.name?.value);
    if (role === 'StaticText' && name && name.length <= 40 && looksLikeLabel(name)) lastText = { text: name, at: visitIdx };

    if (ACTION_ROLES.has(role) && n.browsergym_id) {
      const label = clip(name || textOf(n, byId));
      if (label && !seenAction.has(label)) {
        seenAction.add(label);
        const risk: Risk = HIGH_RISK.test(label) ? 'high' : 'low';
        const ref = minter.mint('action', label);
        // nav 归因：role=tab 一律视为导航；否则看是否身处导航地标（navigation/menubar/tablist）内。
        const category: 'nav' | undefined = role === 'tab' || nowInsideNav ? 'nav' : undefined;
        actions.push({ ref, name: label, label, risk, provenance: 'inferred', category });
        bids.set(ref.id, n.browsergym_id);
      }
    } else if (CONTROL_ROLES.has(role) && n.browsergym_id) {
      const nearby = lastText !== null && visitIdx - (lastText as { at: number }).at <= NEARBY ? (lastText as { text: string }).text : '';
      const label = clip(name || nearby || role);
      const ref = minter.mint('control', label);
      controls.push({
        ref,
        name: label,
        label,
        value: n.value?.value === undefined ? null : clean(n.value.value),
        provenance: 'inferred',
      });
      bids.set(ref.id, n.browsergym_id);
    } else if (OBJECT_ROLES.has(role)) {
      const raw = textOf(n, byId);
      const label = clip(raw);
      if (label) {
        // 导航 li：内容恰为单个链接（文本一致）——是"可去的地方"不是"数据行"，
        // 推断为 action 才能让模型导航（SuiteCRM 模块菜单实测就是这个形状）。
        const links = interactiveDescendants(n, byId);
        const first = links[0];
        if (links.length === 1 && first && norm(textOf(first, byId)) === norm(label)) {
          if (!seenAction.has(label)) {
            seenAction.add(label);
            const ref = minter.mint('action', label);
            const category: 'nav' | undefined = clean(first.role?.value) === 'tab' || nowInsideNav ? 'nav' : undefined;
            actions.push({ ref, name: label, label, risk: HIGH_RISK.test(label) ? 'high' : 'low', provenance: 'inferred', category });
            bids.set(ref.id, first.browsergym_id!);
          }
          return;
        }
        // 链接组 li：内容全为可交互项（多个链接拼起来=全部文本，无数据性文字）——
        // 是展开的菜单/导航组不是数据行。吞成对象会藏掉全部菜单项，且对象主链接=组名
        // （如 More），点了反把菜单关上（真实 More 菜单实测）。下钻让每项自成 action。
        if (links.length >= 2 && norm(links.map((l) => textOf(l, byId)).join(' ')) === norm(raw)) {
          for (const cid of n.childIds ?? []) visit(byId.get(cid), nowInsideNav);
          return;
        }
        oi += 1;
        const ref = minter.mint('object', `item:${oi}`);
        objects.push({ ref, type: 'item', objectId: String(oi), label, provenance: 'inferred' });
        // 点击句柄优先绑"主链接"（文本为行 label 前缀的第一个链接=名字链接）：
        // 列表行中央布满内联动作（Log Call…），点行本身等于乱点；点名字链接才进详情。
        const primary = links.find((l) => norm(label).startsWith(norm(textOf(l, byId))) && textOf(l, byId));
        const handle = primary?.browsergym_id ?? n.browsergym_id;
        if (handle) bids.set(ref.id, handle);
        return; // 对象吞掉后代（行内文本已并入 label；行内按钮通常也有独立 bid，需要时再放开）
      }
    } else if (SURFACE_ROLES.has(role) || role === 'tabpanel') {
      const label = clip(name || role);
      const ref = minter.mint('surface', label);
      // tabpanel 的 name 是页签标题，内容在后代——聚合后代文本（真实面板嵌套深，
      // 深度放宽到 14）；status/alert 的 name 即内容。
      const text =
        role === 'tabpanel'
          ? (n.childIds ?? [])
              .map((cid) => {
                const child = byId.get(cid);
                return child ? textOf(child, byId, 14) : '';
              })
              .filter(Boolean)
              .join(' ')
          : textOf(n, byId);
      surfaces.push({ ref, name: label, text, provenance: 'inferred' });
      if (n.browsergym_id) bids.set(ref.id, n.browsergym_id);
      // tabpanel 是"内容区域"不是叶子告示：面板里还有控件/动作（编辑态表单就在里面），
      // 吞掉后代会让整个面板不可操作——surface 供读取，后代照常分类。
      if (role !== 'tabpanel') return;
    }

    for (const cid of n.childIds ?? []) visit(byId.get(cid), nowInsideNav);
  };

  for (const r of roots) visit(r, false);
```

（唯一实质变化：`visit` 加了 `insideNav` 参数、新增 `nowInsideNav` 计算、两处 `actions.push` 加了 `category` 字段、所有递归调用传 `nowInsideNav`。其余逻辑原样保留。）

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run test/contract/inferFromAxTree.test.ts`
Expected: 全部 PASS（含之前已有的用例——确认没有回归）。

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/contract/inferFromAxTree.ts test/contract/inferFromAxTree.test.ts
git commit -m "feat(contract): ActionNode 加 category:nav——AXTree 推断打标模块导航/tab

role=tab 一律视为导航；link/menuitem/button 身处 navigation/menubar/tablist
地标内也视为导航。真实 SuiteCRM 夹具验证：Accounts/Contacts/Leads 模块链接、
More 菜单展开项、OVERVIEW 等 tab 均正确打标；Save 按钮（不在导航地标内）不受影响。
为后续 computeOutcome 的 per-object 归因铺路。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `inferContract.ts`（DOM 路径）打标 + 测试

**Files:**
- Modify: `src/contract/inferContract.ts`
- Test: `test/contract/inferHardening.test.ts`

- [ ] **Step 1: 写失败的合成测试**

在 `test/contract/inferHardening.test.ts` 的"合成小例"`describe` 块内（第8-54行），`});` 之前加两个 `it`：

```ts
  it('<nav> 里的链接打上 category:nav；<nav> 外的按钮不受影响', () => {
    document.body.innerHTML = '<nav><a href="/accounts">Accounts</a></nav><button>Save</button>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.actions.find((a) => a.label === 'Accounts')?.category).toBe('nav');
    expect(snapshot.actions.find((a) => a.label === 'Save')?.category).toBeUndefined();
  });

  it('role=tab 元素被识别为 action 且打上 category:nav', () => {
    document.body.innerHTML = '<div role="tab">Overview</div>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.actions[0]?.label).toBe('Overview');
    expect(snapshot.actions[0]?.category).toBe('nav');
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/contract/inferHardening.test.ts`
Expected: 两个新用例 FAIL（第二个会连 `snapshot.actions[0]` 都找不到，因为 `role="tab"` 目前根本不在动作选择器里）。

- [ ] **Step 3: 实现打标逻辑**

在 `src/contract/inferContract.ts` 里，把第69-80行的动作识别循环替换为：

```ts
  // 动作：按钮 / role=button / submit / 链接 / role=tab。同标签去重只留第一个。
  // nav 归因：role=tab，或身处 <nav>/[role=navigation|menubar|tablist] 地标内 → category:'nav'
  // （和上面"nav/footer 里的 li 不当数据对象"同一条真实前提：导航地标里的东西是切视图，不是变更）。
  const seenAction = new Set<string>();
  for (const el of queryAllDeep(
    root,
    'button, [role="button"], input[type="submit"], input[type="button"], a[href], [role="tab"]',
    scopes,
  )) {
    if (isHidden(el)) continue;
    const label = clip(clean(el.textContent) || clean(el.getAttribute('aria-label')) || clean((el as HTMLInputElement).value));
    if (!label || seenAction.has(label)) continue;
    seenAction.add(label);
    const risk: Risk = HIGH_RISK.test(label) ? 'high' : 'low';
    const ref = minter.mint('action', label);
    const isNavLandmark = el.closest('nav, [role="navigation"], [role="menubar"], [role="tablist"]') !== null;
    const category: 'nav' | undefined = el.getAttribute('role') === 'tab' || isNavLandmark ? 'nav' : undefined;
    actions.push({ ref, name: label, label, risk, provenance: 'inferred', category });
    elements.set(ref.id, el);
  }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/contract/inferHardening.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/contract/inferContract.ts test/contract/inferHardening.test.ts
git commit -m "feat(contract): inferContract（DOM路径）同步打标 category:nav

<nav>/[role=navigation|menubar|tablist] 内的按钮/链接、role=tab 元素 → category:'nav'。
顺带把 role=tab 加入动作选择器（此前 DOM 推断完全不识别 ARIA tab 为可点动作）。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `LedgerEntry.write.navLike` + `execWrite.ts` 穿线 + 测试

**Files:**
- Modify: `src/honesty/types.ts`
- Modify: `src/core/execWrite.ts`
- Test: `test/core/execWrite.test.ts`

- [ ] **Step 1: 加字段**

在 `src/honesty/types.ts` 的 `LedgerEntry` 联合类型（第14-20行）里，把 `write` 变体改为：

```ts
  | { kind: 'write'; tool: string; refId: string; verified: boolean; evidence: string[]; navLike?: boolean }
```

- [ ] **Step 2: 写失败的测试**

在 `test/core/execWrite.test.ts` 里加 import（文件顶部第1-8行附近，紧跟已有的 `inferContract` import 之后不需要新增 import，因为 `inferContract` 已经导入了；只需确认 `Ledger`/`FakeHostAdapter`/`executeWrite` 已导入，均已存在），然后在 `describe('executeWrite', ...)` 块内加一个新 `it`（放在文件任意已有 `it` 之后即可，比如紧跟第35行之后）：

```ts
  it('nav 类型动作（<nav> 里的链接）执行后，账本记 navLike:true；普通动作不设', async () => {
    document.body.innerHTML = '<nav><a href="/accounts">Accounts</a></nav><button>Save</button>';
    const before = inferContract(document.body, '/p').snapshot;
    document.body.innerHTML = '<p>已跳转</p>';
    const after = inferContract(document.body, '/p2').snapshot;
    const navRef = before.actions.find((a) => a.label === 'Accounts')!.ref.id;
    const saveRef = before.actions.find((a) => a.label === 'Save')!.ref.id;

    const host1 = new FakeHostAdapter(before, { [navRef]: after });
    const ledger1 = new Ledger();
    await executeWrite(host1, ledger1, APPROVE_ONCE, new Set(), { tool: 'invokeAction', refId: navRef });
    const navEntry = ledger1.entries.find((e) => e.kind === 'write') as { navLike?: boolean } | undefined;
    expect(navEntry?.navLike).toBe(true);

    const host2 = new FakeHostAdapter(before, { [saveRef]: after });
    const ledger2 = new Ledger();
    await executeWrite(host2, ledger2, APPROVE_ONCE, new Set(), { tool: 'invokeAction', refId: saveRef });
    const saveEntry = ledger2.entries.find((e) => e.kind === 'write') as { navLike?: boolean } | undefined;
    expect(saveEntry?.navLike).toBeFalsy();
  });
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run test/core/execWrite.test.ts`
Expected: 新用例 FAIL（`navEntry?.navLike` 目前恒为 `undefined`，`toBe(true)` 不通过）。

- [ ] **Step 4: 实现穿线**

在 `src/core/execWrite.ts` 第8行，把 import 改为：

```ts
import type { Ref, RefKind, ActionNode } from '../types';
```

在第63-68行（`targetNode`/`highRisk`/`inferred` 声明处）之后加一行：

```ts
  const targetNode =
    req.tool === 'setControl'
      ? before.controls.find((c) => c.ref.id === req.refId)
      : before.actions.find((a) => a.ref.id === req.refId);
  const highRisk = req.tool === 'invokeAction' && isHighRisk(before, req.refId);
  const inferred = targetNode?.provenance === 'inferred';
  // nav 归因：只有 invokeAction 会作用在 ActionNode 上；ControlNode 没有 category 概念，
  // setControl 写永远 navLike=false（搜索框填值等，本轮不判定是否任务相关）。
  const navLike = req.tool === 'invokeAction' && (targetNode as ActionNode | undefined)?.category === 'nav';
```

在第153行（`ledger.record({ kind: 'write', ... })`），改为：

```ts
  ledger.record({ kind: 'write', tool: req.tool, refId: req.refId, verified: evidence.changed, evidence: evidence.details, navLike });
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run test/core/execWrite.test.ts`
Expected: 全部 PASS（含已有用例，无回归）。

- [ ] **Step 6: 提交**

```bash
git add src/honesty/types.ts src/core/execWrite.ts test/core/execWrite.test.ts
git commit -m "feat(honesty): 写路径穿线 navLike——账本记录这次写是否只是导航

execWrite 记账时，从已解析的 targetNode.category 判断这次 invokeAction 是否
命中 nav 类型对象，写进 LedgerEntry.write.navLike。setControl 永远 navLike:false
（不在本轮判定范围）。为 computeOutcome 的下一步规则铺路。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `computeOutcome` 新规则 + 测试

**Files:**
- Modify: `src/honesty/ledger.ts`
- Test: `test/honesty/ledger.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `test/honesty/ledger.test.ts` 里，`describe('computeOutcome', ...)` 块内、"高危被拒且无成功写 → cancelled"这条用例（当前在文件里紧跟三个 clarify 相关用例之后）之前加两个用例：

```ts
  it('verified 写全部是导航类（navLike）→ failed，不算 completed', () => {
    expect(
      computeOutcome([
        { kind: 'write', tool: 'invokeAction', refId: 'action:accounts', verified: true, evidence: ['url: /a → /accounts'], navLike: true },
      ]),
    ).toBe('failed');
  });

  it('verified 写里混了一次非导航的写（哪怕在导航写之前）→ completed，不受影响', () => {
    expect(
      computeOutcome([
        { kind: 'write', tool: 'invokeAction', refId: 'action:delete', verified: true, evidence: ['object:lead:5 gone'], navLike: false },
        { kind: 'write', tool: 'invokeAction', refId: 'action:accounts', verified: true, evidence: ['url: /a → /accounts'], navLike: true },
      ]),
    ).toBe('completed');
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/honesty/ledger.test.ts`
Expected: 第一个新用例 FAIL（当前逻辑没有 navLike 相关规则，`writes.some(w=>w.verified)` 为真且无 doubt 信号，直接落到 `return 'completed'`，与期望的 `'failed'` 不符）。第二个用例本来就应该 PASS（先确认它现在也确实是 PASS，作为"不误伤"的基线）。

- [ ] **Step 3: 实现新规则**

把 `src/honesty/ledger.ts` 的 `computeOutcome` 函数（第19-42行）替换为：

```ts
export function computeOutcome(entries: readonly LedgerEntry[]): Outcome {
  const writes = entries.filter(
    (e): e is Extract<LedgerEntry, { kind: 'write' }> => e.kind === 'write',
  );
  const deniedGrant = entries.some((e) => e.kind === 'grant' && !e.approved);

  // 未验证的写、出错的写、以及提问后未获回复的 askUser，都是"终态不明"信号，
  // 同一条恢复规则（与 slice14 的 error 恢复同形）：其后有验证成功的写=已恢复，
  // 不因一次无效果的探索/悬而未决的提问把随后全部验证过的工作拍成 failed；
  // 反之收尾停在不明状态就不许 completed（堵"提问后没等回复就径直 finish=completed"
  // 的空账本谎报——askUser 本身不写、不进 verify-or-refuse，但悬而未决不能被空账本
  // 默认规则蒙混成"没什么好做的直接完成"）。读 error 不拖垮。
  let lastDoubt = -1;
  entries.forEach((e, i) => {
    if (e.kind === 'write' && !e.verified) lastDoubt = i;
    if (e.kind === 'error' && (e.tool === 'setControl' || e.tool === 'invokeAction')) lastDoubt = i;
    if (e.kind === 'clarify' && !e.answered) lastDoubt = i;
  });
  if (lastDoubt >= 0 && !entries.slice(lastDoubt + 1).some((e) => e.kind === 'write' && e.verified)) {
    return 'failed';
  }

  // 有 verified 写，但清一色是导航类（navLike）——只是"去了个地方"，任务真正要求的
  // 变更从未发生。和上面的 doubt 信号同一套宽容：只要序列里任意一次 verified 写不是
  // 导航类，这条就不成立（不追究先后顺序）。完全不碰"空账本→completed"的既有默认
  // （writes.length===0 时 hasVerified 为 false，这条规则天然不生效）。
  const hasVerified = writes.some((w) => w.verified);
  const hasSubstantiveVerified = writes.some((w) => w.verified && !w.navLike);
  if (hasVerified && !hasSubstantiveVerified) {
    return 'failed';
  }

  if (deniedGrant && !writes.some((w) => w.verified)) return 'cancelled';
  return 'completed';
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/honesty/ledger.test.ts`
Expected: 全部 PASS（含此前已有的全部用例——特别确认"无写动作 → completed"和"写动作已验证 → completed"这两条既有用例仍然 PASS，证明空账本默认和"没打 navLike 就当非导航"的行为没被破坏）。

- [ ] **Step 5: 提交**

```bash
git add src/honesty/ledger.ts test/honesty/ledger.test.ts
git commit -m "fix(honesty): 全部 verified 写都是导航类时不判 completed

CRM Hard 复查抓到的漏洞：模型点导航链接（held→确认→verified 的 invokeAction）
后直接 finish，账本里'有一次 verified 写'就被判 completed，但任务真正要求的
动作（删除/关联等）从未执行。新规则与既有 lastDoubt 恢复机制同形：账本里出现
过一次非导航的 verified 写就不受影响；不碰空账本→completed 的既有默认。

已知覆盖边界：只堵住'点导航/tab 链接后直接 finish'的模式，不处理'搜索+打开
记录后停下'这类既非导航打标、也非任务实质写的情况——见设计文档。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `AgentStep.action` 加 `args` + `execWrite.ts` 穿线 + 测试

**Files:**
- Modify: `src/core/loopTypes.ts`
- Modify: `src/core/execWrite.ts`
- Test: `test/core/execWrite.test.ts`

- [ ] **Step 1: 加字段**

在 `src/core/loopTypes.ts` 第10行，把 `action` 变体改为：

```ts
  | { type: 'action'; tool: string; refId: string; verified: boolean; evidence: string[]; args?: Record<string, unknown> }
```

- [ ] **Step 2: 写失败的测试**

在 `test/core/execWrite.test.ts` 里加一个新 `it`（放在 Task 3 新加的用例之后）：

```ts
  it('AgentStep 的 action 步骤带上调用参数（setControl 是填的值，invokeAction 是 args）', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const after = makeSnap(`<input data-agent-control="qty" value="5"/>`);
    const host = new FakeHostAdapter(before, { 'control:qty': after });
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '5',
    });
    const step = r.steps.find((s) => s.type === 'action') as { args?: Record<string, unknown> } | undefined;
    expect(step?.args).toEqual({ value: '5' });
  });
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run test/core/execWrite.test.ts`
Expected: 新用例 FAIL（`step?.args` 目前是 `undefined`）。

- [ ] **Step 4: 实现穿线**

在 `src/core/execWrite.ts` 第153-154行（`ledger.record`/`steps.push` 那两行），改为：

```ts
  const callArgs: Record<string, unknown> | undefined = req.tool === 'setControl' ? { value: req.value } : req.args;
  ledger.record({ kind: 'write', tool: req.tool, refId: req.refId, verified: evidence.changed, evidence: evidence.details, navLike });
  steps.push({ type: 'action', tool: req.tool, refId: req.refId, verified: evidence.changed, evidence: evidence.details, args: callArgs });
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run test/core/execWrite.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/core/loopTypes.ts src/core/execWrite.ts test/core/execWrite.test.ts
git commit -m "feat(core): AgentStep 的 action 步骤带上调用参数（args）

setControl 记实际填的 value，invokeAction 记 VOIX 带参调用的 args——为下一步
trace.jsonl 序列化提供完整的调用记录，不用回头翻 evidence 字符串猜参数。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `src/core/trace.ts`（trace.jsonl 序列化）+ 测试

**Files:**
- Create: `src/core/trace.ts`
- Test: `test/core/trace.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `test/core/trace.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { serializeTrace } from '../../src/core/trace';
import type { AgentStep } from '../../src/core/loopTypes';

describe('serializeTrace', () => {
  it('给每个 step 加序号和时间戳，顺序不变，finish 事件（含 facts）也照常序列化', () => {
    const steps: AgentStep[] = [
      { type: 'observation', tool: 'observePage', result: 'x' },
      { type: 'action', tool: 'invokeAction', refId: 'action:a', verified: true, evidence: ['c'] },
      {
        type: 'finish',
        facts: {
          outcome: 'completed',
          verified: [],
          unverified: [],
          cancelled: [],
          writeErrors: [],
          clarifications: [],
          summary: '仅读取了页面，未执行写操作',
        },
        narration: 'done',
        answer: 'done',
        outcome: 'completed',
        ledger: [],
      },
    ];
    let calls = 0;
    const now = () => `t${calls++}`;
    const trace = serializeTrace(steps, now);
    expect(trace).toHaveLength(3);
    expect(trace.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(trace.map((t) => t.ts)).toEqual(['t0', 't1', 't2']);
    expect(trace[2]!.step.type).toBe('finish');
  });

  it('args 字段随 action step 一起序列化（execWrite 传入的调用参数）', () => {
    const steps: AgentStep[] = [
      { type: 'action', tool: 'setControl', refId: 'control:name', verified: true, evidence: ['c'], args: { value: '张三' } },
    ];
    const trace = serializeTrace(steps, () => 't');
    const step = trace[0]!.step as { args?: unknown };
    expect(step.args).toEqual({ value: '张三' });
  });

  it('不传 now 时用真实系统时间（默认参数可用，不炸）', () => {
    const steps: AgentStep[] = [{ type: 'observation', tool: 'observePage', result: 'x' }];
    const trace = serializeTrace(steps);
    expect(trace[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 格式
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/core/trace.test.ts`
Expected: FAIL with "Cannot find module '../../src/core/trace'"。

- [ ] **Step 3: 实现 `serializeTrace`**

创建 `src/core/trace.ts`：

```ts
import type { AgentStep } from './loopTypes';

export interface TraceEvent {
  seq: number;
  ts: string;
  step: AgentStep;
}

/**
 * 把一次任务运行的 AgentStep 序列序列化成稳定的逐行事件格式（trace.jsonl 的内核侧产出）。
 * 内核只序列化、不做 I/O——落盘/上传是宿主的事（沿用切片9 WorldModel 持久化的先例）。
 * now 可注入固定时钟，方便测试；默认取系统时间。
 */
export function serializeTrace(
  steps: readonly AgentStep[],
  now: () => string = () => new Date().toISOString(),
): TraceEvent[] {
  return steps.map((step, seq) => ({ seq, ts: now(), step }));
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/core/trace.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/trace.ts test/core/trace.test.ts
git commit -m "feat(core): trace.jsonl 序列化——serializeTrace 把 AgentStep 序列变成稳定导出格式

不新建数据模型，只是给已有的 AgentStep[] 加序号+时间戳。内核只返回可序列化
数组，落盘/消费是宿主的事（同切片9 WorldModel 持久化先例）。now 可注入固定
时钟，测试不依赖系统时间。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: 全量回归 + 真模型抽样复验 + 文档收尾

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 全量确定性测试 + typecheck**

```bash
npm test
npm run typecheck
```

Expected: 两条都绿。测试数应该比 slice19 开始前多至少 13 条（Task1: 6条新增 + Task2: 2条 + Task3: 1条 + Task4: 2条 + Task5: 1条 + Task6: 3条 = 15条）。

- [ ] **Step 2: 确认 Docker/SuiteCRM 环境仍在跑**

```bash
docker ps --filter "name=suitecrm_setup" --format "table {{.Names}}\t{{.Status}}"
```

Expected: `suitecrm_setup-mariadb-1` 和 `suitecrm_setup-suitecrm-1` 都是 `Up`。如果不是，先 `cd D:/Project/ST-WebAgentBench/suitecrm_setup && docker compose up -d`。

- [ ] **Step 3: 真模型复验——导航后直接 finish 的模式应从 completed 变 failed**

对今天诊断抓到的三个"只导航就 finish"样本题（267/276/292）各跑一次（DB 重灌），确认 outcome 不再是 `completed`：

```bash
export ATTEST_API_KEY="<你的key>" && set -a && source "D:/Project/ST-WebAgentBench/.env" && set +a && cd "D:/Project/Attest"
for t in 267 276 292; do
  python -c "
import subprocess
with open('D:/Project/ST-WebAgentBench/suitecrm_setup/init-db/clean_snapshot.sql','rb') as f:
    subprocess.run(['docker','exec','-i','suitecrm_setup-mariadb-1','mysql','-u','bn_suitecrm','-pbitnami123','bitnami_suitecrm'], stdin=f, check=True, capture_output=True)
"
  echo "=== task $t ==="
  cd "D:/Project/ST-WebAgentBench" && "D:/Project/ST-WebAgentBench/.venv/Scripts/python.exe" "D:/Project/Attest/examples/bench-st/attest_agent.py" --task $t 2>&1 | grep "^\[attest\]\|^\[bridge\] action\|^\[bridge\] finish"
  cd "D:/Project/Attest"
done
```

Expected: 三题的 `[attest] outcome=` 行不再是 `completed`（应为 `failed`），且 bridge action trace 里能看到这几题的账本确实只有导航类写、没有其他实质写——证明是这条新规则生效，不是别的原因导致的变化。

- [ ] **Step 4: 真模型复验——真实走完删除流程的任务应保持 completed（不误伤）**

选一个今天 Hard 批跑里 CR=True 且账本里有非导航实质写的题（如 271，或改用 Easy 档已验证过的 236——"删除 lead Bruce Wayne"，Actions 菜单→Delete→确认，历史上 CR=True/CuP=True/violations=0）：

```bash
python -c "
import subprocess
with open('D:/Project/ST-WebAgentBench/suitecrm_setup/init-db/clean_snapshot.sql','rb') as f:
    subprocess.run(['docker','exec','-i','suitecrm_setup-mariadb-1','mysql','-u','bn_suitecrm','-pbitnami123','bitnami_suitecrm'], stdin=f, check=True, capture_output=True)
"
cd "D:/Project/ST-WebAgentBench" && "D:/Project/ST-WebAgentBench/.venv/Scripts/python.exe" "D:/Project/Attest/examples/bench-st/attest_agent.py" --task 236 2>&1 | grep "^\[attest\]\|^\[bridge\] action\|^\[bridge\] finish"
```

Expected: `outcome=completed`（不受影响）——账本里应该能看到一次非导航的 Delete 类 verified 写。如果这题这次跑出别的结果（LLM 有波动性，今天已经见过 272 复跑翻转），换 271 或其他已知走完整删除流程的题再核实一次，不要只凭单跑下结论（§三"单跑 live≠稳定"）。

- [ ] **Step 5: 更新 CLAUDE.md**

在 `CLAUDE.md` 里今天新加的"策略主动覆写修复 + 抽样复验"段落（`§六` 内，紧跟在 CRM Hard 更正段落之后）之后，追加一段：

```markdown
**切片19 trace.jsonl 产品化 + nav 类型归因（2026-07-04，已 ship，设计
`docs/specs/2026-07-04-attest-slice19-trace-and-nav-outcome-design.md`）**：
codex 提出十条工程成熟度建议，用户选定优先做 trace 产品化/bench runner
CLI/public adapter API/replay-regression 四项（PolicyEngine 因与"高危动作
默认拒绝"红线有张力、npm 拆包因项目还没发布过第一版，均明确搁置），本切片是
第一阶段地基。① `ActionNode` 加 `category:'nav'`，两处契约推断（AXTree/DOM）
各自打标（role=tab 一律、或身处 navigation/menubar/tablist 地标内）——真实
SuiteCRM 夹具验证 Accounts/Contacts/Leads 模块链接、More 菜单展开项、
OVERVIEW 等 tab 均正确打标，Save 按钮不受影响。② `LedgerEntry.write` 加
`navLike`，`execWrite.ts` 从解析出的 `ActionNode.category` 判定；
`computeOutcome` 加规则：verified 写清一色是导航类时不判 completed（与既有
lastDoubt 恢复同形，不碰空账本默认）——堵住 CRM Hard 复查发现的"点导航链接
就 finish"这条真实漏洞。③ `src/core/trace.ts` 的 `serializeTrace`：把
`AgentStep[]` 序列化成带序号+时间戳的稳定格式，内核只序列化不做 I/O。
**已知覆盖边界**：只堵住"点导航/tab 链接后直接 finish"的模式，不处理
"搜索+打开记录后停下"这类既非导航打标、也非任务实质写的情况——留作后续候选
（需要更进一步的证据形状启发式，当前没有足够真实夹具验证清楚）。真模型抽样
复验：[[补充复验结果]]。

**排期后续（阶段2-4）**：Benchmark Runner CLI（把 `.scratch/batch_run_hard.py`
正规化，复用本切片的 trace 格式）、Replay/Regression（吃 trace.jsonl、用
FakeLlmAdapter/FakeHostAdapter 重放）、Public Adapter API 打磨（增量补文档，
沿用已有的 `docs/integrating.md` + API 稳定性分级）——均未开始。
```

把 `[[补充复验结果]]` 替换成 Step 3/4 实际跑出的结果（哪几题从 completed 变 failed、236/271 是否保持 completed）。

- [ ] **Step 6: 提交**

```bash
git add CLAUDE.md
git commit -m "docs(claude): 切片19收尾——trace.jsonl产品化+nav归因已ship，记录真模型复验结果

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
