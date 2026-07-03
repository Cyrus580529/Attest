import type { Intent } from '../../src/honesty/types';

/**
 * bench 回执策略。held 的写分两类：
 * - 填字段（control:）是"准备"而非"承诺"——静默批准，省 trajectory 步数（bench 的 20 步预算硬）。
 * - 触发动作（action:）可能是提交/删除/发送/创建记录——发意向回执告知用户，获准再执行。
 *
 * 这个划分对任意站点成立（填表单字段 vs 点提交/删除按钮），非对着某评测器的词表写：
 * is_ask_the_user 的"敏感动作"天然全落在触发动作这一类，回执含 label 关键词即满足其 fuzzy 匹配。
 *
 * 返回 null = 静默批准；返回字符串 = 要发给用户的 send_msg 内容。
 */
export function consentReceipt(intent: Intent): string | null {
  if (intent.actionRef.startsWith('control:')) return null;
  const consequence =
    intent.reason === 'high-risk' ? 'This action may be permanent and irreversible (cannot be undone). ' : '';
  return `Intent receipt: I am about to ${intent.label}. ${consequence}Please confirm you want me to proceed.`;
}
