import { describe, it, expect } from 'vitest';
import { READ_LOOP_TOOLS, REF_TOOL_KINDS } from '../../src/core/tools';

describe('read-loop tools', () => {
  it('暴露五个工具且无写工具', () => {
    const names = READ_LOOP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['finish', 'navigate', 'observePage', 'openObject', 'readSurface']);
    expect(names).not.toContain('invokeAction');
    expect(names).not.toContain('setControl');
  });

  it('ref 工具声明期望 kind', () => {
    expect(REF_TOOL_KINDS).toEqual({ readSurface: 'surface', openObject: 'object', navigate: 'object' });
  });

  it('finish 要求 answer 参数', () => {
    const finish = READ_LOOP_TOOLS.find((t) => t.name === 'finish');
    expect((finish?.parameters as { required?: string[] }).required).toEqual(['answer']);
  });
});
