/**
 * 把「一行银行流水」适配成账务侧的交易模型（T13）。
 *
 * 为什么要多这一层，而不是让解析器直接产出 `Transaction`：
 * 解析器只该知道"这列是什么"，不该知道"这笔钱记在哪个账户、属于哪个账套导入的"。
 * 后者是账务语义，随账套变；前者只随银行导出的格式变。
 *
 * `txnId` 用 `sourceHash + rowNo` 生成而不是随机：**同一份文件重导必须得到同一批 ID**，
 * 否则"这笔已经确认过了"就无从判断，用户会看到同一笔钱被反复要求确认。
 */
import { createHash } from 'node:crypto';
import type { MoneyAccountCode, Transaction } from '@ledgerlint/core';
import type { ParseReport } from './types';

/** 文件内容哈希。它同时承担两个职责：去重的前提、以及回答"这份文件我导过没有"。 */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface AdaptOptions {
  /** 这笔流水对应的资金账户：1001 现金 / 1002 银行存款 / 1012 其他货币资金 */
  readonly account: MoneyAccountCode;
  readonly sourceHash: string;
}

export function toTransactions(report: ParseReport, options: AdaptOptions): Transaction[] {
  return report.txns.map((txn) => ({
    txnId: createHash('sha1').update(`${options.sourceHash}:${txn.rowNo}`).digest('hex').slice(0, 16),
    sourceHash: options.sourceHash,
    rowNo: txn.rowNo,
    date: txn.date,
    direction: txn.direction,
    amountCents: txn.amountCents,
    balanceCents: txn.balanceCents,
    counterparty: txn.counterparty,
    // `exactOptionalPropertyTypes` 下「没有这个字段」与「字段是 undefined」是两件事，
    // 而这里必须表达前者：没有对方账号，就是银行导出里没有这一列。
    ...(txn.counterpartyAccount === undefined ? {} : { counterpartyAccount: txn.counterpartyAccount }),
    summary: txn.summary,
    ...(txn.serialNo === undefined ? {} : { serialNo: txn.serialNo }),
    fingerprint: txn.fingerprint,
    account: options.account,
  }));
}
