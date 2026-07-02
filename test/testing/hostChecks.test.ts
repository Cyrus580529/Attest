import { describe, it, expect } from 'vitest';
import { checkHostContract } from '../../src/testing/hostChecks';
import { FakeHostAdapter } from '../../src/testing/fakeHostAdapter';
import { createDomHostAdapter } from '../../src/adapters/domHostAdapter';
import { parseContract } from '../../src/contract/parseContract';
import type { HostAdapter } from '../../src/host/types';

const PAGE =
  '<div data-agent-object="task:1">任务一</div>' +
  '<button data-agent-action="ping">Ping</button>' +
  '<input data-agent-control="amount" value="0" />' +
  '<section data-agent-surface="status">就绪</section>';

describe('checkHostContract——第三方 HostAdapter 合规检查器', () => {
  it('合规宿主（FakeHost）：只读检查全过', async () => {
    document.body.innerHTML = PAGE;
    const host = new FakeHostAdapter(parseContract(document.body, '/p'));
    const results = await checkHostContract(host);
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results.filter((r) => !r.pass)).toEqual([]);
  });

  it('合规宿主（DomHost）+ mutating：setControl 效果可观察检查过', async () => {
    document.body.innerHTML = PAGE;
    const host = createDomHostAdapter({ getUrl: () => '/p' });
    const results = await checkHostContract(host, { mutating: true, probeValue: '42' });
    const set = results.find((r) => r.name === 'set-control-observable');
    expect(set?.pass).toBe(true);
    expect(results.filter((r) => !r.pass)).toEqual([]);
  });

  it('违约①：快照 ref 不稳定 → snapshot-repeatable 不过', async () => {
    document.body.innerHTML = PAGE;
    let n = 0;
    const base = new FakeHostAdapter(parseContract(document.body, '/p'));
    const flaky: HostAdapter = {
      ...base,
      snapshot: () => {
        n += 1; // 每照一次换一套 id——内核的 ref 绑定会全失效
        document.body.innerHTML = `<div data-agent-object="task:${n}">任务</div>`;
        return parseContract(document.body, '/p');
      },
      readSurface: (r) => base.readSurface(r),
    };
    const results = await checkHostContract(flaky);
    expect(results.find((r) => r.name === 'snapshot-repeatable')?.pass).toBe(false);
  });

  it('违约②：readSurface 抛异常 → read-surface 不过（检查器不炸）', async () => {
    document.body.innerHTML = PAGE;
    const base = new FakeHostAdapter(parseContract(document.body, '/p'));
    const broken: HostAdapter = {
      snapshot: () => base.snapshot(),
      readSurface: () => { throw new Error('boom'); },
      openObject: (r) => base.openObject(r),
      navigate: (r) => base.navigate(r),
      setControl: (r, v) => base.setControl(r, v),
      invokeAction: (r) => base.invokeAction(r),
    };
    const results = await checkHostContract(broken);
    expect(results.find((r) => r.name === 'read-surface')?.pass).toBe(false);
  });

  it('违约③：写后新快照不反映控件值 → set-control-observable 不过', async () => {
    document.body.innerHTML = PAGE;
    const frozen = parseContract(document.body, '/p'); // 永远返回旧快照——效果不可观察
    const stale: HostAdapter = {
      snapshot: () => frozen,
      readSurface: () => '',
      openObject: async () => ({ ok: true, snapshot: frozen }),
      navigate: async () => ({ ok: true, snapshot: frozen }),
      setControl: async () => ({ ok: true, snapshot: frozen }),
      invokeAction: async () => ({ ok: true, snapshot: frozen }),
    };
    const results = await checkHostContract(stale, { mutating: true, probeValue: '42' });
    expect(results.find((r) => r.name === 'set-control-observable')?.pass).toBe(false);
  });
});
