/**
 * 三表测试（T10–T12）。
 *
 * 重点验三件事：
 * 1. **利润表的口径**——营业外收支不能混进营业利润（罚款滞纳金混进去会让毛利率失真）；
 * 2. **资产负债表的平衡**——不结账时损益还挂在账上，必须单列「未结转损益」才平；
 * 3. **列报是按项目、不是按科目**——货币资金是一个项目三个科目；而且每个科目
 *    都必须有归属，漏归类要能被测出来（否则报表少报一行，谁都看不出来）。
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, account, isLeafAccount, isPnlAccount } from './accounts';
import { balances } from './ledger';
import { entryLine } from './lines';
import {
  ASSET_LINES,
  BS_CHART,
  EQUITY_LINES,
  LIABILITY_LINES,
  PNL_LINES,
  assembleBalanceSheet,
  assembleIncomeStatement,
  balanceSheet,
  incomeStatement,
} from './reports';
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

const lineOf = (lines: readonly { key: string; amountCents: number }[], key: string): number =>
  lines.find((item) => item.key === key)?.amountCents ?? Number.NaN;

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

describe('资产负债表：按报表项目归集，不按科目罗列', () => {
  it('货币资金是一个项目、三个科目：现金/银行/其他货币资金合并成一行', () => {
    const bs = balanceSheet([
      voucher([['1001', 'DEBIT', 10000], ['3001', 'CREDIT', 10000]]),
      voucher([['1002', 'DEBIT', 20000], ['3001', 'CREDIT', 20000]]),
      voucher([['1012', 'DEBIT', 5000], ['3001', 'CREDIT', 5000]]),
    ]);
    expect(bs.assets.map((line) => line.label)).toEqual(['货币资金', '应收账款', '预付账款', '其他应收款']);
    expect(lineOf(bs.assets, 'cash')).toBe(35000);
    // 三行合成一行，合计不变：列报方式改的是「怎么看」，不是「算多少」
    expect(bs.totalAssets).toBe(35000);
  });

  it('应收账款与预付账款各占一行，不按科目名拆开', () => {
    const bs = balanceSheet([
      voucher([['1122', 'DEBIT', 30000], ['5001', 'CREDIT', 30000]]),
      voucher([['1123', 'DEBIT', 8000], ['1002', 'CREDIT', 8000]]),
    ]);
    expect(lineOf(bs.assets, 'receivable')).toBe(30000);
    expect(lineOf(bs.assets, 'prepayment')).toBe(8000);
  });

  it('应交税费合并 6 个明细进一行', () => {
    const bs = balanceSheet([
      voucher([['1002', 'DEBIT', 100000], ['5001', 'CREDIT', 99010], ['222101', 'CREDIT', 990]]),
      voucher([['5403', 'DEBIT', 700], ['222103', 'CREDIT', 490], ['222104', 'CREDIT', 210]]),
    ]);
    expect(lineOf(bs.liabilities, 'taxPayable')).toBe(1690);
  });

  it('权益按项目分列：实收资本与未分配利润不合并', () => {
    const bs = balanceSheet([
      voucher([['1002', 'DEBIT', 2000000], ['3001', 'CREDIT', 2000000]]),
      voucher([['3104', 'DEBIT', 50000], ['1002', 'CREDIT', 50000]]),
    ]);
    expect(lineOf(bs.equity, 'paidIn')).toBe(2000000);
    // 利润分配借方 5 万 → 未分配利润为 -5 万（累计亏损）
    expect(lineOf(bs.equity, 'retained')).toBe(-50000);
    expect(bs.totalEquity).toBe(1950000);
  });

  it('收入未结转时仍平衡：资产 = 负债 + 权益 + 未结转损益', () => {
    const bs = balanceSheet([voucher([['1002', 'DEBIT', 303000], ['5001', 'CREDIT', 300000], ['222101', 'CREDIT', 3000]])]);
    expect(bs.totalAssets).toBe(303000);
    expect(bs.totalLiabilities).toBe(3000);
    expect(lineOf(bs.equity, 'paidIn')).toBe(0);
    expect(bs.unclosedPnl).toBe(300000);
    expect(bs.totalEquity).toBe(300000);
    expect(bs.balanced).toBe(true);
    expect(bs.complete).toBe(true);
  });

  it('混合业务仍平衡，且没有被漏归类的科目', () => {
    const bs = balanceSheet([
      voucher([['1002', 'DEBIT', 2000000], ['3001', 'CREDIT', 2000000]]),
      voucher([['1002', 'DEBIT', 303000], ['5001', 'CREDIT', 300000], ['222101', 'CREDIT', 3000]]),
      voucher([['560202', 'DEBIT', 120000], ['1002', 'CREDIT', 120000]]),
    ]);
    expect(bs.balanced).toBe(true);
    expect(bs.unclosedPnl).toBe(180000);
    expect(bs.complete).toBe(true);
    expect(bs.unmapped).toEqual([]);
  });

  it('未结转损益为正表示盈利、为负表示亏损', () => {
    const profit = balanceSheet([voucher([['1002', 'DEBIT', 100000], ['5001', 'CREDIT', 100000]])]);
    const loss = balanceSheet([voucher([['560205', 'DEBIT', 100000], ['1002', 'CREDIT', 100000]])]);
    expect(profit.unclosedPnl).toBeGreaterThan(0);
    expect(loss.unclosedPnl).toBeLessThan(0);
  });
});

/**
 * 列报完整性的结构测试。
 *
 * 这几条不是"测某个函数"，而是**测数据表与科目表之间的关系**：
 * 科目表加了一个科目、报表行定义没跟上，报表就会少报一行，而它看起来依然平衡。
 * 这类错只能靠"把两边对着核"发现，所以测试也必须对着核。
 */
