/**
 * 六个冻结契约的**类型层**验证（T02）。
 *
 * 本文件只做两件事：
 * 1. 构造合法样本，证明「按契约正确写出来的代码能编译、字段存在」；
 * 2. 用 `@ts-expect-error` 做反面验证，证明「违反契约的写法编译不过」——
 *    这一半才是契约真正的价值，正面样本只能证明「能写」。
 *
 * **刻意不写任何业务逻辑测试**：价税分离、试算平衡、链校验的正确性归 T30/T40/T04。
 * 在这里塞业务断言会让「契约是否稳定」和「实现是否正确」两件事混在一起，
 * 将来契约该不该改的判断会被测试结果污染。
 */
import { describe, expect, it } from 'vitest';

import type {
  AssertionResult,
  BasisRef,
  BlockId,
  Cents,
  EventKey,
  JournalLine,
  JournalPort,
  MoneyAccountCode,
  PostedVoucher,
  RuleHit,
  Transaction,
} from './types';

/* ── 样本 1：输入模型 ───────────────────────────────────────────────────── */

const SAMPLE_TXN: Transaction = {
  txnId: 'a3f1c9d2e4b5a6f708192a3b4c5d6e7f8091a2b3',
  sourceHash: 'b7e2c1d0a9f8e7d6c5b4a3928170615243342516',
  rowNo: 7,
  date: '2026-11-03',
  direction: 'IN',
  amountCents: 203_000,
  balanceCents: 1_284_500,
  counterparty: '杭州某某设计工作室',
  counterpartyAccount: '6222 **** **** 1234',
  summary: '设计服务费',
  serialNo: 'SN20261103001',
  fingerprint: '2026-11-03|IN|203000|杭州某某设计工作室|设计服务费',
  account: '1002',
};

/* ── 样本 2：事件值域（穷举，缺一个或改一个都会编译失败） ──────────────── */

const EVENT_KEYS: Readonly<Record<EventKey, true>> = {
  E1: true,
  E2: true,
  E3: true,
  E4: true,
  E5: true,
  E6: true,
  E7: true,
  E8: true,
  E11: true,
  E12: true,
  E13: true,
  E16: true,
  E99: true,
};

const MONEY_ACCOUNTS: readonly MoneyAccountCode[] = ['1001', '1002', '1012'];

/* ── 样本 3：依据链，四个 kind 各一个 ──────────────────────────────────── */

const BASIS_SAMPLES: readonly BasisRef[] = [
  { kind: 'RULE', file: 'rules/cn-small/income.yaml', line: 42 },
  { kind: 'TXN', txnId: SAMPLE_TXN.txnId, rowNo: SAMPLE_TXN.rowNo },
  { kind: 'INVOICE', invoiceNo: 'INV-2026-0001' },
  { kind: 'CITE', text: '小企业会计准则第六十二条', url: 'https://example.gov.cn/kjzz/62' },
];

const SAMPLE_HIT: RuleHit = {
  ruleId: 'income.received.plain',
  ruleVersion: 'v2026.11.0',
  event: 'E1',
  confidence: 'LOW',
  assumed: ['按普票处理：流水摘要未注明专票'],
  oneLiner: '收到客户设计服务费，记收入并计提增值税',
  basis: BASIS_SAMPLES,
  questions: [
    {
      id: 'q.delivered',
      prompt: '这笔钱对应的服务已经交付完了吗？',
      options: ['已交付', '还没交付'],
    },
  ],
};

/* ── 样本 4：分录与凭证 ─────────────────────────────────────────────────── */

const SAMPLE_LINES: readonly JournalLine[] = [
  { accountCode: '1002', accountName: '银行存款', direction: 'DEBIT', amountCents: 203_000, docNo: 'SN20261103001' },
  { accountCode: '6001', accountName: '主营业务收入', direction: 'CREDIT', amountCents: 200_990 },
  { accountCode: '222101', accountName: '应交税费—应交增值税', direction: 'CREDIT', amountCents: 2_010 },
];

const SAMPLE_VOUCHER: PostedVoucher = {
  voucherId: 'V202611-0001',
  periodId: '2026-11',
  voucherNo: '记-0001',
  voucherDate: '2026-11-03',
  summary: '收到客户设计服务费，记收入并计提增值税',
  lines: SAMPLE_LINES,
  totalDebitCents: 203_000,
  totalCreditCents: 203_000,
  source: 'IMPORT',
  ruleSnapshot: { 'income.received.plain': 'v2026.11.0' },
  hit: SAMPLE_HIT,
  prevHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
};

/* ── 样本 5：断言 ───────────────────────────────────────────────────────── */

const SAMPLE_ASSERTION: AssertionResult = {
  id: 'B1',
  title: '借贷平衡',
  passed: true,
  severity: 'BLOCK',
  evidence: { voucherCount: 1, debitCents: 203_000, creditCents: 203_000 },
  limitation: '只校验每张凭证内借贷合计相等，查不出「借贷同时记错同一个金额」。',
};

