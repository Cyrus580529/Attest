import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseContract } from '../../src/contract/parseContract';

const html = readFileSync(resolve(process.cwd(), 'examples/mini-board/index.html'), 'utf8');

beforeEach(() => {
  document.body.innerHTML = html.replace(/[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*/i, '');
});

describe('mini-board 示范页契约', () => {
  it('暴露 ticket 对象、open 动作、detail surface、resolve 高危', () => {
    const snap = parseContract(document.body, '/board');
    expect(snap.objects.filter((o) => o.type === 'ticket')).toHaveLength(3);
    expect(snap.actions.some((a) => a.name === 'open')).toBe(true);
    expect(snap.surfaces.some((s) => s.name === 'detail')).toBe(true);
    const resolve = snap.actions.find((a) => a.name === 'resolve');
    expect(resolve?.risk).toBe('high');
  });
});