describe('资产负债表：科目表与报表行定义必须对齐', () => {
  const allLines = [...ASSET_LINES, ...LIABILITY_LINES, ...EQUITY_LINES];
  const covered = new Set(allLines.flatMap((line) => line.codes));
  /** 资产 / 负债 / 权益的末级科目（损益类走「未结转损益」一行，不在此列）。 */
  const balanceSheetAccounts = ACCOUNTS.filter(
    (item) => isLeafAccount(item.code) && !isPnlAccount(item.code),
  );

  it('每个资产负债表科目都被某个报表项目覆盖（加科目忘了归类会在这里红）', () => {
    const missing = balanceSheetAccounts
      .filter((item) => !covered.has(item.code))
      .map((item) => `${item.code} ${item.name}`);
    expect(missing).toEqual([]);
  });

  it('行定义引用的科目都真实存在（写错编码会在这里红）', () => {
    for (const code of covered) {
      expect(() => account(code)).not.toThrow();
    }
  });

  it('同一个科目不会同时归入两个报表项目（否则金额会重复计一次）', () => {
    const seen = new Map<string, string>();
    const duplicated: string[] = [];
    for (const line of allLines) {
      for (const code of line.codes) {
        const previous = seen.get(code);
        if (previous !== undefined) duplicated.push(`${code} 同时在「${previous}」与「${line.label}」`);
        seen.set(code, line.label);
      }
    }
    expect(duplicated).toEqual([]);
  });

  it('报表顺序稳定：资产在前、负债次之、权益最后', () => {
    expect(ASSET_LINES[0]?.label).toBe('货币资金');
    expect(LIABILITY_LINES[0]?.label).toBe('应付账款');
    expect(EQUITY_LINES.at(-1)?.label).toBe('未分配利润');
  });
});

/**
 * 利润表：科目表与行定义必须对齐。
 *
 * 与资产负债表那边同一套思路，但归集方式相反（这边用前缀，那边用全码）。
 * 这三个断言合起来，保证「加一个费用明细但忘了给它在利润表找位置」这件事
 * 一定会在测试里红，而不是等到某个月的毛利率莫名其妙变了才被发现。
 */
