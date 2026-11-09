/**
 * 会计循环测试（T36–T39）：期初 → 业务 → 结转 → 锁期 → 反结账 → 更正。
 *
 * 这一组不是在测函数，是在测**一个账本能不能活过一年**。
 * 每个用例都对应一个"看起来正常、其实已经错了"的场景：
 *
 *   - 结转后利润表归零（最常见的实现错误）
 *   - 结账了还能记账（锁形同虚设）
 *   - 反结账没有痕迹（三个月后没人知道谁解的锁）
 *   - 红冲两次把金额加回去（账反而平了，但数字错了）
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { balanceSheet, incomeStatement } from '../reports';
import type { PostedVoucher } from '../types';
import { closePeriod, reopenPeriod } from './closing';
import { createJournal } from './io';
import { postManualVoucher } from './manual';
import { postOpeningVoucher } from './opening';
import { closedPeriods, isPeriodClosed, periodState, readPeriodEvents } from './periods';
import { reverseVoucher } from './reverse';

async function book(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'll-cycle-'));
}

async function all(dir: string): Promise<PostedVoucher[]> {
  const journal = await createJournal(dir);
  const vouchers: PostedVoucher[] = [];
  for await (const voucher of journal.readAll()) vouchers.push(voucher);
  return vouchers;
}

const OPENING = {
  voucherDate: '2026-10-31',
  lines: [
    { accountCode: '1002', direction: 'DEBIT' as const, amount: '100000' },
    { accountCode: '3001', direction: 'CREDIT' as const, amount: '100000' },
  ],
};

const income = (date: string, amount: string) => ({
  voucherDate: date,
  summary: '收客户项目款',
  lines: [
    { accountCode: '1002', direction: 'DEBIT' as const, amount },
    { accountCode: '5001', direction: 'CREDIT' as const, amount },
  ],
});

const rent = (date: string, amount: string) => ({
  voucherDate: date,
  summary: '付办公室房租',
  lines: [
    { accountCode: '560202', direction: 'DEBIT' as const, amount },
    { accountCode: '1002', direction: 'CREDIT' as const, amount },
  ],
});

describe('期初余额', () => {
  it('期初是一张凭证：进哈希链，余额立刻进报表', async () => {
    const dir = await book();
    const result = await postOpeningVoucher(dir, OPENING);

    expect(result.totalDebitCents).toBe(10000000);
    const vouchers = await all(dir);
    expect(vouchers).toHaveLength(1);
    expect((await (await createJournal(dir)).verify()).ok).toBe(true);

    const sheet = balanceSheet(vouchers);
    expect(sheet.totalAssets).toBe(10000000);
    expect(sheet.totalEquity).toBe(10000000);
    expect(sheet.balanced).toBe(true);
    expect(sheet.complete).toBe(true);
  });

  it('第二张期初被拒：否则余额直接翻倍，而账本看起来完全正常', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await expect(postOpeningVoucher(dir, OPENING)).rejects.toThrow(/已经有期初/);
    expect(await all(dir)).toHaveLength(1);
  });

  it('期初不能有损益类科目：家底里不可能有"本年收入"', async () => {
    const dir = await book();
    await expect(
      postOpeningVoucher(dir, {
        voucherDate: '2026-10-31',
        lines: [
          { accountCode: '1002', direction: 'DEBIT', amount: '100' },
          { accountCode: '5001', direction: 'CREDIT', amount: '100' },
        ],
      }),
    ).rejects.toThrow(/损益类科目/);
  });

  it('期初日期必须早于最早的凭证：晚于它就不是期初，是中途调账', async () => {
    const dir = await book();
    await postManualVoucher(dir, income('2026-11-03', '100'));
    await expect(
      postOpeningVoucher(dir, { ...OPENING, voucherDate: '2026-11-05' }),
    ).rejects.toThrow(/必须早于/);
  });

  it('期初借贷不平被拒（钱从哪来必须说清）', async () => {
    const dir = await book();
    await expect(
      postOpeningVoucher(dir, {
        voucherDate: '2026-10-31',
        lines: [
          { accountCode: '1002', direction: 'DEBIT', amount: '100000' },
          { accountCode: '3001', direction: 'CREDIT', amount: '60000' },
        ],
      }),
    ).rejects.toThrow(/差额/);
  });
});

describe('期末结转', () => {
  it('把损益转进本年利润，5xxx 归零、3103 有余额', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, income('2026-11-03', '30000'));
    await postManualVoucher(dir, rent('2026-11-05', '12000'));

    const result = await closePeriod(dir, '2026-11');
    expect(result.closed).toBe(true);
    expect(result.amountCents).toBe(1800000);

    const vouchers = await all(dir);
    const sheet = balanceSheet(vouchers);
    expect(sheet.unclosedPnl).toBe(0);
    // 100000 实收 + 18000 利润
    expect(sheet.totalEquity).toBe(11800000);
    expect(sheet.balanced).toBe(true);
    expect(sheet.complete).toBe(true);
  });

  it('**结转之后利润表不能归零**（最容易写错的一处）', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, income('2026-11-03', '30000'));
    await postManualVoucher(dir, rent('2026-11-05', '12000'));
    await closePeriod(dir, '2026-11');

    const statement = incomeStatement(await all(dir));
    expect(statement.revenue).toBe(3000000);
    expect(statement.admin).toBe(1200000);
    expect(statement.netProfit).toBe(1800000);
    expect(statement.complete).toBe(true);
  });

  it('幂等：结完再结，不生成第二张凭证', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, income('2026-11-03', '1000'));

    expect((await closePeriod(dir, '2026-11')).closed).toBe(true);
    expect((await closePeriod(dir, '2026-11')).closed).toBe(false);
    expect(await all(dir)).toHaveLength(3);
  });

  it('亏损也结得平：净额为负时借记本年利润', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, rent('2026-11-05', '5000'));

    const result = await closePeriod(dir, '2026-11');
    expect(result.amountCents).toBe(-500000);

    const sheet = balanceSheet(await all(dir));
    expect(sheet.unclosedPnl).toBe(0);
    expect(sheet.totalEquity).toBe(9500000);
    expect(sheet.balanced).toBe(true);
  });
});

describe('锁期', () => {
  it('结账后该期间拒绝新凭证', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, income('2026-11-03', '1000'));
    await closePeriod(dir, '2026-11');

    await expect(postManualVoucher(dir, income('2026-11-20', '500'))).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
  });

  it('别的期间不受影响（锁的是期间，不是整个账本）', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, income('2026-11-03', '1000'));
    await closePeriod(dir, '2026-11');

    await expect(postManualVoucher(dir, income('2026-12-03', '500'))).resolves.toBeTruthy();
    expect(await closedPeriods(dir)).toEqual(['2026-11']);
    expect(await isPeriodClosed(dir, '2026-12')).toBe(false);
  });

  it('锁期事件留在 periods.jsonl 里，不是内存状态', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, income('2026-11-03', '1000'));
    await closePeriod(dir, '2026-11');

    const events = await readPeriodEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('CLOSE');
    expect(events[0]?.closingVoucherId).toBeTruthy();
  });
});

describe('反结账', () => {
  it('解锁 + 红冲结转凭证，事件留下原因与时间', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, income('2026-11-03', '1000'));
    const closing = await closePeriod(dir, '2026-11');

    const result = await reopenPeriod(dir, '2026-11', '漏记一张发票');
    expect(result.reversedVoucherId).toBeTruthy();

    // 结转凭证被红冲后，5xxx 余额回来了
    const sheet = balanceSheet(await all(dir));
    expect(sheet.unclosedPnl).toBe(100000);

    const state = await periodState(dir, '2026-11');
    expect(state.closed).toBe(false);
    expect(state.reason).toBe('漏记一张发票');
    expect(await isPeriodClosed(dir, '2026-11')).toBe(false);
    expect(closing.voucherId).not.toBe(result.reversedVoucherId);
  });

  it('解锁之后可以补记，再结一次只转新增的部分', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await postManualVoucher(dir, income('2026-11-03', '1000'));
    await closePeriod(dir, '2026-11');
    await reopenPeriod(dir, '2026-11', '补记');
    await postManualVoucher(dir, income('2026-11-20', '500'));

    const again = await closePeriod(dir, '2026-11');
    expect(again.closed).toBe(true);
    expect(again.amountCents).toBe(150000);

    const sheet = balanceSheet(await all(dir));
    expect(sheet.unclosedPnl).toBe(0);
    expect(sheet.balanced).toBe(true);
  });

  it('没结账的期间不能反结账；反结账必须写原因', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    await expect(reopenPeriod(dir, '2026-11', '随便')).rejects.toThrow(/没有结账/);

    await postManualVoucher(dir, income('2026-11-03', '1000'));
    await closePeriod(dir, '2026-11');
    await expect(reopenPeriod(dir, '2026-11', '   ')).rejects.toThrow(/必须写明原因/);
  });
});

describe('红冲', () => {
  it('追加反向凭证，金额自然相抵，原凭证一个字不改', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    const bad = await postManualVoucher(dir, rent('2026-11-05', '12000'));

    const before = (await all(dir)).find((v) => v.voucherId === bad.voucherId);
    const result = await reverseVoucher(dir, bad.voucherId, '科目选错');
    expect(result.reverses).toBe(bad.voucherId);

    const vouchers = await all(dir);
    expect(vouchers).toHaveLength(3);
    // 原凭证仍在链上，内容没被改
    expect(vouchers.find((v) => v.voucherId === bad.voucherId)).toEqual(before);

    const sheet = balanceSheet(vouchers);
    expect(sheet.unclosedPnl).toBe(0);
    expect(sheet.balanced).toBe(true);
    expect((await (await createJournal(dir)).verify()).ok).toBe(true);
  });

  it('一张只能冲一次（再冲等于撤销红冲，必须冲那张红冲凭证）', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    const bad = await postManualVoucher(dir, rent('2026-11-05', '12000'));
    await reverseVoucher(dir, bad.voucherId, '科目选错');

    await expect(reverseVoucher(dir, bad.voucherId, '再冲一次')).rejects.toThrow(/已经红冲过/);
  });

  it('已结账期间的红冲被锁期拦住，提示要先反结账', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);
    const bad = await postManualVoucher(dir, rent('2026-11-05', '12000'));
    await closePeriod(dir, '2026-11');

    await expect(reverseVoucher(dir, bad.voucherId, '科目选错')).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
  });
});

/**
 * 一整年：这是"能不能连续用"的最终判据。
 * 期初 → 三个月业务 → 每月结转 → 中途反结账补一笔 → 年底三表自洽。
 */
