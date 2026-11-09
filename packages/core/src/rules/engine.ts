/**
 * 规则引擎（T21）。
 *
 * 引擎只做三件事：按顺序试规则、命中的交给规则自己产出分录、都不命中就落 `E99`。
 *
 * **`E99` 的草稿没有分录**，这是刻意的。给它编两条分录（比如"其他应收/其他应付"）
 * 会让待处理清单看起来像已经处理完了——而用户最需要看到的恰恰是"这条我认不出来"。
 */
import type { EventKey, JournalLine, Transaction } from '../types';
import type { Draft, Rule, RuleContext } from './types';

const FALLBACK_ID = 'unmatched';
const FALLBACK_VERSION = 'v1';

const EMPTY_LINES: readonly JournalLine[] = [];

/**
 * 未识别。**没有分录**，也不猜科目。
 *
 * 它的价值在两个地方：①用户能看到"这一笔需要我判断"；②覆盖率统计有分母——
 * 一条落进 `E99` 的流水和一条"根本没导进来"的流水，是完全不同的两件事。
 */
export function unmatchedDraft(txn: Transaction): Draft {
  const event: EventKey = 'E99';
  return {
    draftId: `d-${txn.txnId}`,
    event,
    confidence: 'LOW',
    oneLiner: `${txn.direction === 'IN' ? '收到' : '支付'} ${txn.counterparty || '不明对方'} 的一笔款，我没认出它是什么业务`,
    summary: truncate(`${txn.summary || '未识别流水'}（待判断）`),
    assumed: ['未生成分录：需要你告诉系统这笔钱是什么'],
    ruleId: FALLBACK_ID,
    ruleVersion: FALLBACK_VERSION,
    lines: EMPTY_LINES,
    txn,
  };
}

/** 摘要上限 40 字（D004）。在生成侧就截断，不要等到 `post()` 才失败。 */
export function truncate(text: string, max = 40): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function toDraft(rule: Rule, txn: Transaction, ctx: RuleContext): Draft {
  const body = rule.build(txn, ctx);
  return {
    draftId: `d-${txn.txnId}`,
    event: rule.event,
    confidence: body.confidence,
    oneLiner: body.oneLiner,
    summary: truncate(body.summary),
    assumed: body.assumed,
    ruleId: rule.id,
    ruleVersion: rule.version,
    lines: body.lines,
    txn,
  };
}

/** 按顺序试规则，第一条命中即用。顺序即优先级：股东相关的规则必须排在客户收款之前。 */
export function classify(
  txn: Transaction,
  ctx: RuleContext,
  rules: readonly Rule[],
): Draft {
  for (const rule of rules) {
    if (rule.match(txn, ctx)) return toDraft(rule, txn, ctx);
  }
  return unmatchedDraft(txn);
}

export function classifyAll(
  txns: readonly Transaction[],
  ctx: RuleContext,
  rules: readonly Rule[],
): Draft[] {
  return txns.map((txn) => classify(txn, ctx, rules));
}
