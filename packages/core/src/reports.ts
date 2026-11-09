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
import { balances } from './ledger';
import type { Cents, PostedVoucher } from './types';
import { isClosingVoucher } from './voucher';

/**
 * 这张凭证是否在「搬损益」——把 5xxx 转到本年利润。
 *
 * 为什么利润表必须排除它：结转凭证把每个损益科目反向转平。不排除的话，
 * **结转当月的利润表直接归零**，而报表本身依然平衡、链依然完整、
 * 什么都看不出来。这是本期最容易写错、也最难发现的一处。
 *
 * 判定用两条，缺一不可：
 *   1. `KIND: CLOSING` 标记（系统生成的结转）
 *   2. **结构性兜底**：同时含 5xxx 与 3103 的凭证
 *
 * 只认标记是不够的——用户手工做「借 5001 贷 3103」时没有标记，
 * 而那就是一张结转凭证，照样会把利润表冲平。同时含损益与本年利润的凭证，
 * 按定义就是在搬损益，不需要它自己承认。
 */
export function sweepsPnl(voucher: Pick<PostedVoucher, 'lines' | 'ruleSnapshot'>): boolean {
  if (isClosingVoucher(voucher)) return true;
  const touchesPnl = voucher.lines.some((line) => line.accountCode.startsWith('5'));
  const touchesProfit = voucher.lines.some((line) => line.accountCode === '3103');
  return touchesPnl && touchesProfit;
}

/** 已经结转到本年利润的损益净额（正=盈利）。用于两表勾稽。 */
export function closedProfitOf(vouchers: readonly PostedVoucher[]): Cents {
  let sum = 0;
  for (const voucher of vouchers) {
    if (!sweepsPnl(voucher)) continue;
    for (const line of voucher.lines) {
      if (line.accountCode !== '3103') continue;
      sum += line.direction === 'CREDIT' ? line.amountCents : -line.amountCents;
    }
  }
  return sum;
}

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
  /**
   * 有余额、却没有被任何利润表项目覆盖的损益科目。**空数组才是正常的。**
   *
   * 和资产负债表的 `unmapped` 对称：光靠 `unclosedPnl === netProfit` 只能证明
   * "两张表的损益口径一致"，证明不了"利润表没有整行缺失的那一刻没人发现"——
   * 那条等式在页面上算，CLI 与交付包看不到。放进 core 才算数。
   */
  readonly uncovered: readonly AccountRow[];
  /** 利润表是否完整。`false` 表示有损益金额没进表，这张利润表少报了。 */
  readonly complete: boolean;
}

/**
 * 报表取数的入参形状：只要「科目 + 净借方」。
 * 刻意不依赖 `ledger.Balance` 的其余字段——报表只需要这两个，多依赖一个字段，
 * 将来给 Balance 加东西时报表就得跟着改。
 */
export type ReportEntry = { readonly code: string; readonly netDebitCents: Cents };

/**
 * 一个报表项目的定义。
 *
 * **一行 = 一个报表项目，不是一行一个科目。** 这不是排版偏好：
 * 「货币资金」在准则里是一个项目、三个科目；「固定资产」是原价减累计折旧。
 * 按科目罗列时，一旦加回 1602 累计折旧，报表上会出现「固定资产 10 万」
 * 和「累计折旧 3 万」两个**正数**行，资产凭空多出 3 万——而试算平衡、链校验、
 * 两表勾稽全都不会红。BP2 踩过这个坑（它的注释里写着「旧版把累计折旧当正数资产列一行」），
 * 这里把它的修法继承下来。
 *
 * `codes` 写**全码，不写前缀**。前缀匹配看着省事，但它会把「将来新增的、
 * 还没想好归哪一行的科目」悄悄并进某个既有项目——比如 222108 新开一个税费明细，
 * 前缀 2221 会让它自动进「应交税费」，数值对、科目归属没人复核过。
 * 全码写死则相反：新科目一定会掉进 `unmapped`，逼人做一次决定。
 */
export interface ReportLineDef {
  readonly key: string;
  readonly label: string;
  readonly codes: readonly string[];
}

/** 资产项目。**顺序即列报顺序**，与《小企业会计准则》资产负债表一致。 */
export const ASSET_LINES: readonly ReportLineDef[] = [
  { key: 'cash', label: '货币资金', codes: ['1001', '1002', '1012'] },
  { key: 'receivable', label: '应收账款', codes: ['1122'] },
  { key: 'prepayment', label: '预付账款', codes: ['1123'] },
  { key: 'otherReceivable', label: '其他应收款', codes: ['1221'] },
];

