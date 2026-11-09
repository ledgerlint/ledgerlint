/**
 * 建账：期初余额（T36）。
 *
 * **期初不是一张"余额表"，是一张借贷必须平的凭证。**
 *
 * 这是与 BP2 最大的分歧。BP2 把期初存成独立的表（`opening-grid` → 期初凭证），
 * 报表要同时合并两处数据源；于是"期初表说 10 万、凭证说 8 万"这种分裂迟早出现，
 * 而它没有任何一条校验能发现。这里只有一条规矩：**期初就是一个普通凭证**，
 * 只是打了个 `KIND: OPENING` 的记号。余额、试算、报表、哈希链全部自动兼容。
 *
 * 三条硬约束：
 *
 * 1. **不能有损益类科目**。期初是"某一天的家底"，家底里不可能有"本年收入"——
 *    收入是期间内发生的。允许挂 5xxx 等于允许把利润直接塞进期初，
 *    而利润表的本年累计会凭空多一块，且借方贷方照样平。
 * 2. **只能有一张**。第二张期初会让余额直接翻倍，而账本看起来完全正常。
 * 3. **日期必须早于账本里最早的凭证**。晚于它就不叫期初了，叫"中途调账"——
 *    而中途调账应该走红冲或损益调整，不该伪装成期初。
 */
import { randomBytes } from 'node:crypto';
import { isPnlAccount } from '../accounts';
import { entryLine } from '../lines';
import { parseYuan, periodOf } from '../money';
import type { Cents } from '../types';
import { isOpeningVoucher, nextVoucherNo, post, VOUCHER_KIND } from '../voucher';
import { createJournal } from './io';

/** 期初的一行。金额是**人输入的元字符串**，解析只发生在 `parseYuan`。 */
export interface OpeningLineInput {
  readonly accountCode: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: string;
  readonly counterparty?: string;
}

export interface OpeningInput {
  readonly voucherDate: string;
  readonly lines: readonly OpeningLineInput[];
}

export interface OpeningResult {
  readonly voucherId: string;
  readonly voucherNo: string;
  readonly periodId: string;
  readonly hash: string;
  /** 借方合计，也是"建账时公司的资产总额"。 */
  readonly totalDebitCents: Cents;
}

function makeOpeningId(): string {
  return `o-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export async function postOpeningVoucher(rootDir: string, input: OpeningInput): Promise<OpeningResult> {
  if (input.lines.length < 2) {
    throw new Error('期初至少要两行：左边是资产，右边是这些资产从哪来的（负债或所有者权益）。');
  }

  for (const line of input.lines) {
    if (isPnlAccount(line.accountCode)) {
      throw new Error(
        `期初不能有损益类科目（${line.accountCode}）。期初记的是某一天的家底，收入费用是期间内发生的。`,
      );
    }
  }

  const journal = await createJournal(rootDir);
  const existing: { voucherDate: string; periodId: string; voucherNo: string }[] = [];
  for await (const voucher of journal.readAll()) {
    existing.push(voucher);
    if (isOpeningVoucher(voucher)) {
      throw new Error('这个账本已经有期初了。要改期初，先红冲原来那张期初凭证，再重新建。');
    }
  }

  const earliest = existing.reduce<string>(
    (min, voucher) => (voucher.voucherDate < min ? voucher.voucherDate : min),
    '9999-12-31',
  );
  if (existing.length > 0 && input.voucherDate > earliest) {
    throw new Error(
      `期初日期必须早于账本里最早的凭证（${earliest}）。晚于它就不是期初，是中途调账——那应该走红冲，不该伪装成期初。`,
    );
  }

  const lines = input.lines.map((line, index) => {
    const cents = parseYuan(line.amount);
    if (cents <= 0) throw new Error(`第 ${index + 1} 行金额必须大于 0（方向用借/贷表示，不要用负号）。`);
    const counterparty = line.counterparty?.trim();
    return entryLine(line.accountCode, line.direction, cents, counterparty ? { counterparty } : {});
  });

  const period = periodOf(input.voucherDate);
  const voucherNo = nextVoucherNo(existing, period);
  const body = post({
    voucherId: makeOpeningId(),
    voucherDate: input.voucherDate,
    summary: '期初余额',
    voucherNo,
    lines,
    source: 'MANUAL',
    ruleSnapshot: { KIND: VOUCHER_KIND.OPENING },
  });

  const { hash } = await journal.append(period, body);

  return {
    voucherId: body.voucherId,
    voucherNo,
    periodId: period,
    hash,
    totalDebitCents: body.totalDebitCents,
  };
}
