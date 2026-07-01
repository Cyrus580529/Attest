/**
 * 浏览器页面端口：真实浏览器后端（如 Playwright 的 Page）需实现的最小子集。
 * Playwright 的 Page 几乎原样满足此接口（url 同步、其余异步）。
 * 桥核心（browserHostAdapter）只依赖此端口，故可用假 Page 单测，不必真起浏览器。
 */
export interface BrowserPage {
  /** 当前 URL。 */
  url(): string;
  /** 当前**已渲染**的 HTML（含 JS 变更后的 DOM）。 */
  content(): Promise<string>;
  /** 点击匹配选择器的元素。 */
  click(selector: string): Promise<void>;
  /** 向表单控件填值（含派发 input/change）。 */
  fill(selector: string, value: string): Promise<void>;
}
