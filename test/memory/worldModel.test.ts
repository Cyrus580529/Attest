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

  it('重复 learn → 覆盖为最近一次（陈旧性：最新证据胜出）', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'done', { changed: true, details: ['旧'] });
    wm.learn(s, 'done', { changed: true, details: ['新'] });
    expect(wm.predict(s, 'done')).toEqual({ expectDetails: ['新'] });
  });

  it('无变化的证据不学（changed=false 不构成因果）', () => {
    const wm = new WorldModel();
    const s = snap();
    wm.learn(s, 'done', { changed: false, details: [] });
    expect(wm.predict(s, 'done')).toBeNull();
  });
});
