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
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 15_000;
  const sleep = options.sleepImpl ?? defaultSleep;

  /** 指数退避 + 抖动，封顶 maxBackoffMs。 */
  function backoff(attempt: number): number {
    const base = Math.min(maxBackoffMs, backoffBaseMs * 2 ** attempt);
    return base + Math.floor(Math.random() * backoffBaseMs);
  }

  async function fetchWithTimeout(body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 单次尝试：成功返回 LlmTurn；失败抛 LlmRequestError（分类）或原始网络错误。 */
  async function attemptOnce(body: string): Promise<LlmTurn> {
    const res = await fetchWithTimeout(body); // 网络/超时错误直接向上抛（视为可重试）
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
      const message = data?.choices?.[0]?.message;
      if (!message) {
        throw new LlmRequestError('OpenAI 响应畸形（malformed）：缺 choices/message', res.status, false);
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
