import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { actionRisk, isHighRisk } from '../../src/honesty/riskPolicy';

function snap() {
  document.body.innerHTML = `
    <button data-agent-action="apply">申请</button>
    <button data-agent-action="redeem" data-agent-risk="high">兑换</button>
  `;
  return parseContract(document.body, 'u');
}

describe('riskPolicy', () => {
  it('默认动作 low，high-risk 动作 high', () => {
    const s = snap();
    expect(actionRisk(s, 'action:apply')).toBe('low');
    expect(actionRisk(s, 'action:redeem')).toBe('high');
  });

  it('isHighRisk 仅对 high 返回 true', () => {
    const s = snap();
    expect(isHighRisk(s, 'action:redeem')).toBe(true);
    expect(isHighRisk(s, 'action:apply')).toBe(false);
  });

  it('未知 ref 视为 low', () => {
    expect(actionRisk(snap(), 'action:nope')).toBe('low');
  });
});
