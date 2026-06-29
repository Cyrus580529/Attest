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
});
