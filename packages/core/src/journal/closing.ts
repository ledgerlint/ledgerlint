/**
 * 期末结转：把损益类科目的余额转进本年利润（T37）。
 *
 * 三条与 BP2 不同的判断：
 *
 * 1. **结转是"追加一张凭证"，不是"改状态"**。BP2 的做法是标记期间已结账、
 *    并把凭证状态改成 CLOSING；那意味着历史可改。这里只追加，原始凭证一条不动，
 *    哈希链从头到尾可复核。
 *
 * 2. **按"当前余额"结转，因此天然幂等**。结过一次之后 5xxx 余额为 0，
 *    再点就返回 `closed: false`；若结账后又补记了几笔，再结一次只会转走新增的部分。
 *    不需要单独维护"这个期间结过了"的状态表——那种状态表一定会和凭证漂移。
 *
 * 3. **日期落在期间最后一天**，而不是"点结转的那天"。否则 11 月的账被结到 12 月，
 *    期间归属直接错位，而报表明细看上去一切正常。
 *
 * 一个必须讲清的边界：**只结本期发生的损益**，不结"全部未结转余额"。
 * 按余额结转会在"反结账后重结"时把后一个期间的损益一起扫进来，见函数内注释。
 * 代价是上期漏结的损益会一直挂在「未结转损益」上——但那是看得见的，
 * 比悄悄挪走安全。
 */
import { entryLine } from '../lines';
import { periodRange } from '../money';
import { sweepsPnl } from '../reports';
import type { Cents, JournalLine } from '../types';
import { nextVoucherNo, post, VOUCHER_KIND } from '../voucher';
import { balances } from '../ledger';
import { createJournal } from './io';
import { markClosed, markReopened, periodState } from './periods';
import { reverseVoucher } from './reverse';

export interface ClosingResult {
  /** 是否真的生成了结转凭证。余额已为 0 时为 `false`（幂等）。 */
  readonly closed: boolean;
  readonly periodId: string;
  /** 结转到本年利润的净额：正表示盈利，负表示亏损。 */
  readonly amountCents: Cents;
  readonly voucherId: string | null;
  readonly voucherNo: string | null;
}

/**
 * 结转一个期间的损益。
 *
 * @param period `YYYY-MM`
 */
export async function closePeriod(rootDir: string, period: string): Promise<ClosingResult> {
  // 先校验期间格式：`periodRange` 会在非法输入上抛，且它同时给出期末日期。
  const { end } = periodRange(period);

  const journal = await createJournal(rootDir);
  const vouchers = [];
  for await (const voucher of journal.readAll()) vouchers.push(voucher);

  /**
   * 已经结过账（且没反结账）就直接返回，**不能靠"余额为 0"来判断幂等**。
   *
   * 因为下面改成按「本期发生额」结转了：原始凭证一直都在，
   * 本期发生额永远是那个数，结一百次都会再结一遍。
   */
  if ((await periodState(rootDir, period)).closed) {
    return { closed: false, periodId: period, amountCents: 0, voucherId: null, voucherNo: null };
  }

  /**
   * **只结本期发生的损益，不结全部未结转余额。**
   *
   * 按"当前余额"结转看似更彻底（能保证结平），但它有一个致命的副作用：
   * 11 月反结账后重结时，12 月已经记好的损益也在余额里，会被一起扫进 11 月的结转凭证。
   * 结果是 12 月没得结、11 月的利润凭空多了 12 月那部分，而两张表都还是平的。
   *
   * 按"本期凭证产生的损益"算，期间之间就互不影响；上期漏结只会让 `未结转损益`
   * 一直挂着，而那是显形的，比悄悄挪走安全。
   */
  const periodVouchers = vouchers.filter((voucher) => voucher.periodId === period && !sweepsPnl(voucher));
  const pnl = [...balances(periodVouchers).values()].filter(
    (entry) => entry.code.startsWith('5') && entry.netDebitCents !== 0,
  );

  if (pnl.length === 0) {
    return { closed: false, periodId: period, amountCents: 0, voucherId: null, voucherNo: null };
  }

  const lines: JournalLine[] = [];
  // 贷方为正的净额。收入科目余额在贷方（netDebit < 0），要借记它转平，利润增加。
  let profit = 0;
  for (const entry of pnl) {
    const net = entry.netDebitCents;
    if (net > 0) {
      // 费用类：贷记该科目转平
      lines.push(entryLine(entry.code, 'CREDIT', net));
      profit -= net;
    } else {
      // 收入类：借记该科目转平
      lines.push(entryLine(entry.code, 'DEBIT', -net));
      profit -= net;
    }
  }
  if (profit > 0) lines.push(entryLine('3103', 'CREDIT', profit));
  else if (profit < 0) lines.push(entryLine('3103', 'DEBIT', -profit));

  const voucherNo = nextVoucherNo(vouchers, period);
  const body = post({
    voucherId: `c-${period}-${Date.now().toString(36)}`,
    voucherDate: end,
    summary: `结转 ${period} 损益`,
    voucherNo,
    lines,
    source: 'MANUAL',
    ruleSnapshot: { KIND: VOUCHER_KIND.CLOSING },
  });

  await journal.append(period, body);
  // 先落凭证、再上锁。反过来的话，写凭证失败会留下"锁了但没结"的期间，
  // 用户既进不去也出不来。
  await markClosed(rootDir, period, body.voucherId);

  return {
    closed: true,
    periodId: period,
    amountCents: profit,
    voucherId: body.voucherId,
    voucherNo,
  };
}

export interface ReopenResult {
  readonly periodId: string;
  /** 被红冲的结转凭证；期间从未真正结转时为 `null`。 */
  readonly reversedVoucherId: string | null;
  readonly reversedVoucherNo: string | null;
}

/**
 * 反结账：解锁期间，并把当初那张结转凭证红冲掉。
 *
 * 顺序不能换：**先解锁、再红冲**。红冲本身也是一张凭证，会被锁期闸门拦住；
 * 反过来先红冲就成了死循环。
 *
 * 如果红冲失败（比如结转凭证已被红冲过），期间已经解锁、结转还在账上——
 * 这不是数据损坏，用户再点一次结转就会按当前余额重新结平。所以不回滚，只把错抛出去。
 */
export async function reopenPeriod(
  rootDir: string,
  period: string,
  reason: string,
): Promise<ReopenResult> {
  const state = await periodState(rootDir, period);
  if (!state.closed) {
    throw new Error(`期间 ${period} 没有结账，不需要反结账。`);
  }

  await markReopened(rootDir, period, reason);

  if (state.closingVoucherId === null) {
    return { periodId: period, reversedVoucherId: null, reversedVoucherNo: null };
  }

  const reversed = await reverseVoucher(rootDir, state.closingVoucherId, `反结账 ${period}：${reason}`);
  return { periodId: period, reversedVoucherId: reversed.voucherId, reversedVoucherNo: reversed.voucherNo };
}
