import { describe, it, expect } from 'vitest';
import * as api from '../src/index';

// 守卫公共 API 面：收紧后只暴露库使用者真正需要的入口。
// 改动公共面时本测试会红——提醒这是有意的契约变更，而非误删/误加。
describe('public API surface', () => {
  it('暴露内核与适配器入口', () => {
    for (const name of [
      'parseContract',
      'parseContractWithElements',
      'parseVoix',
      'createDomHostAdapter',
      'createVoixHostAdapter',
      'createOpenAiAdapter',
      'createAgent',
      'serializeSnapshot',
    ] as const) {
      expect(typeof api[name]).toBe('function');
    }
  });

  it('暴露 Code-as-Action / 配方 / 世界模型 / 测试双适配器', () => {
    expect(typeof api.validateProgram).toBe('function');
    expect(typeof api.runProgram).toBe('function');
    expect(typeof api.RecipeBook).toBe('function');
    expect(typeof api.WorldModel).toBe('function');
    expect(typeof api.FakeLlmAdapter).toBe('function');
    expect(typeof api.FakeHostAdapter).toBe('function');
  });

  it('不再泄漏内部管件', () => {
    const leaked = ['RefMinter', 'resolveRef', 'executeWrite', 'summarizeProgram', 'CandidateSet', 'PlanRunner', 'guardFinish', 'diffSnapshots'];
    for (const name of leaked) expect(name in api).toBe(false);
  });
});