/* ── 样本 6：唯一写入口（内存假实现，只为验证签名可落地） ──────────────── */

const VOUCHERS: readonly PostedVoucher[] = [SAMPLE_VOUCHER];

/**
 * 把数组包成 `AsyncIterable`，用来验证 `JournalPort.read` 的返回类型。
 * @param items 要遍历的凭证
 */
function iterate(items: readonly PostedVoucher[]): AsyncIterable<PostedVoucher> {
  return (async function* generate(): AsyncGenerator<PostedVoucher> {
    for (const item of items) {
      yield item;
    }
  })();
}

const MEMORY_PORT: JournalPort = {
  async append(period, v) {
    // 真实实现里 prevHash 取「当前最后一张」的 hash，这里只需证明形状可落地。
    return {
      voucherId: v.voucherId,
      prevHash: `sha256:prev-of-${period}`,
      hash: `sha256:hash-of-${v.voucherId}`,
    };
  },
  read(period) {
    const year = period.slice(0, 4);
    return iterate(VOUCHERS.filter((voucher) => voucher.periodId.startsWith(year)));
  },
  readAll() {
    return iterate(VOUCHERS);
  },
  async verify() {
    return { ok: true };
  },
};

/* ── 正面验证：字段存在且形状可用 ──────────────────────────────────────── */

describe('契约样本可按定义构造', () => {
  it('Transaction 是「正数金额 + 独立方向」的形状', () => {
    expect(SAMPLE_TXN.direction).toBe('IN');
    expect(SAMPLE_TXN.amountCents).toBeGreaterThan(0);
    expect(SAMPLE_TXN.balanceCents).toBe(1_284_500);
    expect(SAMPLE_TXN.rowNo).toBe(7);
    expect(MONEY_ACCOUNTS).toContain(SAMPLE_TXN.account);
  });

  it('Transaction.balanceCents 允许 null（缺失不许用 0 冒充）', () => {
    const withoutBalance: Transaction = { ...SAMPLE_TXN, balanceCents: null };
    expect(withoutBalance.balanceCents).toBeNull();
  });

  it('EventKey 是封闭值域：12 个具名事件 + 唯一兜底值 E99', () => {
    const keys = Object.keys(EVENT_KEYS);
    const namedEvents = keys.filter((key) => key !== 'E99');

    // 12 个具名事件必须与 T20 的「12 类模板」对齐（E3 于 2026-11-09 追加补齐）
    expect(namedEvents).toHaveLength(12);
    expect(keys).toHaveLength(13);
    expect(keys.filter((key) => key === 'E99')).toHaveLength(1);
    expect(namedEvents).toContain('E3');
  });

  it('BasisRef 四个 kind 齐全', () => {
    const kinds = new Set(BASIS_SAMPLES.map((basis) => basis.kind));
    expect(kinds.size).toBe(4);
    expect([...kinds].sort()).toEqual(['CITE', 'INVOICE', 'RULE', 'TXN']);
  });

  it('RuleHit 的 assumed 可为空数组，basis 必须是数组', () => {
    expect(Array.isArray(SAMPLE_HIT.assumed)).toBe(true);
    expect(SAMPLE_HIT.basis.length).toBeGreaterThan(0);
    expect(SAMPLE_HIT.questions?.[0]?.prompt).toContain('交付');
  });

  it('PostedVoucher 的金额只存在于 lines 与合计字段', () => {
    const sumDebit = SAMPLE_VOUCHER.lines
      .filter((line) => line.direction === 'DEBIT')
      .reduce<Cents>((sum, line) => sum + line.amountCents, 0);
    const sumCredit = SAMPLE_VOUCHER.lines
      .filter((line) => line.direction === 'CREDIT')
      .reduce<Cents>((sum, line) => sum + line.amountCents, 0);

    expect(sumDebit).toBe(SAMPLE_VOUCHER.totalDebitCents);
    expect(sumCredit).toBe(SAMPLE_VOUCHER.totalCreditCents);
    expect(Number.isInteger(SAMPLE_VOUCHER.totalDebitCents)).toBe(true);
    expect(SAMPLE_VOUCHER.lines.every((line) => line.accountCode.length > 0)).toBe(true);
  });

  it('PostedVoucher 的 periodId 与 voucherDate 同源于一个日期', () => {
    expect(SAMPLE_VOUCHER.voucherDate.startsWith(SAMPLE_VOUCHER.periodId)).toBe(true);
  });

  it('PostedVoucher 可携带 hit / reverses，且 ruleSnapshot 为只读键值', () => {
    const reversal: PostedVoucher = {
      ...SAMPLE_VOUCHER,
      voucherId: 'V202611-0002',
      voucherNo: '记-0002',
      source: 'REVERSE',
      reverses: SAMPLE_VOUCHER.voucherId,
    };
    expect(reversal.reverses).toBe('V202611-0001');
    expect(Object.keys(SAMPLE_VOUCHER.ruleSnapshot)).toContain('income.received.plain');
    expect(SAMPLE_VOUCHER.hit?.event).toBe('E1');
  });

  it('AssertionResult 带 limitation，且 skipped 与 passed 是两个独立事实', () => {
    const skipped: AssertionResult = {
      ...SAMPLE_ASSERTION,
      id: 'B5',
      title: '利润表↔资产负债表衔接',
      passed: false,
      skipped: true,
      limitation: '只对已结账月份校验滚动等式，未结账月份损益仍在 5xxx，本断言无法判定。',
    };
    expect(SAMPLE_ASSERTION.limitation.length).toBeGreaterThan(0);
    expect(skipped.skipped).toBe(true);
    expect(skipped.id satisfies BlockId).toBe('B5');
  });
});