/** 负债项目。 */
export const LIABILITY_LINES: readonly ReportLineDef[] = [
  { key: 'payable', label: '应付账款', codes: ['2202'] },
  { key: 'advance', label: '预收账款', codes: ['2203'] },
  { key: 'taxPayable', label: '应交税费', codes: ['222101', '222102', '222103', '222104', '222105', '222107'] },
  { key: 'otherPayable', label: '其他应付款', codes: ['2241'] },
];

/** 所有者权益项目。 */
export const EQUITY_LINES: readonly ReportLineDef[] = [
  { key: 'paidIn', label: '实收资本', codes: ['3001'] },
  { key: 'capitalReserve', label: '资本公积', codes: ['3002'] },
  { key: 'surplusReserve', label: '盈余公积', codes: ['3101'] },
  // 3103 本年利润只在「手工做过结转」之后才有余额；没结转时它为空，
  // 损益单列在下面一行，两者不重叠。
  { key: 'retained', label: '未分配利润', codes: ['3103', '3104'] },
];

/** 报表上的一行（已算好金额）。 */
export interface BsLine {
  readonly key: string;
  readonly label: string;
  readonly amountCents: Cents;
}

export interface BalanceSheet {
  readonly assets: readonly BsLine[];
  readonly liabilities: readonly BsLine[];
  readonly equity: readonly BsLine[];
  readonly totalAssets: Cents;
  readonly totalLiabilities: Cents;
  /** 权益合计，**含未结转损益**。 */
  readonly totalEquity: Cents;
  /** 损益类科目尚未结转的净额（收入 − 费用）。为正表示盈利。 */
  readonly unclosedPnl: Cents;
  /** 已经结转到本年利润的损益净额。`unclosedPnl + closedPnl` 应等于利润表的净利润。 */
  readonly closedPnl: Cents;
  /** 资产 == 负债 + 权益（含未结转损益） */
  readonly balanced: boolean;
  readonly diffCents: Cents;
  /**
   * 有余额、却没有归入任何报表项目的科目。**空数组才是正常的。**
   *
   * BP2 在这里做的是 `.filter(amountCents !== 0)`：没归入项目的科目被静默过滤。
   * 少报一行没人会发现，而这张表看起来依然平衡、依然好看。这里改成显式清单。
   */
  readonly unmapped: readonly AccountRow[];
  /** 报表是否完整。`false` 表示这张表少报了钱，不能拿去用。 */
  readonly complete: boolean;
}

/**
 * 利润表行定义。
 *
 * **一行 = 一个报表项目**，由 `prefixes` 归集。这里用前缀、资产负债表那边用全码，
 * 两处规则不同是有意的：
 *   - 损益类科目是**树形**的（5602 下面是 9 个明细），一行要覆盖整棵子树，
 *     写前缀才对；写成 9 个全码，加一个费用明细就得回来改表。
 *   - 资产负债表的行是**准则项目**，与科目树并不重合（货币资金跨三个一级科目、
 *     应交税费要把 6 个明细合并），写全码才能保证"新科目必须显形"。
 *
 * 公式不写在这里，只写行。顺序即列报顺序。
 *
 * 注意 `5301 营业外收入` 没有对应行：科目表里没有这个科目（D003）。
 * 若将来加它，`reports.test.ts` 的覆盖断言会立刻红——这是有意的，
 * 宁可测试红一次，也不要报表悄悄少一行。
 */
export interface PnlLineDef {
  readonly key: string;
  readonly label: string;
  readonly prefixes: readonly string[];
  /** 取数方向：收入类取贷方净额（取正），费用类取借方净额。 */
  readonly mode: 'CREDIT' | 'DEBIT';
  /** 落在利润表的哪一段。营业外与所得税**不进营业利润**，靠这个分组隔离。 */
  readonly group: 'OPERATING' | 'NON_OPERATING' | 'TAX';
}

export const PNL_LINES: readonly PnlLineDef[] = [
  { key: 'revenue', label: '营业收入', prefixes: ['5001'], mode: 'CREDIT', group: 'OPERATING' },
  { key: 'cost', label: '营业成本', prefixes: ['5401'], mode: 'DEBIT', group: 'OPERATING' },
  { key: 'taxes', label: '税金及附加', prefixes: ['5403'], mode: 'DEBIT', group: 'OPERATING' },
  { key: 'selling', label: '销售费用', prefixes: ['5601'], mode: 'DEBIT', group: 'OPERATING' },
  { key: 'admin', label: '管理费用', prefixes: ['5602'], mode: 'DEBIT', group: 'OPERATING' },
  { key: 'finance', label: '财务费用', prefixes: ['5603'], mode: 'DEBIT', group: 'OPERATING' },
  { key: 'nonOperatingExpense', label: '营业外支出', prefixes: ['5711'], mode: 'DEBIT', group: 'NON_OPERATING' },
  { key: 'incomeTax', label: '所得税费用', prefixes: ['5801'], mode: 'DEBIT', group: 'TAX' },
];

