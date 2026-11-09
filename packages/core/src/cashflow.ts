/**
 * 现金流三分（经营/投资/筹资）与 runway。
 *
 * 为什么 BP3 必须有它：利润表回答"赚没赚"，但创始人真正每天想的是"钱还能撑几个月"。
 * 而这个问题**只能从流水答**——利润表里有应收应付、有非现金费用，看着盈利也可能下个月发不出工资。
 *
 * 三条口径，都是刻意的：
 *
 * 1. **按"非货币方科目"整笔归类，不按金额拆分**。一笔钱要么是经营、要么是投资，
 *    拆比例等于编一个数出来。拆不了的（同时涉及两类）就列进"未分类"让人看，
 *    而不是硬塞进某一类——**未分类清单本身就是信号**，说明有笔业务的对方科目没归好。
 * 2. **内部划转不算现金流**（1002 → 1001）。钱从左口袋到右口袋，不是流入也不是流出。
 * 3. **runway 的分母用"完整月数"**，不是"有流水的月份"。
 *    停业的月份计 0，否则烧钱率会被抬高到吓人的水平——而创业者会据此做出错误的裁员决定。
 */
import { MONEY_CODES } from './accounts';
import { moneyBalance } from './ledger';
import { periodOf } from './money';
import type { Cents, PostedVoucher } from './types';
import { kindOf } from './voucher';

export type CashFlowCategory = 'OPERATING' | 'INVESTING' | 'FINANCING';

export interface CashFlowBucket {
  readonly inflowCents: Cents;
  readonly outflowCents: Cents;
  readonly netCents: Cents;
}

export interface CashFlowItem {
  readonly voucherId: string;
  readonly voucherNo: string;
  readonly voucherDate: string;
  readonly summary: string;
  readonly netCents: Cents;
}

export interface CashFlowReport {
  readonly operating: CashFlowBucket;
  readonly investing: CashFlowBucket;
  readonly financing: CashFlowBucket;
  /** 有现金变动、但对方科目归不进任何一类。**空数组才正常。** */
  readonly unclassified: readonly CashFlowItem[];
  readonly netCents: Cents;
  /** 按期间（月）的经营净额，runway 用它算月均。 */
  readonly byPeriod: readonly { period: string; operatingNetCents: Cents }[];
}

const MONEY = new Set<string>(MONEY_CODES);

/** 非货币方科目 → 类别。前缀匹配，因为损益与税费都是树形的。 */
const PREFIX_CATEGORY: readonly { prefix: string; category: CashFlowCategory }[] = [
  { prefix: '5', category: 'OPERATING' },
  { prefix: '1122', category: 'OPERATING' },
  { prefix: '1123', category: 'OPERATING' },
  { prefix: '1221', category: 'OPERATING' },
  { prefix: '2202', category: 'OPERATING' },
  { prefix: '2203', category: 'OPERATING' },
  { prefix: '2221', category: 'OPERATING' },
  { prefix: '2241', category: 'OPERATING' },
  { prefix: '1601', category: 'INVESTING' },
  { prefix: '1602', category: 'INVESTING' },
  { prefix: '1701', category: 'INVESTING' },
  { prefix: '1702', category: 'INVESTING' },
  { prefix: '1801', category: 'INVESTING' },
  { prefix: '1101', category: 'INVESTING' },
  { prefix: '2001', category: 'FINANCING' },
  { prefix: '2501', category: 'FINANCING' },
  { prefix: '3001', category: 'FINANCING' },
  { prefix: '3002', category: 'FINANCING' },
  { prefix: '3104', category: 'FINANCING' },
];

function categoryOf(code: string): CashFlowCategory | null {
  for (const rule of PREFIX_CATEGORY) {
    if (code.startsWith(rule.prefix)) return rule.category;
  }
  return null;
}

/** 一笔凭证的现金净额（货币科目借方减贷方）。没有货币科目则为 `null`。 */
function moneyNetOf(voucher: PostedVoucher): Cents | null {
  let net = 0;
  let touched = false;
  for (const line of voucher.lines) {
    if (!MONEY.has(line.accountCode)) continue;
    touched = true;
    net += line.direction === 'DEBIT' ? line.amountCents : -line.amountCents;
  }
  return touched ? net : null;
}

/**
 * 归类一笔凭证。
 * - `INTERNAL`：只有货币科目（内部划转），不算现金流
 * - `null`：有现金变动但对方科目归不进任何一类
 */
function classify(voucher: PostedVoucher): CashFlowCategory | 'INTERNAL' | null {
  const others = voucher.lines.filter((line) => !MONEY.has(line.accountCode));
  if (others.length === 0) return 'INTERNAL';

  const found = new Set<CashFlowCategory>();
  for (const line of others) {
    const category = categoryOf(line.accountCode);
    if (category !== null) found.add(category);
  }
  // 投资 > 筹资 > 经营：买设备同时有股东打款时，归投资更能反映"这笔钱变成了资产"。
  if (found.has('INVESTING')) return 'INVESTING';
  if (found.has('FINANCING')) return 'FINANCING';
  if (found.has('OPERATING')) return 'OPERATING';
  return null;
}

