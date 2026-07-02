import { describe, it, expect } from 'vitest';
import { WorldModel } from '../../src/memory/worldModel';
import { parseContract } from '../../src/contract/parseContract';

const snap = () => {
  document.body.innerHTML = `<button data-agent-action="done">完成</button>`;
  return parseContract(document.body, '/p');
};

describe('WorldModel（从证据学 动作→diff 因果，按签名闸门）', () => {
  it('learn 后 predict 同签名同动作 → 返回最近一次证据作预测', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'done', { changed: true, details: ['surface s changed'] });
    expect(wm.predict(s, 'done')).toEqual({ expectDetails: ['surface s changed'] });
  });

  it('未学过的动作 → predict 返回 null', () => {
    expect(new WorldModel().predict(snap(), 'done')).toBeNull();
  });

  it('重复 learn（形状命中）→ 覆盖为最近一次原文（最新证据胜出）', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'done', { changed: true, details: ['control control:q: 0 → 1'] });
    wm.learn(s, 'done', { changed: true, details: ['control control:q: 1 → 2'] });
    expect(wm.predict(s, 'done')).toEqual({ expectDetails: ['control control:q: 1 → 2'] });
  });

  it('无变化的证据不学（changed=false 不构成因果）', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'done', { changed: false, details: [] });
    expect(wm.predict(s, 'done')).toBeNull();
  });
});

describe('WorldModel 漂移检测（写时裁定，两级阈值，形状比较）', () => {
  it('形状命中：同动作产生同构 diff（实例 id 不同）→ 不算落空，刷新为最新原文', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'add', { changed: true, details: ['object appeared: object:task:9'] });
    wm.learn(s, 'add', { changed: true, details: ['object appeared: object:task:10'] });
    expect(wm.lookup(s, 'add')).toEqual({
      details: ['object appeared: object:task:10'],
      status: 'active',
    });
    expect(wm.drainDrift()).toEqual([]);
  });

  it('control 值不同、url 变化不同 → 也是形状命中', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'go', {
      changed: true,
      details: ['control control:qty: 0 → 5', 'url: /a → /b'],
    });
    wm.learn(s, 'go', {
      changed: true,
      details: ['control control:qty: 5 → 7', 'url: /b → /c'],
    });
    expect(wm.lookup(s, 'go')?.status).toBe('active');
    expect(wm.drainDrift()).toEqual([]);
  });

  it('第一次形状落空 → 降为 suspect（警戒级），不报漂移、不改先验原文', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'add', { changed: true, details: ['object appeared: object:task:1'] });
    wm.learn(s, 'add', { changed: true, details: ['surface surface:err changed'] });
    expect(wm.lookup(s, 'add')).toEqual({
      details: ['object appeared: object:task:1'],
      status: 'suspect',
    });
    expect(wm.drainDrift()).toEqual([]);
  });

  it('连续第二次落空 → 报漂移事件，并采纳新行为自愈（active + 新 details）', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'add', { changed: true, details: ['object appeared: object:task:1'] });
    wm.learn(s, 'add', { changed: true, details: ['surface surface:err changed'] });
    wm.learn(s, 'add', { changed: true, details: ['surface surface:err changed'] });
    const events = wm.drainDrift();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'add',
      expected: ['object appeared: object:task:1'],
      observed: ['surface surface:err changed'],
    });
    expect(wm.lookup(s, 'add')).toEqual({
      details: ['surface surface:err changed'],
      status: 'active',
    });
    expect(wm.drainDrift()).toEqual([]); // drain 后清空
  });

  it('已知有效的动作连续 2 次确认无变化 → 漂移事件（observed=[]）+ 逐出', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'add', { changed: true, details: ['object appeared: object:task:1'] });
    wm.learn(s, 'add', { changed: false, details: [] });
    expect(wm.lookup(s, 'add')?.status).toBe('suspect');
    wm.learn(s, 'add', { changed: false, details: [] });
    const events = wm.drainDrift();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'add', observed: [] });
    expect(wm.lookup(s, 'add')).toBeNull(); // 无新行为可采纳 → 逐出，不再作先验
  });

  it('负样本：无先验的动作 2 次无效果 → noEffectCount=2；一旦有验证变化即清零并建正先验', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'noop', { changed: false, details: [] });
    wm.learn(s, 'noop', { changed: false, details: [] });
    expect(wm.noEffectCount(s, 'noop')).toBe(2);
    wm.learn(s, 'noop', { changed: true, details: ['surface surface:x changed'] });
    expect(wm.noEffectCount(s, 'noop')).toBe(0);
    expect(wm.lookup(s, 'noop')?.status).toBe('active');
  });

  it('持久化 v2：misses/noEffect 随 toJSON/fromJSON 往返保留', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'add', { changed: true, details: ['object appeared: object:task:1'] });
    wm.learn(s, 'add', { changed: true, details: ['surface surface:x changed'] }); // suspect
    wm.learn(s, 'noop', { changed: false, details: [] });
    const revived = WorldModel.fromJSON(JSON.parse(JSON.stringify(wm.toJSON())));
    expect(revived.lookup(s, 'add')?.status).toBe('suspect');
    expect(revived.noEffectCount(s, 'noop')).toBe(1);
  });

  it('持久化兼容：fromJSON 接受 v1 旧格式（Record<key, details[]>）', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'add', { changed: true, details: ['d1'] });
    // 手工构造 v1 旧盘格式
    const legacy: Record<string, string[]> = {};
    for (const [k, e] of Object.entries(wm.toJSON().entries)) legacy[k] = e.details;
    const revived = WorldModel.fromJSON(legacy);
    expect(revived.lookup(s, 'add')).toEqual({ details: ['d1'], status: 'active' });
  });

  it('suspect 后一次命中 → 回 active、计数清零', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'add', { changed: true, details: ['object appeared: object:task:1'] });
    wm.learn(s, 'add', { changed: true, details: ['surface surface:x changed'] }); // 落空1
    wm.learn(s, 'add', { changed: true, details: ['object appeared: object:task:2'] }); // 命中
    expect(wm.lookup(s, 'add')?.status).toBe('active');
    wm.learn(s, 'add', { changed: true, details: ['surface surface:x changed'] }); // 又落空，应是第1次
    expect(wm.lookup(s, 'add')?.status).toBe('suspect');
    expect(wm.drainDrift()).toEqual([]);
  });
});
