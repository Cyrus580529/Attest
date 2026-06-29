import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { diffSnapshots } from '../../src/honesty/verifier';

function build(html: string, url = '/p') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

describe('diffSnapshots', () => {
  it('无变化 → changed=false', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`);
    const b = build(`<div data-agent-object="task:1">A</div>`);
    expect(diffSnapshots(a, b)).toEqual({ changed: false, details: [] });
  });

  it('url 变化被记录', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`, '/list');
    const b = build(`<div data-agent-object="task:1">A</div>`, '/done');
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('/list') && d.includes('/done'))).toBe(true);
  });

  it('控件值变化被记录', () => {
    const a = build(`<input data-agent-control="amount" value="100" />`);
    const b = build(`<input data-agent-control="amount" value="200" />`);
    const ev = diffSnapshots(a, b);
    expect(ev.changed).toBe(true);
    expect(ev.details.some((d) => d.includes('control:amount'))).toBe(true);
  });

  it('对象出现/消失被记录', () => {
    const a = build(`<div data-agent-object="task:1">A</div>`);
    const b = build(`<div data-agent-object="task:2">B</div>`);
    const ev = diffSnapshots(a, b);
    expect(ev.details.some((d) => d.includes('appeared') && d.includes('object:task:2'))).toBe(true);
    expect(ev.details.some((d) => d.includes('gone') && d.includes('object:task:1'))).toBe(true);
  });
});
