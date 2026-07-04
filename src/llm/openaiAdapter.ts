import type { LlmAdapter, LlmMessage, LlmToolCall, LlmTurn, ToolSchema } from './types';

export interface OpenAiAdapterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 最大重试次数（不含首次）。默认 3，即最多 4 次尝试。 */
  maxRetries?: number;
  /** 单次请求超时（ms），超时中止并按可重试处理。默认 60000。 */
  timeoutMs?: number;
  /** 请求体的 max_tokens。默认 4096——部分 OpenAI 兼容端点（如 Anthropic 的兼容层）此字段必填，
   * 缺省会导致响应畸形；OpenAI/DeepSeek 原生端点把它当普通可选参数，不受影响。 */
  maxTokens?: number;
  /** 指数退避基数（ms）。默认 500。 */
  backoffBaseMs?: number;
  /** 退避上限（ms）。默认 15000。 */
  maxBackoffMs?: number;
  /** 退避等待实现，测试可注入无等待版。默认基于 setTimeout。 */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** LLM 请求错误：带 HTTP 状态与是否可重试的分类，供调用方与重试逻辑判断。 */
export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmRequestError';
  }
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface OpenAiResponse {
  choices?: { message?: { content: string | null; tool_calls?: OpenAiToolCall[] } }[];
}

function toOpenAiMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {}; // 参数畸形软失败：harness 会在 ref 解析时报错，不在此处炸
  }
}

/** 可重试的 HTTP 状态：限流、请求超时、5xx 服务端错误。其余 4xx 客户端错误快速失败。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/** 解析 Retry-After 头（秒数或 HTTP 日期）为 ms；无法解析返回 undefined。 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createOpenAiAdapter(options: OpenAiAdapterOptions): LlmAdapter {
  const model = options.model ?? 'gpt-4o-mini';
  const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  const doFetch = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxTokens = options.maxTokens ?? 4096;
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 15_000;
  const sleep = options.sleepImpl ?? defaultSleep;

  /** 指数退避 + 抖动，封顶 maxBackoffMs。 */
  function backoff(attempt: number): number {
    const base = Math.min(maxBackoffMs, backoffBaseMs * 2 ** attempt);
    return base + Math.floor(Math.random() * backoffBaseMs);
  }

  async function fetchWithTimeout(body: string): Promise<Response> {
    const fetchPromise = doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body,
    });
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchPromise;
    // 用 Promise.race 计时，不依赖 AbortSignal——避免跨 realm（如 happy-dom 覆盖全局 + Node 原生 fetch）
    // 的 signal 类型不匹配。代价：超时的底层请求不会被真正取消，但对 LLM 调用可接受，鲁棒性优先。
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LlmRequestError(`请求超时（${timeoutMs}ms）`, undefined, true)), timeoutMs);
    });
    try {
      return await Promise.race([fetchPromise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** 单次尝试：成功返回 LlmTurn；失败抛 LlmRequestError（分类）或原始网络错误。 */
  async function attemptOnce(body: string): Promise<LlmTurn> {
    const res = await fetchWithTimeout(body); // 网络/超时错误直接向上抛（视为可重试）
    if (res.ok) {
      const rawText = await res.text();
      const data = ((): OpenAiResponse | null => {
        try {
          return JSON.parse(rawText) as OpenAiResponse;
        } catch {
          return null;
        }
      })();
      const message = data?.choices?.[0]?.message;
      if (!message) {
        // 真实事故：不同"OpenAI 兼容"端点（如 Anthropic 的兼容层）畸形时形状各不相同——
        // 之前的报错吞掉了原始响应，只能靠猜（比如少传了 max_tokens）。带上原文片段自证。
        const snippet = rawText.length > 300 ? `${rawText.slice(0, 300)}…` : rawText;
        throw new LlmRequestError(`OpenAI 响应畸形（malformed）：缺 choices/message；原始响应：${snippet}`, res.status, false);
      }
      const toolCalls: LlmToolCall[] = (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: parseArguments(c.function.arguments),
      }));
      return { content: message.content ?? '', toolCalls };
    }
    const text = await res.text().catch(() => '');
    if (isRetryableStatus(res.status)) {
      throw new LlmRequestError(
        `OpenAI 请求失败: ${res.status} ${text}`.trim(),
        res.status,
        true,
        parseRetryAfterMs(res.headers.get('retry-after')),
      );
    }
    throw new LlmRequestError(`OpenAI 请求失败: ${res.status} ${text}`.trim(), res.status, false);
  }

  return {
    async step(messages: LlmMessage[], tools: ToolSchema[]): Promise<LlmTurn> {
      const body = JSON.stringify({
        model,
        messages: messages.map(toOpenAiMessage),
        tools: tools.map((t) => ({ type: 'function', function: t })),
        max_tokens: maxTokens,
      });

      for (let attempt = 0; ; attempt++) {
        try {
          return await attemptOnce(body);
        } catch (e) {
          // 非 LlmRequestError（网络/中止/超时）视为可重试；LlmRequestError 按其 retryable 分类。
          const retryable = e instanceof LlmRequestError ? e.retryable : true;
          if (!retryable || attempt >= maxRetries) throw e;
          const explicit = e instanceof LlmRequestError ? e.retryAfterMs : undefined;
          await sleep(explicit ?? backoff(attempt));
        }
      }
    },
  };
}
