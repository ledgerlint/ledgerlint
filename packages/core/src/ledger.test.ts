/**
 * 账簿层的测试（T05）。
 *
 * 核心是一条口径：**链上的每一张凭证都计入余额**。红冲不做「把原凭证拿掉」，
 * 而是追加一张反向凭证；因此「该科目净额为 0」与「`readAll()` 里两张都在」
 * 必须同时成立 —— 只验前者的话，一个「删掉原凭证」的实现也能跑绿。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createJournal } from './journal/io';
import type { JournalHandle } from './journal/io';
import {
  accountLedger,
  balances,
  creditByPrefix,
  moneyBalance,
  netDebitByPrefix,
  periodIntegrityViolations,
  trialBalance,
  vouchersInPeriod,
  vouchersInRange,
  vouchersUntil,
} from './ledger';
import { entryLine } from './lines';
import type { PostedVoucher } from './types';
import type { PostedDraft } from './voucher';
import { makeVoucherNo, post, reverse } from './voucher';

/**
 * 给凭证体补上链字段，只为在纯函数测试里凑出 `PostedVoucher` 的形状。
 * 这两个字段真值只能由 `JournalPort.append` 计算 —— 这里刻意写成一个明显的假值。
 */
function asVoucher(body: PostedDraft, seq = 1): PostedVoucher {
  return { ...body, prevHash: 'f'.repeat(64), hash: `fake-hash-${seq}-${body.voucherId}` };
}