/**
 * 把 `-0` 归一成 `0`。
 *
 * 看起来多余，但 `-0` 会一路走到显示层：`(-0 / 100).toFixed(2)` 得到 `"-0.00"`，
 * 资产负债表上出现「-0.00」比算错还容易让人怀疑整个报表。
 * 负零来自 `-netDebitOf(...)` 在净额恰为 0 时的取反。
 */
const zero = (value: Cents): Cents => (value === 0 ? 0 : value);

/** 利润表的取数区间（含端点）。都不给 = 全部历史。 */
export interface IncomeRange {
  readonly from?: string;
  readonly to?: string;
}

/**
 * 利润表。收入按贷方净额（取正），成本费用按借方净额。
 *
 * `operatingProfit` 只减「营业成本 / 税金及附加 / 三项费用」，
 * 营业外收支单独列示——把罚款滞纳金混进营业利润会让毛利率失真，
 * 而毛利率是创始人唯一真正会看的那个数。
 *
 * 隔离是**结构性**的：营业外与所得税只出现在最后两步的加总里，
 * 营业利润的算式里根本不出现它们，所以"混进去"不是靠自觉，是写不出来。
 *
 * @param range 可选的日期区间（含端点）。不给 = 全部历史。
 *   为什么要它：页面上写的是「本年累计」，而此前实现是"全部历史"——
 *   跨年之后上年利润会被算进本年，数字看起来完全正常。
 */
export function incomeStatement(
  vouchers: readonly PostedVoucher[],
  range: IncomeRange = {},
): IncomeStatement {
  // 排除结转凭证：它们把 5xxx 冲平，计进来会让当期利润归零（见 `sweepsPnl`）。
  const real = vouchers.filter(
    (voucher) =>
      !sweepsPnl(voucher) &&
      (range.from === undefined || voucher.voucherDate >= range.from) &&
      (range.to === undefined || voucher.voucherDate <= range.to),
  );
  return assembleIncomeStatement([...balances(real).values()]);
}

/**
 * 利润表的实际计算。`lines` 可替换，唯一的现实用途是测试：
 * 把某一行从定义里拿掉，证明 `uncovered` 真的会响。
 *
 * 为什么不把这条路径留成"永远为真"的字段：一个从来不会响的报警器，
 * 和一个报警器没装，在事故当天的效果是一样的。
 */
export function assembleIncomeStatement(
  entries: readonly ReportEntry[],
  lines: readonly PnlLineDef[] = PNL_LINES,
): IncomeStatement {
  const value = new Map<string, Cents>();
  const used = new Set<string>();

  for (const line of lines) {
    let sum = 0;
    for (const entry of entries) {
      if (!line.prefixes.some((prefix) => entry.code.startsWith(prefix))) continue;
      used.add(entry.code);
      sum += entry.netDebitCents;
    }
    value.set(line.key, zero(line.mode === 'CREDIT' ? -sum : sum));
  }
  // 没有对应行 = 科目表里没有这个科目（5301），恒为 0。
  const get = (key: string): Cents => value.get(key) ?? 0;

  const uncovered: AccountRow[] = entries
    .filter((entry) => entry.code.startsWith('5') && !used.has(entry.code) && entry.netDebitCents !== 0)
    .map((entry) => ({ code: entry.code, name: account(entry.code).name, amountCents: entry.netDebitCents }))
    .sort((left, right) => left.code.localeCompare(right.code));

  const revenue = get('revenue');
  const cost = get('cost');
  const taxes = get('taxes');
  const selling = get('selling');
  const admin = get('admin');
  const finance = get('finance');
  const operatingProfit = revenue - cost - taxes - selling - admin - finance;

  const nonOperatingIncome = get('nonOperatingIncome');
  const nonOperatingExpense = get('nonOperatingExpense');
  const profitBeforeTax = operatingProfit + nonOperatingIncome - nonOperatingExpense;
  const incomeTax = get('incomeTax');

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
    uncovered,
    complete: uncovered.length === 0,
  };
}

