/**
 * 三表（T10–T12）：科目余额表、利润表、资产负债表。
 *
 * **取数只有一个入口**：`ledger.balances()`。这里不重复求和——多写一份求和，
 * 就会出现"明细账与资产负债表差 1 分"这种查不出来源的差异。
 *
 * 一个必须讲清的口径（MVP 不做结账，所以它绕不开）：
 * 损益类科目（5xxx）在期末并没有结转到本年利润，它们的余额还挂在账上。
 * 因此资产负债表的权益侧必须包含「未结转损益」，否则**资产永远不等于负债+权益**。
 * 这不是妥协，是记账顺序决定的：先有凭证，再有结账；我们只做了前者。
 *
 * 列报位置：**未结转损益单独一行**，不混进「未分配利润」。
 * 混进去会让报表看起来"平了"，但看不出这个数是还没结转的——
 * 而模糊的平账比明确的不平更危险。
 */
import { account } from './accounts';
import { balances, type Balance } from './ledger';
import type { Cents, PostedVoucher } from './types';

export interface AccountRow {
  readonly code: string;
  readonly name: string;
  readonly amountCents: Cents;
}

export interface IncomeStatement {
  readonly revenue: Cents;
  readonly cost: Cents;
  readonly taxes: Cents;
  readonly selling: Cents;
  readonly admin: Cents;
  readonly finance: Cents;
  readonly operatingProfit: Cents;
  readonly nonOperatingIncome: Cents;
  readonly nonOperatingExpense: Cents;
  readonly profitBeforeTax: Cents;
  readonly incomeTax: Cents;
  readonly netProfit: Cents;
}

export interface BalanceSheet {
  readonly assets: Cents;
  readonly liabilities: Cents;
  readonly equity: Cents;
  /** 损益类科目尚未结转的净额（收入 − 费用）。为正表示盈利。 */
  readonly unclosedPnl: Cents;
  /** 资产 == 负债 + 权益 + 未结转损益 */
  readonly balanced: boolean;
  readonly diffCents: Cents;
  readonly assetRows: readonly AccountRow[];
  readonly liabilityRows: readonly AccountRow[];
  readonly equityRows: readonly AccountRow[];
  readonly pnlRows: readonly AccountRow[];
}

/**
 * 把 `-0` 归一成 `0`。
 *
 * 看起来多余，但 `-0` 会一路走到显示层：`(-0 / 100).toFixed(2)` 得到 `"-0.00"`，
 * 资产负债表上出现「-0.00」比算错还容易让人怀疑整个报表。
 * 负零来自 `-netDebitOf(...)` 在净额恰为 0 时的取反。
 */
const zero = (value: Cents): Cents => (value === 0 ? 0 : value);

/** 某个前缀下所有科目的净借方合计（借方为正）。 */
function netDebitOf(entries: Iterable<Balance>, prefix: string): Cents {
  let sum = 0;
  for (const entry of entries) {
    if (entry.code.startsWith(prefix)) sum += entry.netDebitCents;
  }
  return sum;
}

function rowsOf(entries: Iterable<Balance>, prefix: string, asCredit: boolean): AccountRow[] {
  const rows: AccountRow[] = [];
  for (const entry of entries) {
    if (!entry.code.startsWith(prefix)) continue;
    const amount = asCredit ? -entry.netDebitCents : entry.netDebitCents;
    if (amount === 0) continue;
    rows.push({ code: entry.code, name: account(entry.code).name, amountCents: amount });
  }
  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * 利润表。收入按贷方净额（取正），成本费用按借方净额。
 *
 * `operatingProfit` 只减「营业成本 / 税金及附加 / 三项费用」，
 * 营业外收支单独列示——把罚款滞纳金混进营业利润会让毛利率失真，
 * 而毛利率是创始人唯一真正会看的那个数。
 */
export function incomeStatement(vouchers: readonly PostedVoucher[]): IncomeStatement {
  // 必须先落成数组：`Map.values()` 是一次性迭代器，反复传给求和函数会从第二次起读到空。
  const entries = [...balances(vouchers).values()];
  const revenue = zero(-netDebitOf(entries, '5001') - netDebitOf(entries, '5051'));
  const cost = netDebitOf(entries, '5401');
  const taxes = netDebitOf(entries, '5403');
  const selling = netDebitOf(entries, '5601');
  const admin = netDebitOf(entries, '5602');
  const finance = netDebitOf(entries, '5603');
  const operatingProfit = revenue - cost - taxes - selling - admin - finance;

  const nonOperatingIncome = zero(-netDebitOf(entries, '5301'));
  const nonOperatingExpense = netDebitOf(entries, '5711');
  const profitBeforeTax = operatingProfit + nonOperatingIncome - nonOperatingExpense;
  const incomeTax = netDebitOf(entries, '5801');

  return {
    revenue,
    cost,
    taxes,
    selling,
    admin,
    finance,
    operatingProfit,
    nonOperatingIncome,
    nonOperatingExpense,
    profitBeforeTax,
    incomeTax,
    netProfit: profitBeforeTax - incomeTax,
  };
}

/**
 * 资产负债表（不结账口径）。
 *
 * 左侧只有资产；右侧 = 负债 + 权益 + 未结转损益。四项之和必须相等，
 * 否则说明凭证本身有问题（借贷不平）或科目表被改坏了。
 */
export function balanceSheet(vouchers: readonly PostedVoucher[]): BalanceSheet {
  const entries = [...balances(vouchers).values()];

  const assets = zero(netDebitOf(entries, '1'));
  const liabilities = zero(-netDebitOf(entries, '2'));
  const equity = zero(-netDebitOf(entries, '3'));
  // 损益类是「净资产增加」，但还没结转到权益里，所以单列。
  const unclosedPnl = zero(-netDebitOf(entries, '5'));

  const right = liabilities + equity + unclosedPnl;
  const diffCents = assets - right;

  return {
    assets,
    liabilities,
    equity,
    unclosedPnl,
    balanced: diffCents === 0,
    diffCents,
    assetRows: rowsOf(entries, '1', false),
    liabilityRows: rowsOf(entries, '2', true),
    equityRows: rowsOf(entries, '3', true),
    pnlRows: rowsOf(entries, '5', false),
  };
}