let root = '';
let journal: JournalHandle;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openledger-ledger-'));
  journal = await createJournal(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 落账并返回带链字段的完整凭证（`readAll()` 里那个形状）。 */
async function append(period: string, body: ReturnType<typeof post>): Promise<PostedVoucher> {
  const sealed = await journal.append(period, body);
  return { ...body, prevHash: sealed.prevHash, hash: sealed.hash };
}

async function readAll(): Promise<PostedVoucher[]> {
  const all: PostedVoucher[] = [];
  for await (const voucher of journal.readAll()) all.push(voucher);
  return all;
}

describe('balances / trialBalance', () => {
  it('多借多贷下的借贷发生额与净额', () => {
    const voucher = post({
      voucherId: 'V1',
      voucherDate: '2026-03-10',
      voucherNo: makeVoucherNo(1),
      summary: '测试凭证摘要',
      lines: [
        entryLine('1122', 'DEBIT', 300_000, { counterparty: '甲客户' }),
        entryLine('5001', 'CREDIT', 200_000),
        entryLine('222101', 'CREDIT', 100_000),
        entryLine('560205', 'DEBIT', 50_000),
        entryLine('1002', 'CREDIT', 50_000),
      ],
      source: 'MANUAL',
    });
    const map = balances([asVoucher(voucher)]);
    expect(map.get('1122')).toEqual({ code: '1122', debitCents: 300_000, creditCents: 0, netDebitCents: 300_000 });
    expect(map.get('222101')?.netDebitCents).toBe(-100_000);
    expect(map.get('5001')?.netDebitCents).toBe(-200_000);
    expect(map.get('1002')?.netDebitCents).toBe(-50_000);
    expect(trialBalance([asVoucher(voucher)])).toEqual({
      debitCents: 350_000,
      creditCents: 350_000,
      balanced: true,
      diffCents: 0,
    });
  });

  it('借贷差 1 分时 trialBalance 报出差额（B1 的证据来源）', () => {
    const good = post({
      voucherId: 'V1',
      voucherDate: '2026-03-10',
      voucherNo: makeVoucherNo(1),
      summary: '测试凭证摘要',
      lines: [entryLine('1122', 'DEBIT', 100_000, { counterparty: '甲客户' }), entryLine('5001', 'CREDIT', 100_000)],
      source: 'MANUAL',
    });
    // 手改一张已落账凭证的内存副本，模拟「内容被改」：试算必须能看见
    const tampered = asVoucher({ ...good, lines: [good.lines[0]!, { ...good.lines[1]!, amountCents: 99_999 }] }, 2);
    const verdict = trialBalance([asVoucher(good), tampered]);
    expect(verdict.balanced).toBe(false);
    expect(verdict.diffCents).toBe(1);
  });

  it('前缀取数与货币资金合计', () => {
    const voucher = post({
      voucherId: 'V1',
      voucherDate: '2026-03-10',
      voucherNo: makeVoucherNo(1),
      summary: '测试凭证摘要',
      lines: [
        entryLine('1002', 'DEBIT', 1_000_000),
        entryLine('1012', 'DEBIT', 200_000),
        entryLine('5001', 'CREDIT', 1_200_000),
      ],
      source: 'MANUAL',
    });
    const single = [asVoucher(voucher)];
    expect(netDebitByPrefix(single, '10')).toBe(1_200_000);
    expect(moneyBalance(single)).toBe(1_200_000);
    expect(creditByPrefix(single, '5')).toBe(1_200_000);
  });
});

describe('红冲：净额归零，但两张凭证都在', () => {
  it('原凭证 + 反向凭证 → 科目净额为 0，且 readAll() 里两张都在（原凭证未被改写）', async () => {
    const original = post({
      voucherId: 'V1',
      voucherDate: '2026-03-10',
      voucherNo: makeVoucherNo(1),
      summary: '测试凭证摘要',
      lines: [entryLine('1122', 'DEBIT', 500_000, { counterparty: '甲客户' }), entryLine('5001', 'CREDIT', 500_000)],
      source: 'IMPORT',
    });
    const sealedOriginal = await append('2026-03', original);

    const reversal = reverse(sealedOriginal, { voucherId: 'V2', voucherNo: makeVoucherNo(2), date: '2026-03-20', reason: '客户退款' });
    await append('2026-03', reversal);

    const all = await readAll();
    expect(all.map((voucher) => voucher.voucherId)).toEqual(['V1', 'V2']);
    // 原凭证仍在，且内容与 hash 一字未变（红冲不是删除，也不是原地改状态）
    expect(all[0]).toEqual(sealedOriginal);
    expect(all[1]?.reverses).toBe('V1');

    const map = balances(all);
    expect(map.get('1122')?.netDebitCents).toBe(0);
    expect(map.get('1122')?.debitCents).toBe(500_000);
    expect(map.get('1122')?.creditCents).toBe(500_000);
    expect(map.get('5001')?.netDebitCents).toBe(0);
    expect(trialBalance(all).balanced).toBe(true);
    // 链仍然完整（追加式红冲不破坏哈希链）
    expect((await journal.verify()).ok).toBe(true);
  });

  it('跨期红冲：原期间的数字不动，冲减落在红冲期间', async () => {
    const original = post({
      voucherId: 'V1',
      voucherDate: '2026-03-31',
      voucherNo: makeVoucherNo(1),
      summary: '测试凭证摘要',
      lines: [entryLine('1122', 'DEBIT', 500_000, { counterparty: '甲客户' }), entryLine('5001', 'CREDIT', 500_000)],
      source: 'IMPORT',
    });
    const sealedOriginal = await append('2026-03', original);
    const reversal = reverse(sealedOriginal, { voucherId: 'V2', voucherNo: makeVoucherNo(1), date: '2026-04-05', reason: '上月错记' });
    await append('2026-04', reversal);

    const all = await readAll();
    expect(balances(vouchersInPeriod(all, '2026-03')).get('1122')?.netDebitCents).toBe(500_000);
    expect(balances(vouchersInPeriod(all, '2026-04')).get('1122')?.netDebitCents).toBe(-500_000);
    expect(balances(all).get('1122')?.netDebitCents).toBe(0);
    expect(vouchersInPeriod(all, '2026-03')).toHaveLength(1);
    expect(vouchersInPeriod(all, '2026-04')).toHaveLength(1);
  });
});

describe('期间与日期取数', () => {
  const vouchers = [
    { voucherDate: '2026-03-01', periodId: '2026-03' },
    { voucherDate: '2026-03-31', periodId: '2026-03' },
    { voucherDate: '2026-04-01', periodId: '2026-04' },
  ] as unknown as PostedVoucher[];

  it('闭区间、同期与截至日', () => {
    expect(vouchersInRange(vouchers, '2026-03-01', '2026-03-31')).toHaveLength(2);
    expect(vouchersInRange(vouchers, '2026-03-31', '2026-04-01')).toHaveLength(2);
    expect(vouchersInPeriod(vouchers, '2026-04')).toHaveLength(1);
    expect(vouchersUntil(vouchers, '2026-03-31')).toHaveLength(2);
  });

  it('periodId 与 voucherDate 不一致必须能被查出来', async () => {
    const good = post({
      voucherId: 'V1',
      voucherDate: '2026-03-10',
      voucherNo: makeVoucherNo(1),
      summary: '测试凭证摘要',
      lines: [entryLine('1002', 'DEBIT', 1_000), entryLine('5001', 'CREDIT', 1_000)],
      source: 'MANUAL',
    });
    await append('2026-03', good);
    const all = await readAll();
    expect(periodIntegrityViolations(all)).toEqual([]);

    const broken = [{ ...all[0]!, periodId: '2026-02' }];
    expect(periodIntegrityViolations(broken)).toEqual([{ voucherId: 'V1', periodId: '2026-02', expected: '2026-03' }]);
  });
});

/**
 * 明细账。
 *
 * 明细账是**查账**用的，所以两件事必须对：
 * ① 顺序是「日期 + 凭证号」，不是落账顺序（余额是按这个顺序滚出来的）；
 * ② 区间期初 = 区间之前所有分录的净额，不依赖"上月有没有结转"。
 *    后者尤其重要：没结账也应该能查明细账，余额本来就是连续的。
 */
describe('明细账', () => {
  // 刻意打乱顺序：明细账必须自己按「日期 + 凭证号」排，不能依赖数组顺序。
  const raw = [
    { voucherDate: '2026-11-20', voucherNo: '记-0003', amountCents: 30000 },
    { voucherDate: '2026-11-03', voucherNo: '记-0001', amountCents: 10000 },
    { voucherDate: '2026-11-05', voucherNo: '记-0002', amountCents: 20000 },
  ];
  const vouchers: PostedVoucher[] = raw.map((head, index) => ({
    voucherId: `v${index}`,
    periodId: '2026-11',
    voucherNo: head.voucherNo,
    voucherDate: head.voucherDate,
    summary: `第 ${index + 1} 笔`,
    lines: [
      entryLine('1002', 'DEBIT', head.amountCents),
      entryLine('5001', 'CREDIT', head.amountCents),
    ],
    totalDebitCents: head.amountCents,
    totalCreditCents: head.amountCents,
    source: 'MANUAL' as const,
    ruleSnapshot: {},
    prevHash: '0'.repeat(64),
    hash: String(index).repeat(64),
  }));

  it('按日期排序，余额逐行滚动', () => {
    const ledger = accountLedger(vouchers, '1002');
    expect(ledger.rows.map((row) => row.voucherNo)).toEqual(['记-0001', '记-0002', '记-0003']);
    expect(ledger.rows.map((row) => row.balanceCents)).toEqual([10000, 30000, 60000]);
    expect(ledger.closingCents).toBe(60000);
    expect(ledger.openingCents).toBe(0);
  });

  it('区间：期初是区间之前的净额，期末是区间内的累计', () => {
    const ledger = accountLedger(vouchers, '1002', { from: '2026-11-04', to: '2026-11-20' });
    // 11-03 那笔在区间之前，进期初
    expect(ledger.openingCents).toBe(10000);
    expect(ledger.rows.map((row) => row.voucherDate)).toEqual(['2026-11-05', '2026-11-20']);
    expect(ledger.closingCents).toBe(60000);
    expect(ledger.debitTotalCents).toBe(50000);
  });

  it('贷方科目余额为负（借正贷负，与科目余额表同口径）', () => {
    const ledger = accountLedger(vouchers, '5001');
    expect(ledger.closingCents).toBe(-60000);
    expect(ledger.creditTotalCents).toBe(60000);
    expect(ledger.debitTotalCents).toBe(0);
  });

  it('没有该科目的分录时返回空账，不抛错', () => {
    const ledger = accountLedger(vouchers, '560202');
    expect(ledger.rows).toEqual([]);
    expect(ledger.closingCents).toBe(0);
  });
});