/* ── 样本 6：写入口签名可落地 ──────────────────────────────────────────── */

describe('JournalPort 是唯一的写入口', () => {
  it('append 的入参拿不到 prevHash / hash（链字段由实现计算）', async () => {
    const { prevHash, hash, ...draft } = SAMPLE_VOUCHER;
    const appended = await MEMORY_PORT.append(draft.periodId, draft);

    expect(prevHash.length).toBeGreaterThan(0);
    expect(hash.length).toBeGreaterThan(0);
    expect(appended.voucherId).toBe(SAMPLE_VOUCHER.voucherId);
    expect(appended.hash).toContain(SAMPLE_VOUCHER.voucherId);
  });

  it('read 按期间分片，readAll 读全量', async () => {
    const byYear: PostedVoucher[] = [];
    for await (const voucher of MEMORY_PORT.read('2026')) {
      byYear.push(voucher);
    }

    const all: PostedVoucher[] = [];
    for await (const voucher of MEMORY_PORT.readAll()) {
      all.push(voucher);
    }

    expect(byYear).toHaveLength(1);
    expect(all).toHaveLength(1);
  });

  it('verify 成功时不必给 breakAt', async () => {
    const result = await MEMORY_PORT.verify();
    expect(result.ok).toBe(true);
    expect(result.breakAt).toBeUndefined();
  });
});

/* ── 反面验证：违反契约必须编译失败（@ts-expect-error 未被使用也会报错） ── */

describe('契约的类型级防线', () => {
  it('AssertionResult.limitation 是编译期必填', () => {
    const withoutLimitation = {
      id: 'B1' as const,
      title: '借贷平衡',
      passed: true,
      severity: 'BLOCK' as const,
    };

    // @ts-expect-error limitation 必填 —— 「局限随结论输出」靠这条编译错误兑现
    const broken: AssertionResult = withoutLimitation;

    expect(broken.passed).toBe(true);
  });

  it('PostedVoucher 不允许出现可被直接赋值的扁平金额字段', () => {
    // @ts-expect-error 金额只能走 lines / totalDebitCents，扁平 amount 必须是编译错误
    const illegal: PostedVoucher = { ...SAMPLE_VOUCHER, amount: 203_000 };

    expect(illegal.voucherId).toBe(SAMPLE_VOUCHER.voucherId);
  });

  it('PostedVoucher 不允许出现可被直接赋值的扁平科目字段', () => {
    // @ts-expect-error 科目只能走 lines[].accountCode，扁平 accountCode 必须是编译错误
    const illegal: PostedVoucher = { ...SAMPLE_VOUCHER, accountCode: '1002' };

    expect(illegal.voucherId).toBe(SAMPLE_VOUCHER.voucherId);
  });

  it('EventKey 是封闭值域，值域外的值必须编译失败', () => {
    // @ts-expect-error E17 不在冻结值域内（值域只允许追加，追加须走 D001 §三 的流程）
    const notInDomain: EventKey = 'E17';

    expect(notInDomain).toBeDefined();
  });

  it('凭证来源值域已收缩：RECON 不再是合法来源（D004 §7.1 删除）', () => {
    // @ts-expect-error MVP 勾稽只出差异清单、不产凭证；留一个无生产者也无摘要来源的值就是「声明了但没人实现」
    const notInDomain: PostedVoucher['source'] = 'RECON';

    expect(notInDomain).toBeDefined();
  });

  it('Transaction.account 只能是三个货币资金科目之一', () => {
    // @ts-expect-error 1122 应收账款 不是银行流水可以落到的科目
    const illegal: Transaction = { ...SAMPLE_TXN, account: '1122' };

    expect(illegal.txnId).toBe(SAMPLE_TXN.txnId);
  });

  it('append(period, v) 不接受调用方自带的 hash', () => {
    // @ts-expect-error 链字段由实现计算，调用方传不进来
    const promise = MEMORY_PORT.append('2026-11', { ...SAMPLE_VOUCHER, hash: 'sha256:forged' });

    expect(promise).toBeInstanceOf(Promise);
  });
});
