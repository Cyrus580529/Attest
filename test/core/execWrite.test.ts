import { describe, it, expect, beforeEach } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import { Ledger } from '../../src/honesty/ledger';
import { executeWrite } from '../../src/core/execWrite';
import { inferContract } from '../../src/contract/inferContract';
import type { ConfirmFn } from '../../src/honesty/types';
import type { HostAdapter } from '../../src/host/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

function makeSnap(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

const APPROVE_ONCE: ConfirmFn = () => Promise.resolve({ approved: true, scope: 'once' });
const DENY: ConfirmFn = () => Promise.resolve({ approved: false });

describe('executeWrite', () => {
  it('低危 setControl 检测到变化 → verified', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const after = makeSnap(`<input data-agent-control="qty" value="5"/>`);
    const host = new FakeHostAdapter(before, { 'control:qty': after });
    const ledger = new Ledger();
    const r = await executeWrite(host, ledger, DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '5',
    });
    expect(r.verified).toBe(true);
    expect(ledger.entries.some((e) => e.kind === 'write' && e.verified)).toBe(true);
  });

  it('写动作打开表单（多个输入字段出现）→ 工具结果提示"填完再提交、别就此完成"', async () => {
    // 点一个动作后，页面冒出一排空控件=打开了表单——治"开表单即假报完成"的早退
    const before = makeSnap(`<button data-agent-action="new">新建</button>`);
    const after = makeSnap(
      `<button data-agent-action="new">新建</button>` +
        `<input data-agent-control="subject" value=""/>` +
        `<input data-agent-control="date" value=""/>` +
        `<input data-agent-control="location" value=""/>`,
    );
    const host = new FakeHostAdapter(before, { 'action:new': after });
    const r = await executeWrite(host, new Ledger(), APPROVE_ONCE, new Set(), { tool: 'invokeAction', refId: 'action:new' });
    expect(r.verified).toBe(true);
    expect(r.toolResult).toMatch(/表单|字段.*出现|填写|提交/); // 含表单打开提示
    expect(r.toolResult).toContain('不要'); // 明示别就此 finish
  });

  it('普通写（无新字段涌现）→ 不加表单提示', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const after = makeSnap(`<input data-agent-control="qty" value="5"/>`);
    const host = new FakeHostAdapter(before, { 'control:qty': after });
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), { tool: 'setControl', refId: 'control:qty', value: '5' });
    expect(r.toolResult).not.toMatch(/打开了.*表单/);
  });

  it('host 明确报 ok:false（如点击超时/元素过期）→ 记 error 而非假"未验证"', async () => {
    const snap = makeSnap(`<button data-agent-action="go">Go</button>`);
    const host: HostAdapter = {
      snapshot: () => snap,
      readSurface: () => '',
      openObject: async () => ({ ok: true, snapshot: snap }),
      navigate: async () => ({ ok: true, snapshot: snap }),
      setControl: async () => ({ ok: true, snapshot: snap }),
      invokeAction: async () => ({ ok: false, snapshot: snap, note: 'click timeout: element detached' }),
    };
    const ledger = new Ledger();
    const r = await executeWrite(host, ledger, APPROVE_ONCE, new Set(), {
      tool: 'invokeAction',
      refId: 'action:go',
    });
    expect(r.verified).toBe(false);
    expect(r.toolResult).toContain('ERROR');
    expect(r.toolResult).toContain('element detached');
    // 账本记 error（动作没执行成），不记 write（防污染 outcome/世界模型）
    expect(ledger.entries.some((e) => e.kind === 'error')).toBe(true);
    expect(ledger.entries.some((e) => e.kind === 'write')).toBe(false);
  });

  it('写后无可观察变化 → verified false，且提示"未验证≠失败，勿盲目重试"', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const host = new FakeHostAdapter(before); // 无 transition → 快照不变
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '0',
    });
    expect(r.verified).toBe(false);
    // 未验证 ≠ 失败。不给这个引导，模型的理性反应是重试 → 同一个写打两遍（重复副作用）。
    expect(r.toolResult).toContain('不要');
    expect(r.toolResult).toContain('重试');
  });

  it('效果异步落地（写返回后才渲染）→ settle 重照仍能验证，不误报未验证', async () => {
    const before = makeSnap(`<button data-agent-action="add">A</button>`);
    const after = makeSnap(
      `<button data-agent-action="add">A</button><div data-agent-object="task:9">t9</div>`,
    );
    let current = before;
    const host: HostAdapter = {
      snapshot: () => current,
      readSurface: () => '',
      openObject: () => Promise.resolve({ ok: true, snapshot: current }),
      navigate: () => Promise.resolve({ ok: true, snapshot: current }),
      setControl: () => Promise.resolve({ ok: true, snapshot: current }),
      invokeAction: () => {
        setTimeout(() => (current = after), 10); // 页面 handler 异步渲染，效果 10ms 后才可见
        return Promise.resolve({ ok: true, snapshot: current }); // 返回时快照还是旧的
      },
    };
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'invokeAction',
      refId: 'action:add',
    });
    expect(r.verified).toBe(true);
    expect(r.evidence!.some((d) => d.includes('task:9'))).toBe(true);
  });

  it('高危 invoke 默认拒绝 → cancelled，无 write 记账，且明示勿重试同一动作', async () => {
    const before = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    const host = new FakeHostAdapter(before);
    const ledger = new Ledger();
    const r = await executeWrite(host, ledger, DENY, new Set(), {
      tool: 'invokeAction',
      refId: 'action:resolve',
    });
    expect(r.verified).toBe(false);
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.steps.some((s) => s.type === 'cancelled')).toBe(true);
    expect(ledger.entries.some((e) => e.kind === 'grant' && !e.approved)).toBe(true);
    expect(ledger.entries.some((e) => e.kind === 'write')).toBe(false);
    // 不给这个引导，模型的常见反应是再试一次同一动作 → 再次 held → 浪费回合直至耗尽步数
    expect(r.toolResult).toContain('不要再次尝试');
  });

  it('高危 invoke approve(once) → 执行并验证', async () => {
    const before = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    const after = makeSnap(`<section data-agent-surface="ok">已解决</section>`, '/done');
    const host = new FakeHostAdapter(before, { 'action:resolve': after });
    const r = await executeWrite(host, new Ledger(), APPROVE_ONCE, new Set(), {
      tool: 'invokeAction',
      refId: 'action:resolve',
    });
    expect(r.verified).toBe(true);
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.steps.some((s) => s.type === 'action' && s.verified)).toBe(true);
  });

  it('作用域授权 all：首次问、入集，同名第二次不再问', async () => {
    const before = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    const host = new FakeHostAdapter(before); // 快照稳定，动作持续可解析
    const scopes = new Set<string>();
    let calls = 0;
    const confirm: ConfirmFn = () => {
      calls++;
      return Promise.resolve({ approved: true, scope: 'all' });
    };
    await executeWrite(host, new Ledger(), confirm, scopes, { tool: 'invokeAction', refId: 'action:resolve' });
    expect(scopes.has('resolve')).toBe(true);
    await executeWrite(host, new Ledger(), confirm, scopes, { tool: 'invokeAction', refId: 'action:resolve' });
    expect(calls).toBe(1); // 第二次未再调 confirm
  });

  it('来源感知：inferred 控件 setControl → held（即便非高危）', async () => {
    document.body.innerHTML = `<label for="q">数量</label><input id="q" value="0"/>`;
    const before = inferContract(document.body, '/p').snapshot;
    const host = new FakeHostAdapter(before); // 无 transition；DENY 会先 held 再取消
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:数量',
      value: '5',
    });
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.steps.some((s) => s.type === 'cancelled')).toBe(true);
    expect(r.verified).toBe(false);
  });

  it('来源感知：inferred 低危 invoke（如"下一页"）→ 也 held', async () => {
    document.body.innerHTML = `<button>下一页</button>`;
    const before = inferContract(document.body, '/p').snapshot;
    const host = new FakeHostAdapter(before);
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'invokeAction',
      refId: 'action:下一页',
    });
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.steps.some((s) => s.type === 'cancelled')).toBe(true);
  });

  it('Intent.reason 区分 held 缘由：高危=high-risk，纯推断=inferred（宿主按此定回执形式）', async () => {
    let reason: string | undefined;
    const confirm: ConfirmFn = (i) => {
      reason = i.reason;
      return Promise.resolve({ approved: false });
    };
    const hi = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    await executeWrite(new FakeHostAdapter(hi), new Ledger(), confirm, new Set(), {
      tool: 'invokeAction',
      refId: 'action:resolve',
    });
    expect(reason).toBe('high-risk');

    document.body.innerHTML = `<button>下一页</button>`;
    const lo = inferContract(document.body, '/p').snapshot;
    await executeWrite(new FakeHostAdapter(lo), new Ledger(), confirm, new Set(), {
      tool: 'invokeAction',
      refId: 'action:下一页',
    });
    expect(reason).toBe('inferred');
  });

  it('来源感知：inferred 写 approve → 正常执行验证', async () => {
    document.body.innerHTML = `<label for="q">数量</label><input id="q" value="0"/>`;
    const before = inferContract(document.body, '/p').snapshot;
    document.body.innerHTML = `<label for="q">数量</label><input id="q" value="5"/>`;
    const after = inferContract(document.body, '/p').snapshot;
    const host = new FakeHostAdapter(before, { 'control:数量': after });
    const r = await executeWrite(host, new Ledger(), APPROVE_ONCE, new Set(), {
      tool: 'setControl',
      refId: 'control:数量',
      value: '5',
    });
    expect(r.steps.some((s) => s.type === 'held')).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('authored 低危 setControl → 不 held（来源感知不误伤声明契约）', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const host = new FakeHostAdapter(before);
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '5',
    });
    expect(r.steps.some((s) => s.type === 'held')).toBe(false);
  });

  it('ref 未命中 → error step，不执行', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const host = new FakeHostAdapter(before);
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:nope',
      value: '5',
    });
    expect(r.steps[0]?.type).toBe('error');
    expect(r.verified).toBe(false);
  });

  it('confirm 等待期间目标 ref 消失 → 拒绝执行（不对旧快照的 ref 动手）', async () => {
    const before = makeSnap(`<button data-agent-action="resolve" data-agent-risk="high">R</button>`);
    const gone = makeSnap(`<section data-agent-surface="empty">动作没了</section>`);
    const host = new FakeHostAdapter(before);
    const confirm: ConfirmFn = () => {
      host.setCurrent(gone); // 用户思考期间页面变了，动作已不存在
      return Promise.resolve({ approved: true, scope: 'once' });
    };
    const r = await executeWrite(host, new Ledger(), confirm, new Set(), {
      tool: 'invokeAction',
      refId: 'action:resolve',
    });
    expect(r.verified).toBe(false);
    expect(r.steps.some((s) => s.type === 'error')).toBe(true);
    expect(host.log.some((l) => l.kind === 'invoke')).toBe(false); // 绝不执行
  });

  it('confirm 等待期间的无关变化不得归因为本次写的证据（防假验证）', async () => {
    const before = makeSnap(
      `<button data-agent-action="ping" data-agent-risk="high">P</button><div data-agent-object="task:1">t1</div>`,
    );
    // 等待期间页面自己多了 task:2（与本次写无关）；动作本身无任何效果。
    const during = makeSnap(
      `<button data-agent-action="ping" data-agent-risk="high">P</button><div data-agent-object="task:1">t1</div><div data-agent-object="task:2">t2</div>`,
    );
    const host = new FakeHostAdapter(before); // action:ping 无 transition → 执行无效果
    const confirm: ConfirmFn = () => {
      host.setCurrent(during);
      return Promise.resolve({ approved: true, scope: 'once' });
    };
    const ledger = new Ledger();
    const r = await executeWrite(host, ledger, confirm, new Set(), {
      tool: 'invokeAction',
      refId: 'action:ping',
    });
    // 老行为会 diff(等待前, 执行后) 把 task:2 的出现记成本次写的证据 → verified true（假验证）。
    expect(r.verified).toBe(false);
    expect(ledger.entries.some((e) => e.kind === 'write' && e.verified)).toBe(false);
  });

  it('WriteResult 回传本次验证的 evidence（供记忆/世界模型录制为预测）', async () => {
    const before = makeSnap(`<input data-agent-control="qty" value="0"/>`);
    const after = makeSnap(`<input data-agent-control="qty" value="5"/>`);
    const host = new FakeHostAdapter(before, { 'control:qty': after });
    const r = await executeWrite(host, new Ledger(), DENY, new Set(), {
      tool: 'setControl',
      refId: 'control:qty',
      value: '5',
    });
    expect(r.verified).toBe(true);
    expect(r.evidence).toBeDefined();
    expect(r.evidence!.some((d) => d.includes('control:qty'))).toBe(true);
  });
});
