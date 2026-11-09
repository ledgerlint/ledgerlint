/**
 * 三表测试（T10–T12）。
 *
 * 重点验两件事：
 * 1. **利润表的口径**——营业外收支不能混进营业利润（罚款滞纳金混进去会让毛利率失真）；
 * 2. **资产负债表的平衡**——不结账时损益还挂在账上，必须单列「未结转损益」才平。
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, isLeafAccount, isPnlAccount } from './accounts';
import { balanceSheet, incomeStatement } from './reports';
import { entryLine } from './lines';
import type { PostedVoucher } from './types';

let seq = 0;
function voucher(lines: readonly [string, 'DEBIT' | 'CREDIT', number][]): PostedVoucher {
  seq += 1;
  const built = lines.map(([code, direction, cents]) => entryLine(code, direction, cents));
  const debit = built.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountCents, 0);
  const credit = built.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountCents, 0);
  return {
    voucherId: `v${seq}`,
    periodId: '2026-11',
    voucherNo: `记-${String(seq).padStart(4, '0')}`,
    voucherDate: '2026-11-10',
    summary: '测试凭证',
    lines: built,
    totalDebitCents: debit,
    totalCreditCents: credit,
    source: 'MANUAL',
    ruleSnapshot: {},
    prevHash: '0'.repeat(64),
    hash: 'x'.repeat(64),
  };
}

describe('利润表', () => {
  it('含税收入：收入 3,000，销项税不进损益', () => {
    const s = incomeStatement([voucher([['1002', 'DEBIT', 303000], ['5001', 'CREDIT', 300000], ['222101', 'CREDIT', 3000]])]);
    expect(s.revenue).toBe(300000);
    expect(s.netProfit).toBe(300000);
    expect(s.operatingProfit).toBe(300000);
  });

  it('费用按明细归集到三项期间费用', () => {
    const s = incomeStatement([
      voucher([['1002', 'DEBIT', 1000000], ['5001', 'CREDIT', 1000000]]),
      voucher([['560202', 'DEBIT', 120000], ['1002', 'CREDIT', 120000]]),
      voucher([['560101', 'DEBIT', 50000], ['1002', 'CREDIT', 50000]]),
      voucher([['560302', 'DEBIT', 1500], ['1002', 'CREDIT', 1500]]),
    ]);
    expect(s.admin).toBe(120000);
    expect(s.selling).toBe(50000);
    expect(s.finance).toBe(1500);
    expect(s.operatingProfit).toBe(1000000 - 120000 - 50000 - 1500);
  });

  it('营业外支出不冲减营业利润，但减少利润总额', () => {
    const s = incomeStatement([
      voucher([['1002', 'DEBIT', 1000000], ['5001', 'CREDIT', 1000000]]),
      voucher([['5711', 'DEBIT', 20000], ['1002', 'CREDIT', 20000]]),
    ]);
    expect(s.operatingProfit).toBe(1000000);
    expect(s.profitBeforeTax).toBe(980000);
    expect(s.netProfit).toBe(980000);
  });

  it('多科目多凭证不会因为迭代器耗尽而少算（回归：Map.values 一次性）', () => {
    const s = incomeStatement([
      voucher([['1002', 'DEBIT', 500000], ['5001', 'CREDIT', 500000]]),
      voucher([['560205', 'DEBIT', 10000], ['1002', 'CREDIT', 10000]]),
      voucher([['560208', 'DEBIT', 20000], ['1002', 'CREDIT', 20000]]),
    ]);
    expect(s.admin).toBe(30000);
    expect(s.netProfit).toBe(470000);
  });
});

describe('资产负债表（不结账口径）', () => {
  it('收入未结转时仍平衡：资产 = 负债 + 权益 + 未结转损益', () => {
    const bs = balanceSheet([voucher([['1002', 'DEBIT', 303000], ['5001', 'CREDIT', 300000], ['222101', 'CREDIT', 3000]])]);
    expect(bs.assets).toBe(303000);
    expect(bs.liabilities).toBe(3000);
    expect(bs.equity).toBe(0);
    expect(bs.unclosedPnl).toBe(300000);
    expect(bs.balanced).toBe(true);
  });

  it('股东出资进权益，不进损益', () => {
    const bs = balanceSheet([voucher([['1002', 'DEBIT', 2000000], ['3001', 'CREDIT', 2000000]])]);
    expect(bs.equity).toBe(2000000);
    expect(bs.unclosedPnl).toBe(0);
    expect(bs.balanced).toBe(true);
  });

  it('混合业务仍平衡', () => {
    const bs = balanceSheet([
      voucher([['1002', 'DEBIT', 2000000], ['3001', 'CREDIT', 2000000]]),
      voucher([['1002', 'DEBIT', 303000], ['5001', 'CREDIT', 300000], ['222101', 'CREDIT', 3000]]),
      voucher([['560202', 'DEBIT', 120000], ['1002', 'CREDIT', 120000]]),
    ]);
    expect(bs.balanced).toBe(true);
    expect(bs.unclosedPnl).toBe(180000);
  });

  it('未结转损益为正表示盈利、为负表示亏损', () => {
    const profit = balanceSheet([voucher([['1002', 'DEBIT', 100000], ['5001', 'CREDIT', 100000]])]);
    const loss = balanceSheet([voucher([['560205', 'DEBIT', 100000], ['1002', 'CREDIT', 100000]])]);
    expect(profit.unclosedPnl).toBeGreaterThan(0);
    expect(loss.unclosedPnl).toBeLessThan(0);
  });
});

/**
 * 两表勾稽：资产负债表上的「本期未结转损益」必须恒等于利润表的净利润。
 *
 * 这条不是算术巧合，而是**科目表与报表口径必须覆盖同一批 5xxx 科目**的等价表述。
 * 反过来说：一旦有人在科目表里加了损益类科目却忘了在 `incomeStatement` 里给它
 * 找个位置，这个等式就会破——那时报表看起来仍然是平的（因为资产负债表是直接
 * 按 5xxx 前缀汇总的），只有利润表少了一块，肉眼查不出来。
 *
 * 所以这里不写死几条凭证，而是**遍历科目表里每一个损益末级科目**各造一张凭证。
 * 将来加科目时这条测试会自动覆盖到它，不需要记得回来改测试。
 */
describe('两表勾稽：未结转损益 == 净利润', () => {
  it('科目表里每个损益类末级科目都能被利润表接住', () => {
    const pnlAccounts = ACCOUNTS.filter((item) => isPnlAccount(item.code) && isLeafAccount(item.code));
    expect(pnlAccounts.length).toBeGreaterThan(10);

    const vouchers = pnlAccounts.map((item) =>
      item.direction === 'CREDIT'
        ? voucher([['1002', 'DEBIT', 10000], [item.code, 'CREDIT', 10000]])
        : voucher([[item.code, 'DEBIT', 10000], ['1002', 'CREDIT', 10000]]),
    );

    const bs = balanceSheet(vouchers);
    const inc = incomeStatement(vouchers);
    expect(bs.balanced).toBe(true);
    expect(bs.unclosedPnl).toBe(inc.netProfit);
  });
});
