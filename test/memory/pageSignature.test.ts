import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { pageSignature } from '../../src/memory/pageSignature';

function build(html: string, url = '/board') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

describe('pageSignature', () => {
  it('同形状不同数据 → 签名相同', () => {
    const a = build(`<div data-agent-object="ticket:1">A</div><button data-agent-action="open">o</button>`);
    const b = build(`<div data-agent-object="ticket:9">Z</div><button data-agent-action="open">o</button>`);
    expect(pageSignature(a)).toBe(pageSignature(b));
  });

  it('不同 action 集 → 签名不同', () => {
    const a = build(`<button data-agent-action="open">o</button>`);
    const b = build(`<button data-agent-action="resolve">r</button>`);
    expect(pageSignature(a)).not.toBe(pageSignature(b));
  });
});
