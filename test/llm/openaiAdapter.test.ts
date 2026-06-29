import { describe, it, expect } from 'vitest';
import { createOpenAiAdapter } from '../../src/llm/openaiAdapter';
import { READ_LOOP_TOOLS } from '../../src/core/tools';

describe('openaiAdapter', () => {
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
      return new Response(JSON.stringify({ choices: [{ message: { content: '好的' } }] }), { status: 200 });
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

  it('非 2xx 抛错', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const adapter = createOpenAiAdapter({ apiKey: 'bad', fetchImpl });
    await expect(adapter.step([], [])).rejects.toThrow('401');
  });
});
