import type { LlmMessage } from '../llm/types';

/** 压缩摘要的哨兵前缀：标记「本条是内核注入的压缩摘要」，供再次压缩时剔除，防摘要累积。 */
export const COMPACTION_SENTINEL = '⟪ctx⟫';

export interface CompactionOptions {
  /** 估算 token 预算；历史超此值触发压缩。 */
  maxContextTokens: number;
  /** 压缩时保留的近期消息条数（会前移到 assistant 边界以保 tool_call 配对）。默认 6。 */
  keepRecentMessages?: number;
}

/** 粗略 token 估算（char/4）——够用即可，不引 tokenizer 依赖（YAGNI）。 */
export function estimateTokens(messages: LlmMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.toolCalls?.length) chars += JSON.stringify(m.toolCalls).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * 压缩对话历史以控制上下文：超预算时，保留 system+user 头、插入一条摘要（事实进展），
 * 保留最近若干消息，丢弃中间的陈旧观察（旧快照多已被新快照取代）。
 * 关键约束：尾部起点前移到 assistant 边界，绝不让 tool 消息悬空（否则破坏 tool_call 配对，API 报错）。
 * 纯函数、可测；不达预算原样返回。
 */
export function compactMessages(
  messages: LlmMessage[],
  summaryNote: string,
  opts: CompactionOptions,
): LlmMessage[] {
  if (estimateTokens(messages) <= opts.maxContextTokens) return messages;

  // 剔除历史里既有的压缩摘要，避免多次压缩后摘要累积（始终只保留最新一条）。
  const cleaned = messages.filter((m) => !(m.role === 'user' && m.content.startsWith(COMPACTION_SENTINEL)));

  const head = cleaned.slice(0, 2); // [system, user]
  const keepRecent = opts.keepRecentMessages ?? 6;

  let start = Math.max(2, cleaned.length - keepRecent);
  // 前移越过悬空的 tool（其 assistant 会被丢），让尾部从一个完整回合的 assistant 开始。
  while (start < cleaned.length && cleaned[start]?.role === 'tool') start++;

  const tail = cleaned.slice(start);
  const summary: LlmMessage = { role: 'user', content: COMPACTION_SENTINEL + summaryNote };
  return [...head, summary, ...tail];
}
