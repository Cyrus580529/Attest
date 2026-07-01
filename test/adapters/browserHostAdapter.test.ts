import { describe, it, expect, beforeEach } from 'vitest';
import { createBrowserHostAdapter } from '../../src/adapters/browserHostAdapter';
import { cssPath } from '../../src/adapters/cssPath';
import type { BrowserPage } from '../../src/adapters/browserPage';
import { createAgent, type AgentStep } from '../../src/core/loop';
import { FakeLlmAdapter, toolCallTurn } from '../../src/testing/fakeLlmAdapter';
import type { ConfirmFn } from '../../src/honesty/types';

beforeEach(() => {
  document.body.innerHTML = '';
});
async function collect(gen: AsyncGenerator<AgentStep>) {
  const out: AgentStep[] = [];
  for await (const s of gen) out.push(s);
  return out;
}
const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const APPROVE: ConfirmFn = () => Promise.resolve({ approved: true });

/** 假 BrowserPage：背靠全局 happy-dom document，模拟真实浏览器页面的读/点/填。 */
class FakeBrowserPage implements BrowserPage {
  url(): string {
    return '/app';
  }
  content(): Promise<string> {
    return Promise.resolve(document.documentElement.outerHTML);
  }
  click(selector: string): Promise<void> {
    (document.querySelector(selector) as HTMLElement | null)?.click();
    return Promise.resolve();
  }
  fill(selector: string, value: string): Promise<void> {
    const el = document.querySelector(selector) as HTMLInputElement | null;
    if (el) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return Promise.resolve();
  }
}

describe('cssPath', () => {
  it('生成的选择器能唯一定位原元素', () => {
    document.body.innerHTML = `<div><button>A</button><button id="b2">B</button><section>x</section></div>`;
    const b2 = document.querySelector('#b2')!;
    expect(document.querySelector(cssPath(b2))).toBe(b2);
    const firstBtn = document.querySelectorAll('button')[0]!;
    expect(document.querySelector(cssPath(firstBtn))).toBe(firstBtn);
  });
});

describe('createBrowserHostAdapter（Route B 桥：真实 DOM 上驱动 + inferContract）', () => {
  it('端到端：无标注页 → 推断契约 → 点击动作 → diff 验证 → 诚实 outcome', async () => {
    // 语义化但无 data-agent-*/VOIX 标注的页面（模拟 benchmark 真实站）
    document.body.innerHTML = `<button>保存</button><section aria-label="状态">未保存</section>`;
    document.querySelector('button')!.addEventListener('click', () => {
      document.querySelector('section[aria-label="状态"]')!.textContent = '已保存';
    });

    const host = createBrowserHostAdapter(new FakeBrowserPage(), { parseHtml });
    await host.refresh(); // 初始化缓存

    const before = host.snapshot();
    const save = before.actions.find((a) => a.name === '保存')!;
    expect(save).toBeTruthy();
    expect(save.provenance).toBe('inferred'); // 推断来源 → 写会被 held

    const llm = new FakeLlmAdapter([
      toolCallTurn('invokeAction', { ref: save.ref.id }),
      toolCallTurn('finish', { answer: '已保存' }),
    ]);
    // 推断写默认 held → 需批准；批准后点击真实按钮、diff 验证
    const steps = await collect(createAgent({ llm, host, confirm: APPROVE }).run('点保存'));

    expect(steps.some((s) => s.type === 'held')).toBe(true); // 来源感知：inferred 写被 held
    expect(steps.some((s) => s.type === 'action' && s.verified)).toBe(true); // 点击后状态变 → verified
    expect(steps.at(-1)).toMatchObject({ type: 'finish', outcome: 'completed' });
    expect(document.querySelector('section[aria-label="状态"]')!.textContent).toBe('已保存');
  });
});
