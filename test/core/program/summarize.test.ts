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

describe('summarizeProgram（从程序 AST 推导人话计划）', () => {
  it('forEach 展开为每个对象的具体步骤，用标题与动作名而非 ref id', () => {
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
    expect(summarizeProgram(program, board())).toEqual([
      '打开「登录页 500 错误」',
      '标记为已解决（登录页 500 错误）',
      '打开「导出 CSV 乱码」',
      '标记为已解决（导出 CSV 乱码）',
    ]);
  });

  it('if 条件渲染为“若…则”，setControl/read 也人话化', () => {
    const program: Program = {
      body: [
        { op: 'if', cond: { surface: 'detail', contains: 'urgent' }, then: [{ op: 'read', surface: 'detail' }] },
      ],
    };
    expect(summarizeProgram(program, board())).toEqual([
      '若「detail」含“urgent”，则：',
      '　查看「detail」区域',
    ]);
  });

  it('finish 不计入计划动作', () => {
    const program: Program = { body: [{ op: 'finish', answer: 'hi' }] };
    expect(summarizeProgram(program, board())).toEqual([]);
  });
});
