/**
 * 规则层的类型（T21）。
 *
 * 规则是**数据 + 判定函数**，不是一串 if。这样 v0.2 把规则迁到 YAML 时，
 * 引擎不用改一行——引擎只认 `Rule[]`，不认规则从哪来。
 */
import type { EventKey, JournalLine, Transaction } from '../types';

export interface RuleContext {
  /** 征收率：小规模 1% 或 3%。做价税分离时用，不在这里判断"该不该交税"。 */
  readonly vatRate: number;
  /** 股东名单。用于区分「股东借款」与「客户回款」——两者都是进账，科目完全不同。 */
  readonly shareholders: readonly string[];
}

export interface DraftBody {
  readonly lines: readonly JournalLine[];
  /** 一句人话，给零财务知识的人看。**必须包含"谁 + 做了什么"**，不能只写"收款"。 */
  readonly oneLiner: string;
  /** 凭证摘要（≤40 字）。与 oneLiner 分开：摘要进凭证、进哈希；人话只用于界面。 */
  readonly summary: string;
  /** 我猜的。空数组 = 没有猜。非空时界面必须显示。 */
  readonly assumed: readonly string[];
  readonly confidence: 'HIGH' | 'LOW';
}

export interface Rule {
  readonly id: string;
  readonly version: string;
  readonly event: EventKey;
  /** 命中判定。只看业务事实（方向、金额、对方、摘要），不看科目。 */
  match(txn: Transaction, ctx: RuleContext): boolean;
  build(txn: Transaction, ctx: RuleContext): DraftBody;
}

/** 一条待确认的草稿。落 `drafts/*.jsonl`，确认后才变成凭证。 */
export interface Draft {
  readonly draftId: string;
  readonly event: EventKey;
  readonly confidence: 'HIGH' | 'LOW';
  readonly oneLiner: string;
  readonly summary: string;
  readonly assumed: readonly string[];
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly lines: readonly JournalLine[];
  /** 原始流水，供界面显示"这笔是哪来的"。 */
  readonly txn: Transaction;
}