describe('利润表：科目表与行定义必须对齐', () => {
  const pnlAccounts = ACCOUNTS.filter((item) => isPnlAccount(item.code) && isLeafAccount(item.code));
  const covering = (code: string): string[] =>
    PNL_LINES.filter((line) => line.prefixes.some((prefix) => code.startsWith(prefix))).map((line) => line.key);

  it('每个损益类末级科目都被某个报表项目覆盖', () => {
    const missing = pnlAccounts.filter((item) => covering(item.code).length === 0);
    expect(missing.map((item) => `${item.code} ${item.name}`)).toEqual([]);
  });

  it('同一科目不会同时落进两个项目（否则费用/收入会重复计一次）', () => {
    const doubled = pnlAccounts
      .filter((item) => covering(item.code).length > 1)
      .map((item) => `${item.code} ${item.name} → ${covering(item.code).join(' + ')}`);
    expect(doubled).toEqual([]);
  });

  it('行定义的前缀都能匹配到真实科目（写错编码会在这里红）', () => {
    for (const line of PNL_LINES) {
      for (const prefix of line.prefixes) {
        expect(ACCOUNTS.some((item) => item.code.startsWith(prefix))).toBe(true);
      }
    }
  });

  it('营业外与所得税不在营业利润的算式里（结构上就该隔离）', () => {
    const s = incomeStatement([
      voucher([['1002', 'DEBIT', 1000000], ['5001', 'CREDIT', 1000000]]),
      voucher([['5711', 'DEBIT', 20000], ['1002', 'CREDIT', 20000]]),
      voucher([['5801', 'DEBIT', 5000], ['222102', 'CREDIT', 5000]]),
    ]);
    expect(s.operatingProfit).toBe(1000000);
    expect(s.profitBeforeTax).toBe(980000);
    expect(s.netProfit).toBe(975000);
  });
});

/**
 * 报警器必须真的会响。
 *
 * `unmapped` / `uncovered` 这两个字段的**全部价值**在于"将来加科目时报警"。
 * 如果测试只断言"正常账套里它为空"，那和没装报警器是一样的——事故当天才发现它不响。
 * 所以这里故意把行定义拆掉一行，让它响一次。
 */
describe('列报完整性：少报时必须响', () => {
  it('科目有余额却没归入任何项目 → complete=false，且能指出是哪个科目', () => {
    const vouchers = [voucher([['1122', 'DEBIT', 100000], ['5001', 'CREDIT', 100000]])];
    const entries = [...balances(vouchers).values()];
    const chart = { ...BS_CHART, assets: ASSET_LINES.filter((line) => line.key !== 'receivable') };

    const bs = assembleBalanceSheet(entries, chart);
    expect(bs.complete).toBe(false);
    expect(bs.unmapped.map((item) => item.code)).toEqual(['1122']);
    expect(bs.totalAssets).toBe(0);
    expect(bs.balanced).toBe(false);
  });

  it('两边同时漏报时报表**仍然是平的**——所以「平」不能替代「全」', () => {
    const vouchers = [voucher([['1002', 'DEBIT', 100000], ['3001', 'CREDIT', 100000]])];
    const entries = [...balances(vouchers).values()];
    const chart = {
      assets: ASSET_LINES.filter((line) => line.key !== 'cash'),
      liabilities: LIABILITY_LINES,
      equity: EQUITY_LINES.filter((line) => line.key !== 'paidIn'),
    };

    const bs = assembleBalanceSheet(entries, chart);
    // 这是整条测试存在的理由：差额为零，但整张表什么都没说
    expect(bs.balanced).toBe(true);
    expect(bs.complete).toBe(false);
    expect(bs.unmapped.map((item) => item.code)).toEqual(['1002', '3001']);
  });

  it('损益科目没被利润表覆盖 → complete=false，且净利润会少算', () => {
    const vouchers = [
      voucher([['1002', 'DEBIT', 100000], ['5001', 'CREDIT', 100000]]),
      voucher([['560205', 'DEBIT', 30000], ['1002', 'CREDIT', 30000]]),
    ];
    const entries = [...balances(vouchers).values()];
    const lines = PNL_LINES.filter((line) => line.key !== 'admin');

    const s = assembleIncomeStatement(entries, lines);
    expect(s.complete).toBe(false);
    expect(s.uncovered.map((item) => item.code)).toEqual(['560205']);
    // 漏了一整行费用，利润就会被高估 300 元——而报表本身没有任何"不平"
    expect(s.netProfit).toBe(100000);
  });

  it('正常账套上两个 complete 都是 true（对照组）', () => {
    const vouchers = [voucher([['1002', 'DEBIT', 303000], ['5001', 'CREDIT', 300000], ['222101', 'CREDIT', 3000]])];
    expect(balanceSheet(vouchers).complete).toBe(true);
    expect(incomeStatement(vouchers).complete).toBe(true);
  });
});

/**
 * 两表勾稽：资产负债表上的「本期未结转损益」必须恒等于利润表的净利润。
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
