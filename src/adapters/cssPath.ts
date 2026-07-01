/**
 * 为解析出的元素生成一个能在实时页面上唯一定位它的 CSS 选择器。
 * 有 id 优先用 id；否则用 tag + :nth-of-type 的祖先路径。
 * 用途：inferContract/parseContract 在 Node 侧解析 page.content() 得到（脱离文档的）元素，
 * 据此算出选择器，交给浏览器（Playwright）在实时 DOM 上点击/填值。
 */
export function cssPath(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const parent: Element = node.parentElement;
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    if (siblings.length === 1) {
      parts.unshift(tag);
    } else {
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    if (node.id) {
      // 路径中途遇到带 id 的祖先，可锚定并提前收束
      parts[0] = `#${cssEscape(node.id)}`;
      break;
    }
    node = parent;
  }
  return parts.join(' > ');
}

/** 最小 CSS.escape 兜底（happy-dom/浏览器有全局 CSS.escape 时优先用之）。 */
function cssEscape(s: string): string {
  const g = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (g?.escape) return g.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
