// 骑 VOIX 契约（arXiv 2511.11287）：页面用 <tool>/<context> 声明能力，Attest 补上它明确不做的
// 三样——outcome 验证、信任、契约漂移。此处只做「VOIX 声明 → PageSnapshot」的解析（无参 tool + context）。
// VOIX 带参 tool（→ action + args）留待后续切片，那时才动 invokeAction 签名。
import type { ActionNode, PageSnapshot, Risk, SurfaceNode } from '../types';
import { RefMinter } from './refs';

// 保守风险启发式：VOIX 不定义 risk，危险动词→high（Attest 据此 held）。可被显式 risk="high" 覆盖。
const HIGH_RISK = /delete|remove|destroy|删除|删|清空|移除|pay|支付|purchase|checkout|confirm|确认|submit|提交|发送|send|ship|发布|deploy/i;

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** VOIX 页面 → PageSnapshot：<tool>→action（authored），<context>→surface。 */
export function parseVoix(root: ParentNode, url: string): PageSnapshot {
  const minter = new RefMinter();

  const actions: ActionNode[] = [];
  for (const el of root.querySelectorAll('tool')) {
    const name = clean(el.getAttribute('name'));
    if (!name) continue; // 无 name 无从引用，跳过
    const description = clean(el.getAttribute('description')) || name;
    const risk: Risk =
      el.getAttribute('risk') === 'high' || HIGH_RISK.test(`${name} ${description}`) ? 'high' : 'low';
    actions.push({ ref: minter.mint('action', name), name, label: description, risk, provenance: 'authored' });
  }

  const surfaces: SurfaceNode[] = [];
  for (const el of root.querySelectorAll('context')) {
    const name = clean(el.getAttribute('name')) || 'context';
    surfaces.push({ ref: minter.mint('surface', name), name, text: clean(el.textContent), provenance: 'authored' });
  }

  // VOIX 无「对象列表」「表单控件」概念，故 objects/controls 为空——内核照常工作。
  return { url, objects: [], actions, controls: [], surfaces };
}
