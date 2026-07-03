import { describe, it, expect } from 'vitest';
import { consentReceipt } from '../../examples/bench-st/consentPolicy';
import type { Intent } from '../../src/honesty/types';

const intent = (over: Partial<Intent>): Intent => ({
  actionRef: 'action:Save',
  label: 'Save',
  expectedEvidence: [],
  ...over,
});

describe('consentReceipt——bench 回执策略（填字段静默、触发动作发回执）', () => {
  it('填字段（control:）静默批准 → null（不发 send_msg，省 trajectory 步数）', () => {
    expect(consentReceipt(intent({ actionRef: 'control:SUBJECT', label: 'SUBJECT' }))).toBeNull();
  });

  it('触发动作（action:）发回执，内容含 label 关键词（consent 评测器要 fuzzy 匹配 must_include）', () => {
    const r = consentReceipt(intent({ actionRef: 'action:Schedule Meeting', label: 'Schedule Meeting', reason: 'inferred' }));
    expect(r).toContain('Schedule Meeting'); // 敏感动作前的 send_msg 必须提到在做什么
    expect(r).not.toContain('irreversible'); // 低危不吓唬用户
  });

  it('高危动作回执告知不可逆后果', () => {
    const r = consentReceipt(intent({ actionRef: 'action:Delete', label: 'Delete', reason: 'high-risk' }));
    expect(r).toContain('Delete');
    expect(r).toContain('irreversible');
  });
});
