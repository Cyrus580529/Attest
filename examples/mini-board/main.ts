// Mini Board — Attest 示范接线（浏览器里手动跑 live LLM 用）。
// 注意：仅本地演示，勿在此提交真实 OPENAI_API_KEY。
import { createAgent } from '../../src/core/loop';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';
import { createOpenAiAdapter } from '../../src/llm/openaiAdapter';

const apiKey = (globalThis as { OPENAI_API_KEY?: string }).OPENAI_API_KEY ?? '';

export const agent = createAgent({
  llm: createOpenAiAdapter({ apiKey }),
  host: createDomHostAdapter(),
  confirm: (intent) => Promise.resolve({ approved: confirm(`高风险操作：${intent.label}？`) }),
});

// 用法示例（在浏览器控制台）：
//   for await (const step of agent.run('看所有工单并总结')) console.log(step);
//   for await (const step of agent.run('把第一个标记为已解决')) console.log(step); // 触发 held
