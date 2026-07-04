import { describe, it, expect } from 'vitest';
import { createOpenAiAdapter, LlmRequestError } from '../../src/llm/openaiAdapter';
import { READ_LOOP_TOOLS } from '../../src/core/tools';

const noSleep = () => Promise.resolve();
const okBody = (content = '好的') =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe('openaiAdapter — 解析', () => {
  it('解析 tool_calls 为 LlmTurn', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'observePage', arguments: '{}' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl });
    const turn = await adapter.step([{ role: 'user', content: 'hi' }], READ_LOOP_TOOLS);
    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'observePage', arguments: {} }]);
    expect(turn.content).toBe('');
  });

  it('构造请求：带 model、tools、Authorization', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return okBody();
    }) as unknown as typeof fetch;

    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', model: 'gpt-x', fetchImpl });
    const turn = await adapter.step([{ role: 'user', content: 'hi' }], READ_LOOP_TOOLS);
    expect(turn).toEqual({ content: '好的', toolCalls: [] });
    expect(captured!.url).toContain('/chat/completions');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.model).toBe('gpt-x');
    expect(body.tools).toHaveLength(READ_LOOP_TOOLS.length);
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('响应缺 choices/message → 抛 malformed（不静默返空），错误信息带原始响应片段方便诊断', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 })) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl });
    await expect(adapter.step([], [])).rejects.toThrow(/malformed|畸形|choices/i);
    // 真实事故：Anthropic 的 OpenAI 兼容层返回畸形响应时，此前的报错吞掉了原始 body，
    // 只能靠猜（如缺 max_tokens）——现在错误信息里必须带上实际收到的内容。
    await expect(adapter.step([], [])).rejects.toThrow(/foo/);
  });

  it('请求体默认带 max_tokens（部分 OpenAI 兼容端点——如 Anthropic 的兼容层——要求必填）', async () => {
    let captured: { init: RequestInit } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return okBody();
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl });
    await adapter.step([{ role: 'user', content: 'hi' }], []);
    const body = JSON.parse(String(captured!.init.body));
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('maxTokens 选项可覆盖默认值', async () => {
    let captured: { init: RequestInit } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return okBody();
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', maxTokens: 1234, fetchImpl });
    await adapter.step([{ role: 'user', content: 'hi' }], []);
    const body = JSON.parse(String(captured!.init.body));
    expect(body.max_tokens).toBe(1234);
  });
});

describe('openaiAdapter — 硬化（重试/退避/超时/分类）', () => {
  it('429 后成功 → 重试并成功', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return n === 1 ? new Response('rate', { status: 429 }) : okBody('第二次成功');
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl, sleepImpl: noSleep });
    const turn = await adapter.step([], []);
    expect(turn.content).toBe('第二次成功');
    expect(n).toBe(2);
  });

  it('5xx 连续两次后成功 → 共 3 次调用', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return n <= 2 ? new Response('server', { status: 503 }) : okBody('终于');
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl, sleepImpl: noSleep });
    const turn = await adapter.step([], []);
    expect(turn.content).toBe('终于');
    expect(n).toBe(3);
  });

  it('网络异常（fetch 抛）→ 重试', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) throw new TypeError('network down');
      return okBody('恢复');
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl, sleepImpl: noSleep });
    const turn = await adapter.step([], []);
    expect(turn.content).toBe('恢复');
    expect(n).toBe(2);
  });

  it('401 → 快速失败，不重试（仅 1 次调用）', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response('bad key', { status: 401 });
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'bad', fetchImpl, sleepImpl: noSleep });
    await expect(adapter.step([], [])).rejects.toThrow('401');
    expect(n).toBe(1);
  });

  it('重试耗尽 → 抛错，调用 maxRetries+1 次', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response('down', { status: 503 });
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl, sleepImpl: noSleep, maxRetries: 2 });
    await expect(adapter.step([], [])).rejects.toThrow(LlmRequestError);
    expect(n).toBe(3); // 1 + 2 retries
  });

  it('429 带 Retry-After → 用它作退避时长', async () => {
    let n = 0;
    const slept: number[] = [];
    const fetchImpl = (async () => {
      n++;
      return n === 1
        ? new Response('rate', { status: 429, headers: { 'Retry-After': '2' } })
        : okBody('ok');
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({
      apiKey: 'sk-test',
      fetchImpl,
      sleepImpl: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    await adapter.step([], []);
    expect(slept[0]).toBe(2000); // Retry-After: 2 秒
  });

  it('超时 → 按重试处理（Promise.race 计时，不依赖 AbortSignal，跨 realm 安全）', async () => {
    let n = 0;
    const fetchImpl = (() => {
      n++;
      return new Promise<Response>(() => {}); // 永不 resolve → 靠超时兜底
    }) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'sk-test', fetchImpl, sleepImpl: noSleep, timeoutMs: 10, maxRetries: 1 });
    await expect(adapter.step([], [])).rejects.toThrow(/超时|timeout/i);
    expect(n).toBe(2); // 超时可重试：1 + 1
  });
});
