import { describe, it, expect } from 'vitest';
import { validateProgram } from '../../../src/core/program/types';

describe('validateProgram', () => {
  it('合法嵌套程序 → 无错误', () => {
    const program = {
      body: [
        {
          op: 'forEach',
          query: { type: 'ticket', status: 'open' },
          as: 't',
          do: [
            { op: 'open', on: '$t' },
            {
              op: 'if',
              cond: { surface: 'detail', contains: 'urgent' },
              then: [{ op: 'invoke', action: 'resolve' }],
            },
          ],
        },
        { op: 'finish', answer: '已处理紧急工单' },
      ],
    };
    expect(validateProgram(program)).toEqual([]);
  });

  it('body 不是数组 → 错误', () => {
    expect(validateProgram({ body: 'nope' }).length).toBeGreaterThan(0);
    expect(validateProgram({}).length).toBeGreaterThan(0);
  });

  it('未知 op → 错误', () => {
    const errs = validateProgram({ body: [{ op: 'teleport' }] });
    expect(errs.some((e) => e.includes('teleport'))).toBe(true);
  });

  it('forEach 缺 query/as/do → 错误', () => {
    expect(validateProgram({ body: [{ op: 'forEach', as: 't', do: [] }] }).length).toBeGreaterThan(0);
    expect(validateProgram({ body: [{ op: 'forEach', query: {}, do: [] }] }).length).toBeGreaterThan(0);
    expect(validateProgram({ body: [{ op: 'forEach', query: {}, as: 't' }] }).length).toBeGreaterThan(0);
  });

  it('if 缺 cond/then → 错误', () => {
    expect(validateProgram({ body: [{ op: 'if', then: [] }] }).length).toBeGreaterThan(0);
    expect(
      validateProgram({ body: [{ op: 'if', cond: { surface: 'd', contains: 'x' } }] }).length,
    ).toBeGreaterThan(0);
  });

  it('invoke 缺 action → 错误', () => {
    expect(validateProgram({ body: [{ op: 'invoke' }] }).length).toBeGreaterThan(0);
  });

  it('open 缺 on / finish 缺 answer / setControl 缺字段 → 错误', () => {
    expect(validateProgram({ body: [{ op: 'open' }] }).length).toBeGreaterThan(0);
    expect(validateProgram({ body: [{ op: 'finish' }] }).length).toBeGreaterThan(0);
    expect(validateProgram({ body: [{ op: 'setControl', on: { control: 'q' } }] }).length).toBeGreaterThan(0);
  });

  it('嵌套深处的非法节点也被发现', () => {
    const program = {
      body: [{ op: 'forEach', query: {}, as: 't', do: [{ op: 'bogus' }] }],
    };
    expect(validateProgram(program).some((e) => e.includes('bogus'))).toBe(true);
  });
});
