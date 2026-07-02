import { describe, it, expect } from 'vitest';
import { parseContract, parseContractWithElements } from '../../src/contract/parseContract';
import { inferContract } from '../../src/contract/inferContract';

// 真实复杂系统（微前端/嵌入组件）把契约埋在 shadow DOM 和同源 iframe 里——解析必须穿透。
describe('契约解析穿透 shadow DOM / 同源 iframe', () => {
  it('open shadow root 里的契约标记被解析', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const sr = document.getElementById('host')!.attachShadow({ mode: 'open' });
    sr.innerHTML =
      '<div data-agent-object="widget:1">嵌入组件</div>' +
      '<button data-agent-action="ping">Ping</button>';
    const snap = parseContract(document.body, '/p');
    expect(snap.objects.map((o) => o.ref.id)).toContain('object:widget:1');
    expect(snap.actions.map((a) => a.name)).toContain('ping');
  });

  it('嵌套 shadow（shadow 里的 shadow）也穿透', () => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = document.getElementById('outer')!.attachShadow({ mode: 'open' });
    outer.innerHTML = '<div id="inner"></div>';
    const inner = outer.querySelector('#inner')!.attachShadow({ mode: 'open' });
    inner.innerHTML = '<section data-agent-surface="deep">两层深</section>';
    const snap = parseContract(document.body, '/p');
    expect(snap.surfaces.map((s) => s.name)).toContain('deep');
  });

  it('closed shadow root 不可及（如实不解析，不报错）', () => {
    document.body.innerHTML = '<div id="c"></div><button data-agent-action="outside">外</button>';
    const cs = document.getElementById('c')!.attachShadow({ mode: 'closed' });
    cs.innerHTML = '<button data-agent-action="hidden">内</button>';
    const snap = parseContract(document.body, '/p');
    expect(snap.actions.map((a) => a.name)).toEqual(['outside']);
  });

  it('同源 iframe 里的契约被解析', () => {
    document.body.innerHTML = '<iframe id="fr"></iframe>';
    const fr = document.getElementById('fr') as HTMLIFrameElement;
    fr.contentDocument!.body.innerHTML = '<input data-agent-control="amount" value="7" />';
    const snap = parseContract(document.body, '/p');
    const ctrl = snap.controls.find((c) => c.name === 'amount');
    expect(ctrl?.value).toBe('7');
  });

  it('parseContractWithElements 把 shadow 内元素绑进 element 映射（可点击）', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const sr = document.getElementById('host')!.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button data-agent-action="go">Go</button>';
    const { snapshot, elements } = parseContractWithElements(document.body, '/p');
    const ref = snapshot.actions.find((a) => a.name === 'go')?.ref.id;
    expect(ref).toBeTruthy();
    expect(elements.get(ref!)?.textContent).toBe('Go');
  });

  it('parseVoix 的 <tool> 埋在 shadow 里也被解析', async () => {
    const { parseVoix } = await import('../../src/contract/voix');
    document.body.innerHTML = '<div id="host"></div>';
    const sr = document.getElementById('host')!.attachShadow({ mode: 'open' });
    sr.innerHTML = '<tool name="add_task" description="新增任务"></tool>';
    const snap = parseVoix(document.body, '/p');
    expect(snap.actions.map((a) => a.name)).toContain('add_task');
  });

  it('inferContract 同样穿透 shadow', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const sr = document.getElementById('host')!.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button>提交订单</button>';
    const { snapshot } = inferContract(document.body, '/p');
    expect(snapshot.actions.some((a) => a.label === '提交订单')).toBe(true);
  });
});
