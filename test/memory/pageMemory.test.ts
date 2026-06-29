import { describe, it, expect } from 'vitest';
import { parseContract } from '../../src/contract/parseContract';
import { PageMemory, recordRef, resolveRecordedRef } from '../../src/memory/pageMemory';

function build(html: string, url = '/board') {
  document.body.innerHTML = html;
  return parseContract(document.body, url);
}

describe('recordRef', () => {
  it('object → ordinal', () => {
    const s = build(`<div data-agent-object="ticket:1">A</div><div data-agent-object="ticket:2">B</div>`);
    expect(recordRef(s, { kind: 'object', id: 'object:ticket:2' })).toEqual({ by: 'ordinal', type: 'ticket', index: 1 });
  });

  it('action → name', () => {
    const s = build(`<button data-agent-action="open">o</button>`);
    expect(recordRef(s, { kind: 'action', id: 'action:open' })).toEqual({ by: 'name', kind: 'action', name: 'open' });
  });
});

describe('resolveRecordedRef 跨实例', () => {
  it('ordinal：在另一组数据上命中同位置', () => {
    const other = build(`<div data-agent-object="ticket:7">X</div><div data-agent-object="ticket:9">Y</div>`);
    const ref = resolveRecordedRef(other, { by: 'ordinal', type: 'ticket', index: 1 });
    expect(ref?.id).toBe('object:ticket:9');
  });

  it('name：按名命中', () => {
    const s = build(`<button data-agent-action="open">o</button>`);
    expect(resolveRecordedRef(s, { by: 'name', kind: 'action', name: 'open' })?.id).toBe('action:open');
  });

  it('找不到 → null', () => {
    const s = build(`<div data-agent-object="ticket:1">A</div>`);
    expect(resolveRecordedRef(s, { by: 'ordinal', type: 'ticket', index: 5 })).toBeNull();
  });
});

describe('PageMemory', () => {
  it('record/lookup', () => {
    const m = new PageMemory();
    expect(m.lookup('k')).toBeNull();
    m.record('k', [{ tool: 'finish', answer: 'done' }]);
    expect(m.lookup('k')?.steps[0]?.answer).toBe('done');
  });
});
