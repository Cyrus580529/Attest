import type { LedgerEntry, Outcome } from '../honesty/types';
import { Ledger } from '../honesty/ledger';
import { guardFinish, type FinishClaim } from '../honesty/narrationGuard';
import type { Recipe } from '../memory/recipeBook';
import type { AgentStep } from './loopTypes';

/** 读循环收尾：用 narrationGuard 按账本守卫 answer/outcome，绝不替模型自述背书。 */
export function finishStep(answer: string, ledger: Ledger, claim?: FinishClaim): AgentStep {
  const guarded = guardFinish(answer.trim(), ledger.entries, claim);
  return { type: 'finish', answer: guarded.answer, outcome: guarded.outcome, ledger: ledger.toJSON() };
}

/** 从证据账本拼出“真实发生了什么”的事实陈述，喂给复盘回合（不可被模型篡改）。 */
export function factualLedgerSummary(entries: readonly LedgerEntry[]): string {
  const opens = entries.filter((e) => e.kind === 'observe' && e.tool === 'openObject').length;
  const verified = entries.filter((e) => e.kind === 'write' && e.verified).length;
  const unverified = entries.filter((e) => e.kind === 'write' && !e.verified).length;
  const cancelled = entries.filter((e) => e.kind === 'grant' && !e.approved).length;
  const lines: string[] = [];
  if (opens > 0) lines.push(`打开/查看了 ${opens} 个对象`);
  if (verified > 0) lines.push(`成功执行并验证了 ${verified} 个动作`);
  if (cancelled > 0) lines.push(`有 ${cancelled} 个高危动作被用户取消、未执行`);
  if (unverified > 0) lines.push(`有 ${unverified} 个动作执行后未检测到页面变化（未验证）`);
  return lines.length > 0 ? lines.join('；') : '没有执行任何动作';
}

export interface DigestOptions {
  maxItems?: number;
  maxCharsPerItem?: number;
}

/**
 * 关键观察原文摘录：从账本抽最近的读观察（readSurface/openObject 的 detail 原文），
 * 按内容去重、每条截断、总数封顶。用于上下文压缩——只留计数会让模型忘掉看过的关键内容，
 * 这里把「看到了什么」的原文（有界地）保住，比纯计数摘要忠实得多。
 */
export function observationDigest(entries: readonly LedgerEntry[], opts: DigestOptions = {}): string {
  const maxItems = opts.maxItems ?? 6;
  const maxChars = opts.maxCharsPerItem ?? 300;
  const seen = new Set<string>();
  const items: string[] = [];
  for (let i = entries.length - 1; i >= 0 && items.length < maxItems; i--) {
    const e = entries[i];
    if (!e || e.kind !== 'observe' || (e.tool !== 'readSurface' && e.tool !== 'openObject')) continue;
    const text = e.detail.replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue; // 同内容(如重复读同一 surface)只留一次
    seen.add(text);
    items.unshift(`- ${e.tool}: ${text.length > maxChars ? text.slice(0, maxChars) + '…' : text}`);
  }
  return items.length > 0 ? `关键观察（原文摘录）：\n${items.join('\n')}` : '';
}

/** 把召回的配方拼成给模型的先验块：目标标签 + 可再发的紧凑 JSON 程序（吻合与否由模型判断）。 */
export function formatRecipes(recipes: Recipe[]): string {
  const blocks = recipes.map(
    (r, i) => `配方${i + 1}（曾用于「${r.goal}」）：\n${JSON.stringify(r.program)}`,
  );
  return `本页面上，以下程序曾被验证成功——可参考、改写或弃用，请自行判断是否吻合当前任务：\n${blocks.join('\n\n')}`;
}

/**
 * 程序模式收尾：outcome 与证据小结全由账本算，绝不替模型自述背书（defense-in-depth）。
 * - 空账本＝这回合没经任何工具干活 → 加注“未执行任何动作”（堵空账本谎报）。
 * - 有成功写但也有被拒授权＝部分完成 → outcome=partial（堵“部分取消却报全部完成”的谎报）。
 */
export function programFinish(ledger: Ledger, answer: string, aborted = false, claim?: FinishClaim): AgentStep {
  const entries = ledger.entries;
  const verified = entries.filter((e) => e.kind === 'write' && e.verified).length;
  const unverified = entries.filter((e) => e.kind === 'write' && !e.verified).length;
  const cancelled = entries.filter((e) => e.kind === 'grant' && !e.approved).length;

  let outcome: Outcome;
  if (unverified > 0) outcome = 'failed';
  else if (cancelled > 0 && verified > 0) outcome = 'partial';
  else if (cancelled > 0) outcome = 'cancelled';
  else outcome = 'completed';
  if (aborted && (outcome === 'completed' || outcome === 'partial')) outcome = 'failed';
  // 自评降级（只降不升）：complete 但模型读到页面业务失败 → failed。partial/cancelled 已含更精确原因，不覆盖。
  // 连带守住配方库：outcome≠completed 的程序不会被录成"成功配方"（调用方按 outcome 把关）。
  if (claim?.goalMet === false && outcome === 'completed') outcome = 'failed';

  const notes: string[] = [];
  if (entries.length === 0) {
    notes.push('本回合未经任何工具操作或读取页面，未执行任何动作，以上仅为直接作答；不要据此认为相关任务已完成');
  } else {
    const tally: string[] = [];
    if (verified > 0) tally.push(`成功 ${verified} 项`);
    if (cancelled > 0) tally.push(`取消 ${cancelled} 项`);
    if (unverified > 0) tally.push(`未验证 ${unverified} 项`);
    if (tally.length > 0) notes.push(`实际：${tally.join('·')}`);
    if (cancelled > 0) notes.push('有动作被你取消，未全部完成');
  }
  const finalAnswer = notes.length > 0 ? `${answer}\n（注意：${notes.join('；')}。）`.trim() : answer;
  return { type: 'finish', answer: finalAnswer, outcome, ledger: ledger.toJSON() };
}
