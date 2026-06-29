import { describe, it, expect } from 'vitest';

describe('toolchain smoke', () => {
  it('runs vitest and has a DOM document', () => {
    expect(typeof document).toBe('object');
    document.body.innerHTML = '<div id="x">hi</div>';
    expect(document.getElementById('x')?.textContent).toBe('hi');
  });
});
