/**
 * 红冲的落盘动作（T39）。纯函数的 `reverse()` 在 `voucher.ts`，这里只负责取号、落链。
 *
 * 两条边界：
 *
 * 1. **红冲记在原凭证的期间**。不记在"发现错误的那天"。
 *    记到别的期间会让两个月的损益同时失真：原月份留着错的、发现月份多出一笔反向的。
 *    代价是已结账期间必须先反结账——但这正是锁期的意义：**要改已定稿的月份，
 *    就得留下"为什么改"的痕迹**。绕过它去下个月冲，等于把错误摊成两个月的噪音。
 *
 * 2. **一张凭证只能冲一次**。再冲一次会把金额反向加回去（等于撤销红冲）。
 *    真要撤销红冲，请红冲那张红冲凭证——这样"撤销"本身也留在链上，
 *    而不是让同一个 `voucherId` 被冲两次却看不出顺序。
 */
import { randomBytes } from 'node:crypto';
import type { PostedVoucher } from '../types';
import { nextVoucherNo, reverse } from '../voucher';
import { createJournal } from './io';

export interface ReverseResult {
  readonly voucherId: string;
  readonly voucherNo: string;
  readonly periodId: string;
  /** 被冲的原凭证。 */
  readonly reverses: string;
}

export async function reverseVoucher(
  rootDir: string,
  voucherId: string,
  reason: string,
): Promise<ReverseResult> {
  const journal = await createJournal(rootDir);
  const vouchers: PostedVoucher[] = [];
  for await (const voucher of journal.readAll()) vouchers.push(voucher);

  const original = vouchers.find((voucher) => voucher.voucherId === voucherId);
  if (original === undefined) {
    throw new Error(`找不到凭证 ${voucherId}。它可能已被删除，或这份账本不是你以为的那一份。`);
  }
  if (vouchers.some((voucher) => voucher.reverses === voucherId)) {
    throw new Error(`凭证 ${original.voucherNo} 已经红冲过了。要撤销这次红冲，请红冲那张红冲凭证。`);
  }

  const period = original.periodId;
  const voucherNo = nextVoucherNo(vouchers, period);
  const body = reverse(original, {
    voucherId: `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    voucherNo,
    // 同期间：日期与原凭证一致，`reverse()` 只要求不早于原日期。
    date: original.voucherDate,
    reason,
  });

  await journal.append(period, body);

  return { voucherId: body.voucherId, voucherNo, periodId: period, reverses: voucherId };
}