describe('会计循环：一个季度走完', () => {
  it('期初 → 3 个月业务 → 逐月结转 → 反结账修正 → 年末三表自洽', async () => {
    const dir = await book();
    await postOpeningVoucher(dir, OPENING);

    await postManualVoucher(dir, income('2026-11-03', '30000'));
    await postManualVoucher(dir, rent('2026-11-05', '12000'));
    await closePeriod(dir, '2026-11');

    await postManualVoucher(dir, income('2026-12-03', '40000'));
    await postManualVoucher(dir, rent('2026-12-05', '12000'));
    // 12 月发现 11 月漏了一笔费用：反结账 → 补记 → 重结
    await reopenPeriod(dir, '2026-11', '漏记 11 月审计费');
    await postManualVoucher(dir, {
      voucherDate: '2026-11-28',
      summary: '支付年度审计费',
      lines: [
        { accountCode: '560208', direction: 'DEBIT', amount: '3000' },
        { accountCode: '1002', direction: 'CREDIT', amount: '3000' },
      ],
    });
    await closePeriod(dir, '2026-11');
    await closePeriod(dir, '2026-12');

    const vouchers = await all(dir);
    const sheet = balanceSheet(vouchers);
    const statement = incomeStatement(vouchers);

    // 全年利润 = 30000 + 40000 - 12000 - 12000 - 3000 = 43000
    expect(statement.netProfit).toBe(4300000);
    // 全部结转完毕：未结转损益为 0，权益里只剩实收资本 + 本年利润
    expect(sheet.unclosedPnl).toBe(0);
    expect(sheet.totalEquity).toBe(14300000);
    expect(sheet.balanced).toBe(true);
    expect(sheet.complete).toBe(true);
    expect(statement.complete).toBe(true);
    // 链仍然完整：反结账、红冲、补记全都只是追加
    expect((await (await createJournal(dir)).verify()).ok).toBe(true);
    expect((await closedPeriods(dir))).toEqual(['2026-11', '2026-12']);
  });
});
