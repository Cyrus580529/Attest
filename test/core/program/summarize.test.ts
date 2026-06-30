import { describe, it, expect, beforeEach } from 'vitest';
import { parseContract } from '../../../src/contract/parseContract';
import { summarizeProgram } from '../../../src/core/program/summarize';
import type { Program } from '../../../src/core/program/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

function board() {
  document.body.innerHTML = `
    <li data-agent-object="ticket:101">登录页 500 错误</li>
    <li data-agent-object="ticket:102">导出 CSV 乱码</li>
    <button data-agent-action="resolve" data-agent-risk="high">标记为已解决</button>
    <section data-agent-surface="detail">选择工单</section>
  `;
  return parseContract(document.body, '/board');
}

describe('summarizeProgram（高层里程碑，精确留给账本）', () => {
  it('forEach 收成一行里程碑：对 N 个对象做某事，不逐个摊开', () => {
    const program: Program = {
      body: [
        {
          op: 'forEach',
          query: { type: 'ticket' },
          as: 't',
          do: [
            { op: 'open', on: '$t' },
            { op: 'invoke', action: 'resolve' },
          ],
        },
        { op: 'finish', answer: 'done' },
      ],
    };
    expect(summarizeProgram(program, board())).toEqual(['对 2 个 ticket：打开、标记为已解决']);
  });

  it('if 收成一行；顶层 setControl/open 各一行人话', () => {
    const program: Program = {
      body: [
        { op: 'if', cond: { surface: 'detail', contains: 'urgent' }, then: [{ op: 'read', surface: 'detail' }] },
        { op: 'setControl', on: { control: 'amount' }, value: '5' },
      ],
    };
    expect(summarizeProgram(program, board())).toEqual([
      '若「detail」含“urgent”，则：查看「detail」',
      '把「amount」设为 5',
    ]);
  });

  it('finish 不计入计划动作', () => {
    const program: Program = { body: [{ op: 'finish', answer: 'hi' }] };
    expect(summarizeProgram(program, board())).toEqual([]);
  });
});
