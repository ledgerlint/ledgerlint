/**
 * 现金流三分与 runway。
 *
 * 最要紧的两条：
 * ① **内部划转不算现金流**（钱从左口袋到右口袋）；
 * ② **runway 的分母是完整月数**，停业的月份计 0——否则烧钱率会被抬高，
 *    而创业者会据此做出错误的裁员或融资决定。
 */
import { describe, expect, it } from 'vitest';
import { entryLine } from './lines';
import type { PostedVoucher } from './types';
import { cashFlow, runway } from './cashflow';

let seq = 0;
function voucher(
  date: string,
  lines: readonly [string, 'DEBIT' | 'CREDIT', number][],
): PostedVoucher {
  seq += 1;
  const built = lines.map(([code, direction, cents]) => entryLine(code, direction, cents));
  const debit = built.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountCents, 0);
  return {
    voucherId: `v${seq}`,
    periodId: date.slice(0, 7),
    voucherNo: `记-${String(seq).padStart(4, '0')}`,
    voucherDate: date,
    summary: '测试',
    lines: built,
    totalDebitCents: debit,
    totalCreditCents: debit,
    source: 'MANUAL',
    ruleSnapshot: {},
    prevHash: '0'.repeat(64),
    hash: 'z'.repeat(64),
  };
}

describe('现金流三分', () => {
  it('收客户款 → 经营流入；房租 → 经营流出', () => {
    const report = cashFlow([
      voucher('2026-11-03', [['1002', 'DEBIT', 30000], ['5001', 'CREDIT', 30000]]),
      voucher('2026-11-05', [['560202', 'DEBIT', 12000], ['1002', 'CREDIT', 12000]]),
    ]);
    expect(report.operating.inflowCents).toBe(30000);
    expect(report.operating.outflowCents).toBe(12000);
    expect(report.operating.netCents).toBe(18000);
    expect(report.netCents).toBe(18000);
    expect(report.unclassified).toEqual([]);
  });

  it('股东出资 → 筹资，不算经营', () => {
    const report = cashFlow([voucher('2026-11-02', [['1002', 'DEBIT', 1000000], ['3001', 'CREDIT', 1000000]])]);
    expect(report.financing.netCents).toBe(1000000);
    expect(report.operating.netCents).toBe(0);
  });

  it('内部划转不算现金流（1002 → 1001）', () => {
    const report = cashFlow([voucher('2026-11-04', [['1001', 'DEBIT', 50000], ['1002', 'CREDIT', 50000]])]);
    expect(report.netCents).toBe(0);
    expect(report.operating.netCents).toBe(0);
    expect(report.unclassified).toEqual([]);
  });

  it('对方科目归不进任何一类时进「未分类」并显形', () => {
    // 借 本年利润 / 贷 银行存款：不像经营、投资、筹资中的任何一种
    const report = cashFlow([voucher('2026-11-06', [['3103', 'DEBIT', 9000], ['1002', 'CREDIT', 9000]])]);
    expect(report.unclassified.map((item) => item.netCents)).toEqual([-9000]);
    expect(report.netCents).toBe(0);
  });

  it('没有货币科目的凭证（如结转）不参与现金流', () => {
    const report = cashFlow([voucher('2026-11-30', [['5001', 'DEBIT', 30000], ['3103', 'CREDIT', 30000]])]);
    expect(report.netCents).toBe(0);
    expect(report.unclassified).toEqual([]);
  });

  it('按期间汇总经营净额', () => {
    const report = cashFlow([
      voucher('2026-11-03', [['1002', 'DEBIT', 30000], ['5001', 'CREDIT', 30000]]),
      voucher('2026-12-03', [['1002', 'DEBIT', 50000], ['5001', 'CREDIT', 50000]]),
    ]);
    expect(report.byPeriod).toEqual([
      { period: '2026-11', operatingNetCents: 30000 },
      { period: '2026-12', operatingNetCents: 50000 },
    ]);
  });
});

describe('runway', () => {
  it('按月均经营净流出算，分母是完整月数', () => {
    // 只有 11 月一个月：进 3 万、出 6 万 → 月均 -3 万
    const vouchers = [
      voucher('2026-11-03', [['1002', 'DEBIT', 30000], ['5001', 'CREDIT', 30000]]),
      voucher('2026-11-20', [['560202', 'DEBIT', 60000], ['1002', 'CREDIT', 60000]]),
    ];
    const report = runway(vouchers);
    expect(report.months).toBe(1);
    expect(report.averageOperatingCents).toBe(-30000);
    // 现金 = 3 万 − 6 万 = −3 万（这里只验口径，实际账不会负）
    expect(report.cashCents).toBe(-30000);
  });

  it('12 月没有经营流水时，月数按 2 算而不是 1（停业月计 0）', () => {
    const vouchers = [
      voucher('2026-11-03', [['1002', 'DEBIT', 100000], ['3001', 'CREDIT', 100000]]),
      voucher('2026-11-20', [['560202', 'DEBIT', 30000], ['1002', 'CREDIT', 30000]]),
      // 12 月只有一笔筹资，没有经营流水
      voucher('2026-12-10', [['1002', 'DEBIT', 1000], ['3001', 'CREDIT', 1000]]),
    ];
    const report = runway(vouchers);
    expect(report.months).toBe(2);
    // 经营净额 -3 万 / 2 个月 = -1.5 万
    expect(report.averageOperatingCents).toBe(-15000);
    expect(report.netRunwayMonths).toBe(4.7); // 71000 / 15000 ≈ 4.73
  });


  it('期初只占一天，不算作一个完整月（否则烧钱率被稀释一半）', () => {
    const opening = {
      ...voucher('2026-10-31', [['1002', 'DEBIT', 100000], ['3001', 'CREDIT', 100000]]),
      ruleSnapshot: { KIND: 'OPENING' },
    };
    const burn = voucher('2026-11-20', [['560202', 'DEBIT', 20000], ['1002', 'CREDIT', 20000]]);

    const report = runway([opening, burn]);
    expect(report.months).toBe(1);
    expect(report.averageOperatingCents).toBe(-20000);
    expect(report.cashCents).toBe(80000);
    expect(report.netRunwayMonths).toBe(4);
  });

  it('经营不烧钱时返回 null，而不是 Infinity', () => {
    const report = runway([
      voucher('2026-11-03', [['1002', 'DEBIT', 50000], ['5001', 'CREDIT', 50000]]),
    ]);
    expect(report.netRunwayMonths).toBeNull();
    expect(report.note).toContain('不烧钱');
  });

  it('空账本给出 0 与说明，不抛错', () => {
    const report = runway([]);
    expect(report.months).toBe(0);
    expect(report.netRunwayMonths).toBeNull();
    expect(report.note).toContain('还没有凭证');
  });
});
