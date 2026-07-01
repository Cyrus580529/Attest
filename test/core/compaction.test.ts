import { describe, it, expect } from 'vitest';
import { compactMessages, estimateTokens } from '../../src/core/compaction';
import type { LlmMessage } from '../../src/llm/types';

const big = (n: number) => 'x'.repeat(n);

/** 造一段增长的对话：system + user + 若干 (assistant[toolCalls] + tool) 回合。 */
function conversation(turns: number, toolResultChars = 400): LlmMessage[] {
  const msgs: LlmMessage[] = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '任务' },
  ];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'openObject', arguments: { ref: `o${i}` } }] });
    msgs.push({ role: 'tool', toolCallId: `c${i}`, content: big(toolResultChars) });
  }
  return msgs;
}

const opts = { maxContextTokens: 200, keepRecentMessages: 4 };

describe('compactMessages', () => {
  it('未超预算 → 原样返回', () => {
    const msgs = conversation(1, 50);
    expect(compactMessages(msgs, '摘要', { maxContextTokens: 100000 })).toBe(msgs);
  });

  it('超预算 → 压缩：保 system+user、插摘要、留近期、丢中间', () => {
    const msgs = conversation(20); // 远超预算
    const out = compactMessages(msgs, '事实进展：打开了若干对象', opts);

    expect(out.length).toBeLessThan(msgs.length);
    expect(out[0]).toEqual({ role: 'system', content: '系统提示' });
    expect(out[1]).toEqual({ role: 'user', content: '任务' });
    expect(out[2]).toMatchObject({ role: 'user' }); // 摘要作为 user 消息
    expect(out[2]!.content).toContain('事实进展');
    expect(estimateTokens(out)).toBeLessThan(estimateTokens(msgs));
  });

  it('压缩后尾部不以孤立 tool 开头（保住 assistant/tool 配对）', () => {
    const msgs = conversation(20);
    const out = compactMessages(msgs, '摘要', opts);
    const tail = out.slice(3); // system,user,summary 之后
    expect(tail[0]!.role).not.toBe('tool'); // 尾部首条必是 assistant/user，不能是悬空 tool
    // 每个 tool 消息前面都得有它的 assistant（配对完整）
    for (let i = 0; i < tail.length; i++) {
      if (tail[i]!.role === 'tool') {
        expect(tail[i - 1]?.role === 'assistant' || tail[i - 1]?.role === 'tool').toBe(true);
      }
    }
  });

  it('保留最近的实际内容（最后一条 tool 结果仍在）', () => {
    const msgs = conversation(20);
    const last = msgs[msgs.length - 1];
    const out = compactMessages(msgs, '摘要', opts);
    expect(out[out.length - 1]).toBe(last);
  });
});
