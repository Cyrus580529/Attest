/**
 * 深遍历：穿透 open shadow root 与同源 iframe 的 querySelectorAll。
 * 真实复杂系统（微前端/嵌入组件/富文本编辑器）常把可交互结构埋在 shadow/iframe 里，
 * 契约解析若只扫 light DOM 会漏。边界如实：closed shadow 不可及；跨域 iframe 拿不到
 * contentDocument（抛异常或 null）——跳过，不假装能看见。
 */

/** 收集 root 及其下所有可及的解析作用域（root 本身、open shadow root、同源 iframe body）。 */
export function collectScopes(root: ParentNode): ParentNode[] {
  const scopes: ParentNode[] = [root];
  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];
    if (!scope) continue;
    for (const el of scope.querySelectorAll('*')) {
      const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) scopes.push(shadow);
      if (el.tagName === 'IFRAME') {
        try {
          const doc = (el as HTMLIFrameElement).contentDocument;
          if (doc?.body) scopes.push(doc.body);
        } catch {
          // 跨域 iframe：同源策略拦截，不可及即不解析
        }
      }
    }
  }
  return scopes;
}

/** 跨作用域 querySelectorAll：外层文档序在前，随后按宿主出现顺序附上各 shadow/iframe 内的命中。 */
export function queryAllDeep(root: ParentNode, selector: string, scopes?: ParentNode[]): Element[] {
  const out: Element[] = [];
  for (const scope of scopes ?? collectScopes(root)) {
    out.push(...scope.querySelectorAll(selector));
  }
  return out;
}
