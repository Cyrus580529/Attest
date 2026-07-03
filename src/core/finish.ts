import type { LedgerEntry, Outcome } from '../honesty/types';
import { Ledger } from '../honesty/ledger';
import { computeOutcome } from '../honesty/ledger';
import { applyClaim, type FinishClaim } from '../honesty/narrationGuard';
import type { Recipe } from '../memory/recipeBook';
import type { AgentStep, FinishFacts } from './loopTypes';

const WRITE_TOOL_NAMES = new Set(['setControl', 'invokeAction']);

/**
 * 执行事实的权威版本，由账本硬生成——叙述层的 verify-or-refuse。
 * 不计算 outcome（读循环/程序模式各有规则，红线：判定逻辑不因叙述改动），只吃算好的结果。
 */
export function buildFacts(entries: readonly LedgerEntry[], outcome: Outcome): FinishFacts {
  const verified: FinishFacts['verified'] = [];
  const unverified: FinishFacts['unverified'] = [];
  const cancelled: FinishFacts['cancelled'] = [];
  const writeErrors: FinishFacts['writeErrors'] = [];
  const clarifications: FinishFacts['clarifications'] = [];
  const intentLabels = new Map<string, string>();

  for (const e of entries) {
    if (e.kind === 'intent') intentLabels.set(e.refId, e.label);
    else if (e.kind === 'write') {
      if (e.verified) verified.push({ tool: e.tool, refId: e.refId, evidence: e.evidence });
      else unverified.push({ tool: e.tool, refId: e.refId });
    } else if (e.kind === 'grant' && !e.approved) {
      cancelled.push({ refId: e.refId, label: intentLabels.get(e.refId) });
    } else if (e.kind === 'clarify') {
      clarifications.push({ question: e.question, answered: e.answered });
    } else if (e.kind === 'error' && WRITE_TOOL_NAMES.has(e.tool)) {
      writeErrors.push({ tool: e.tool, detail: e.detail });
    }
  }

  const lines: string[] = [];
  if (verified.length > 0) lines.push(`成功执行并验证 ${verified.length} 个动作`);
  if (cancelled.length > 0) lines.push(`${cancelled.length} 个高风险操作未获确认、未执行`);
  if (unverified.length > 0)
    lines.push(`${unverified.length} 个动作未能确认完成（执行后未检测到可观察变化，≠失败）`);
  if (writeErrors.length > 0) lines.push(`${writeErrors.length} 个写操作出错未执行`);
  if (clarifications.length > 0) {
    const unanswered = clarifications.filter((c) => !c.answered).length;
    lines.push(
      `向用户提出 ${clarifications.length} 个澄清` + (unanswered > 0 ? `（其中 ${unanswered} 个未获答复）` : ''),
    );
  }

  const summary =
    entries.length === 0
      ? '没有执行任何动作，以上仅为直接作答'
      : lines.length > 0
        ? lines.join('；')
        : '仅读取了页面，未执行写操作';

  return { outcome, verified, unverified, cancelled, writeErrors, clarifications, summary };
}

/** answer 兼容拼接：narration（模型原话，在前）+ 执行记录（账本生成，在后）。 */
function composeAnswer(narration: string, facts: FinishFacts): string {
  const record = `（执行记录：${facts.summary}。）`;
  return narration ? `${narration}\n${record}` : record;
}

/** 读循环收尾：outcome 由账本算 + 自评只降不升；facts 由账本生成；narration 一字不改。 */
export function finishStep(narration: string, ledger: Ledger, claim?: FinishClaim): AgentStep {
  const outcome = applyClaim(computeOutcome(ledger.entries), claim);
  const facts = buildFacts(ledger.entries, outcome);
  const text = narration.trim();
  return {
    type: 'finish',
    facts,
    narration: text,
    answer: composeAnswer(text, facts),
    outcome,
    ledger: ledger.toJSON(),
  };
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
 * 程序模式收尾：outcome 与 facts 全由账本算，绝不替模型自述背书（defense-in-depth）。
 * - 有成功写但也有被拒授权＝部分完成 → outcome=partial（堵“部分取消却报全部完成”的谎报）。
 * - 空账本＝这回合没经任何工具干活 → facts.summary 明示“没有执行任何动作”（堵空账本谎报）。
 */
export function programFinish(ledger: Ledger, narration: string, aborted = false, claim?: FinishClaim): AgentStep {
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
  // 自评降级（只降不升）：partial/cancelled 已含更精确原因，不覆盖。
  // 连带守住配方库：outcome≠completed 的程序不会被录成"成功配方"（调用方按 outcome 把关）。
  outcome = applyClaim(outcome, claim);

  const facts = buildFacts(entries, outcome);
  const text = narration.trim();
  return {
    type: 'finish',
    facts,
    narration: text,
    answer: composeAnswer(text, facts),
    outcome,
    ledger: ledger.toJSON(),
  };
}