/**
 * 按项目定义汇总一组行。
 *
 * @param asCredit 负债与权益取贷方净额（取正）；资产取借方净额。
 * @param used 出参：被本组行消费掉的科目，供 `unmapped` 反查。
 */
function buildLines(
  defs: readonly ReportLineDef[],
  netOf: ReadonlyMap<string, Cents>,
  asCredit: boolean,
  used: Set<string>,
): BsLine[] {
  return defs.map((def) => {
    let sum = 0;
    for (const code of def.codes) {
      const net = netOf.get(code);
      if (net === undefined) continue;
      used.add(code);
      sum += net;
    }
    return { key: def.key, label: def.label, amountCents: zero(asCredit ? -sum : sum) };
  });
}

/** 资产负债表的行定义集合。单独成对象，是为了让"整张表的口径"可以被整体替换与测试。 */
export interface BalanceChart {
  readonly assets: readonly ReportLineDef[];
  readonly liabilities: readonly ReportLineDef[];
  readonly equity: readonly ReportLineDef[];
}

export const BS_CHART: BalanceChart = {
  assets: ASSET_LINES,
  liabilities: LIABILITY_LINES,
  equity: EQUITY_LINES,
};

/**
 * 资产负债表（不结账口径）。
 *
 * 左侧只有资产；右侧 = 负债 + 权益 + 未结转损益。四项之和必须相等，
 * 否则说明凭证本身有问题（借贷不平）或科目表被改坏了。
 */
export function balanceSheet(vouchers: readonly PostedVoucher[]): BalanceSheet {
  // 必须先落成数组：`Map.values()` 是一次性迭代器，多次遍历会从第二次起读到空。
  const base = assembleBalanceSheet([...balances(vouchers).values()]);
  // `closedPnl` 要看凭证本身（哪张在搬损益），而 `assembleBalanceSheet` 只拿到余额表，
  // 所以在这一层补上。分开的好处是下面那个纯函数可以用"缺一行的行定义"来测报警。
  return { ...base, closedPnl: closedProfitOf(vouchers) };
}

/** 不含 `closedPnl` 的资产负债表：只依赖余额表，可被独立测试。 */
export type BalanceSheetBase = Omit<BalanceSheet, 'closedPnl'>;

/**
 * 资产负债表的实际计算。`chart` 可替换，唯一的现实用途是测试：
 * 把某一行从定义里拿掉，证明 `unmapped` / `complete` 真的会响。
 *
 * **`complete === false` 时这张表不能拿去用**：它少报了 `unmapped` 里的科目。
 * 注意这时 `balanced` 可能仍然是 `true`——两边同比例少报，差额为零。
 * 这正是"平"证明不了"对"的又一个例子，所以两个标志必须分开看。
 */
export function assembleBalanceSheet(
  entries: readonly ReportEntry[],
  chart: BalanceChart = BS_CHART,
): BalanceSheetBase {
  const netOf = new Map(entries.map((entry) => [entry.code, entry.netDebitCents]));
  const used = new Set<string>();

  const assets = buildLines(chart.assets, netOf, false, used);
  const liabilities = buildLines(chart.liabilities, netOf, true, used);
  const equity = buildLines(chart.equity, netOf, true, used);

  // 损益类科目整体归入「本期未结转损益」一行，不算未映射。
  // 这一行不能被 `EQUITY_LINES` 收进去——理由见文件头：模糊的平账更危险。
  let pnlNet = 0;
  for (const entry of entries) {
    if (!entry.code.startsWith('5')) continue;
    used.add(entry.code);
    pnlNet += entry.netDebitCents;
  }
  const unclosedPnl = zero(-pnlNet);

  const sumOf = (lines: readonly BsLine[]): Cents => lines.reduce((sum, line) => sum + line.amountCents, 0);
  const totalAssets = sumOf(assets);
  const totalLiabilities = sumOf(liabilities);
  const totalEquity = zero(sumOf(equity) + unclosedPnl);
  const diffCents = zero(totalAssets - totalLiabilities - totalEquity);

  const unmapped: AccountRow[] = entries
    .filter((entry) => !used.has(entry.code) && entry.netDebitCents !== 0)
    .map((entry) => ({ code: entry.code, name: account(entry.code).name, amountCents: entry.netDebitCents }))
    .sort((left, right) => left.code.localeCompare(right.code));

  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    unclosedPnl,
    balanced: diffCents === 0,
    diffCents,
    unmapped,
    complete: unmapped.length === 0,
  };
}