export function cashFlow(vouchers: readonly PostedVoucher[]): CashFlowReport {
  const mutable: Record<CashFlowCategory, { inflowCents: number; outflowCents: number; netCents: number }> = {
    OPERATING: { inflowCents: 0, outflowCents: 0, netCents: 0 },
    INVESTING: { inflowCents: 0, outflowCents: 0, netCents: 0 },
    FINANCING: { inflowCents: 0, outflowCents: 0, netCents: 0 },
  };
  const unclassified: CashFlowItem[] = [];
  const byPeriod = new Map<string, number>();
  let netCents = 0;

  for (const voucher of vouchers) {
    const net = moneyNetOf(voucher);
    if (net === null) continue;

    const category = classify(voucher);
    if (category === 'INTERNAL') continue;

    if (category === null) {
      if (net !== 0) {
        unclassified.push({
          voucherId: voucher.voucherId,
          voucherNo: voucher.voucherNo,
          voucherDate: voucher.voucherDate,
          summary: voucher.summary,
          netCents: net,
        });
      }
      continue;
    }

    const bucket = mutable[category];
    if (net > 0) bucket.inflowCents += net;
    else bucket.outflowCents += -net;
    bucket.netCents += net;
    netCents += net;

    if (category === 'OPERATING') {
      const period = voucher.periodId === '' ? periodOf(voucher.voucherDate) : voucher.periodId;
      byPeriod.set(period, (byPeriod.get(period) ?? 0) + net);
    }
  }

  return {
    operating: mutable.OPERATING,
    investing: mutable.INVESTING,
    financing: mutable.FINANCING,
    unclassified,
    netCents,
    byPeriod: [...byPeriod.entries()]
      .map(([period, operatingNetCents]) => ({ period, operatingNetCents }))
      .sort((left, right) => left.period.localeCompare(right.period)),
  };
}

export interface RunwayReport {
  /** 账上现金（货币资金净额）。 */
  readonly cashCents: Cents;
  /** 参与计算的月数（从最早到最新凭证，含没有流水的月份）。 */
  readonly months: number;
  /** 月均经营净额。负数表示在烧钱。 */
  readonly averageOperatingCents: Cents;
  /** 月均总净额（含投资筹资）。 */
  readonly averageNetCents: Cents;
  /** 现金还能撑几个月。`null` 表示经营上不烧钱。 */
  readonly netRunwayMonths: number | null;
  readonly grossRunwayMonths: number | null;
  /** 必须显示给用户的一句话口径说明。 */
  readonly note: string;
}

/** 期间序列（含端点），`YYYY-MM` 等长零填充，字典序即时间序。 */
function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [year, month] = first.split('-').map(Number) as [number, number];
  const [endYear, endMonth] = last.split('-').map(Number) as [number, number];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

/**
 * runway：还能活几个月。
 *
 * 两个口径都给，因为它们回答不同的问题：
 *   - **净 runway**（只算经营）：公司正常运转还能撑多久
 *   - **毛 runway**（连投资一起算）：如果继续按现在的花钱速度（含买设备）还能撑多久
 * 只给一个数，会在不该融资的时候催人融资，或者在该警惕的时候给人安全感。
 */
export function runway(vouchers: readonly PostedVoucher[]): RunwayReport {
  const cashCents = moneyBalance(vouchers);
  if (vouchers.length === 0) {
    return {
      cashCents: 0,
      months: 0,
      averageOperatingCents: 0,
      averageNetCents: 0,
      netRunwayMonths: null,
      grossRunwayMonths: null,
      note: '还没有凭证，算不出 runway。',
    };
  }

  // 月数的起点用**第一张业务凭证**，不用期初凭证：期初只占一天（常常是月末那天），
  // 把它算作一个完整月会把烧钱率稀释掉一半，而 runway 会因此凭空变长。
  const business = vouchers.filter((voucher) => kindOf(voucher) !== 'OPENING');
  const dates = (business.length > 0 ? business : vouchers).map((voucher) => voucher.voucherDate).sort();
  const first = periodOf(dates[0] ?? '');
  const last = periodOf(dates[dates.length - 1] ?? '');
  const months = monthsBetween(first, last);

  const report = cashFlow(vouchers);
  const operatingByPeriod = new Map(report.byPeriod.map((item) => [item.period, item.operatingNetCents]));
  // 没有流水的月份按 0 计——这是"完整月数"的全部意义。
  const operatingTotal = months.reduce((sum, period) => sum + (operatingByPeriod.get(period) ?? 0), 0);
  const averageOperating = Math.round(operatingTotal / months.length);
  const averageNet = Math.round(report.netCents / months.length);

  const divide = (burn: number): number | null => (burn < 0 ? Math.round((cashCents / -burn) * 10) / 10 : null);

  const note =
    averageOperating >= 0
      ? '经营现金流为正，按现在的状态不烧钱；这个数不预测未来。'
      : `按最近 ${months.length} 个月的平均经营净流出计算（没有流水的月份计 0）。`;

  return {
    cashCents,
    months: months.length,
    averageOperatingCents: averageOperating,
    averageNetCents: averageNet,
    netRunwayMonths: divide(averageOperating),
    grossRunwayMonths: divide(averageNet),
    note,
  };
}
