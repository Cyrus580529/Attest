import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { serializeSnapshot } from '../../src/core/serialize';

describe('serializeSnapshot', () => {
  it('输出紧凑文本，标记 high-risk', () => {
    document.body.innerHTML = `
      <div data-agent-object="task:7">写测试</div>
      <button data-agent-action="redeem" data-agent-risk="high">兑换</button>
      <section data-agent-surface="detail">x</section>
    `;
    const text = serializeSnapshot(parseContract(document.body, '/p'));
    expect(text).toContain('url: /p');
    expect(text).toContain('object object:task:7 — 写测试');
    expect(text).toContain('action action:redeem [high-risk] — 兑换');
    expect(text).toContain('surface surface:detail — detail');
  });

  function manyTickets(n: number): string {
    document.body.innerHTML = Array.from({ length: n }, (_, i) => `<div data-agent-object="ticket:${i}">工单${i}</div>`).join('');
    return serializeSnapshot(parseContract(document.body, '/b'), { maxPerType: 20 });
  }

  describe('渐进披露（maxPerType）', () => {
    it('不传 opts → 逐个列（字节级不变）', () => {
      document.body.innerHTML = Array.from({ length: 30 }, (_, i) => `<div data-agent-object="ticket:${i}">工单${i}</div>`).join('');
      const flat = serializeSnapshot(parseContract(document.body, '/b'));
      expect(flat.match(/^object /gm)?.length).toBe(30);
    });

    it('某类型 ≤ 阈值 → 仍逐个列', () => {
      const text = manyTickets(5);
      expect(text).toContain('object object:ticket:0 — 工单0');
      expect(text).toContain('object object:ticket:4 — 工单4');
      expect(text).not.toContain('共 5 个');
    });

    it('某类型 > 阈值 → 折叠成轮廓：总数 + 样例 + 钻取提示，不逐个列', () => {
      const text = manyTickets(30);
      expect(text).toContain('type=ticket');
      expect(text).toContain('共 30 个');
      expect(text).toContain('object:ticket:0 — 工单0'); // 给几个样例
      expect(text).toContain('forEach'); // 钻取提示
      expect(text).not.toContain('object object:ticket:29'); // 不逐个全列
      expect((text.match(/工单\d+/g) ?? []).length).toBeLessThan(10); // 只露样例
    });

    it('action/control/surface 不受 maxPerType 影响', () => {
      document.body.innerHTML = `
        ${Array.from({ length: 30 }, (_, i) => `<div data-agent-object="ticket:${i}">T${i}</div>`).join('')}
        <button data-agent-action="resolve">解决</button>
        <section data-agent-surface="detail">x</section>
      `;
      const text = serializeSnapshot(parseContract(document.body, '/b'), { maxPerType: 20 });
      expect(text).toContain('action action:resolve — 解决');
      expect(text).toContain('surface surface:detail — detail');
    });
  });
});
