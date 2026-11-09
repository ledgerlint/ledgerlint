/**
 * T04 的纯函数测试：规范化序列化 + 链校验。
 *
 * 这里刻意把所有破坏都做成「只改一处、其余完全合法」：
 * 真实事故从来不是整条链都错，而是某一处被动过而旁边的都对。
 */
import { describe, expect, it } from 'vitest';

import type { PostedVoucher } from '../types';

import type { LocatedVoucher, VoucherBody } from './chain';
import {
  ChainFormatError,
  GENESIS_PREV_HASH,
  canonicalize,
  hashVoucher,
  verifyChain,
} from './chain';

function body(overrides: Partial<VoucherBody> = {}): VoucherBody {
  return {
    voucherId: 'V-0001',
    periodId: '2026-11',
    voucherNo: '记-0001',
    voucherDate: '2026-11-05',
    lines: [
      { accountCode: '1002', accountName: '银行存款', direction: 'DEBIT', amountCents: 203_000 },
      { accountCode: '6001', accountName: '主营业务收入', direction: 'CREDIT', amountCents: 203_000 },
    ],
    totalDebitCents: 203_000,
    totalCreditCents: 203_000,
    source: 'IMPORT',
    ruleSnapshot: { 'income.received.plain': 'v2026.11.0' },
    hit: {
      ruleId: 'income.received.plain',
      ruleVersion: 'v2026.11.0',
      event: 'E1',
      confidence: 'HIGH',
      assumed: [],
      oneLiner: '收到客户货款，记收入',
      basis: [{ kind: 'RULE', file: 'rules/cn-small/income.yaml', line: 42 }],
    },
    ...overrides,
  };
}

/** 按落账顺序串出一条合法链：`prevHash` 永远指向上一张，而不是日期上的上一张。 */
function chainOf(items: readonly VoucherBody[]): PostedVoucher[] {
  let prevHash = GENESIS_PREV_HASH;
  return items.map((item) => {
    const sealed = { ...item, prevHash };
    const voucher: PostedVoucher = { ...sealed, hash: hashVoucher(sealed) };
    prevHash = voucher.hash;
    return voucher;
  });
}

/** 把凭证按分片文件名升序 + 分片内行号升序摆好——这就是 `verifyChain` 期待的输入顺序。 */
function located(
  placements: readonly { voucher: PostedVoucher; period: string; lineNo: number }[],
): LocatedVoucher[] {
  return [...placements].sort((left, right) =>
    left.period === right.period
      ? left.lineNo - right.lineNo
      : left.period < right.period
        ? -1
        : 1,
  );
}

function threeVouchers(): PostedVoucher[] {
  return chainOf([
    body({ voucherId: 'V-0001' }),
    body({ voucherId: 'V-0002', voucherNo: '记-0002' }),
    body({ voucherId: 'V-0003', voucherNo: '记-0003' }),
  ]);
}

describe('链头与哈希口径', () => {
  it('链头是 64 个 0，hash 是 64 位小写十六进制', () => {
    expect(GENESIS_PREV_HASH).toHaveLength(64);
    expect(GENESIS_PREV_HASH).toMatch(/^0+$/);
    expect(hashVoucher({ ...body(), prevHash: GENESIS_PREV_HASH })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('规范化序列化与对象键序无关（ruleSnapshot 键序不影响 hash）', () => {
    const left = body({ ruleSnapshot: { a: '1', b: '2' } });
    const right = body({ ruleSnapshot: { b: '2', a: '1' } });
    expect(hashVoucher({ ...left, prevHash: GENESIS_PREV_HASH })).toBe(
      hashVoucher({ ...right, prevHash: GENESIS_PREV_HASH }),
    );
  });

  it('分录顺序进哈希（数组顺序即语义，不能排序）', () => {
    const forward = body();
    const swapped = body({ lines: [...forward.lines].reverse() });
    expect(hashVoucher({ ...forward, prevHash: GENESIS_PREV_HASH })).not.toBe(
      hashVoucher({ ...swapped, prevHash: GENESIS_PREV_HASH }),
    );
  });

  it('prevHash 进哈希：同一张凭证接到不同前一张会得到不同 hash', () => {
    const draft = body();
    expect(hashVoucher({ ...draft, prevHash: GENESIS_PREV_HASH })).not.toBe(
      hashVoucher({ ...draft, prevHash: 'f'.repeat(64) }),
    );
  });

  it('字段顺序是常量数组，canonicalize 输出里 prevHash 打头、hash 不参与', () => {
    const text = canonicalize({ ...body(), prevHash: GENESIS_PREV_HASH, hash: 'forged' });
    expect(text.startsWith(`{"prevHash":"${GENESIS_PREV_HASH}"`)).toBe(true);
    expect(text).not.toContain('"hash"');
  });

  it('未登记字段必须抛错，不许静默不进哈希', () => {
    const withExtra = { ...body(), prevHash: GENESIS_PREV_HASH, memo: '偷偷加的字段' };
    expect(() => canonicalize(withExtra)).toThrow(ChainFormatError);
  });

  it('金额必须是安全整数（浮点元一律拒绝）', () => {
    const broken = body({ totalDebitCents: 2030.5 });
    expect(() => hashVoucher({ ...broken, prevHash: GENESIS_PREV_HASH })).toThrow(ChainFormatError);
  });
});

describe('verifyChain 能区分三种断裂', () => {
  it('空账套与完好链都返回 null', () => {
    expect(verifyChain([])).toBeNull();
    const vouchers = threeVouchers();
    expect(
      verifyChain(
        located(
          vouchers.map((voucher, index) => ({
            voucher,
            period: '2026-11',
            lineNo: index + 1,
          })),
        ),
      ),
    ).toBeNull();
  });

  it('改内容不改 hash → HASH_MISMATCH，且精确到那一个 voucherId', () => {
    const vouchers = threeVouchers();
    const victim = vouchers[1];
    if (victim === undefined) throw new Error('样本构造失败');
    const tampered: PostedVoucher = {
      ...victim,
      totalDebitCents: 999_999,
      totalCreditCents: 999_999,
    };
    vouchers[1] = tampered;

    const broken = verifyChain(
      located(vouchers.map((voucher, index) => ({ voucher, period: '2026-11', lineNo: index + 1 }))),
    );
    expect(broken?.reason).toBe('HASH_MISMATCH');
    expect(broken?.breakAt).toBe('V-0002');
  });

  it('只改 prevHash 不改 hash → HASH_MISMATCH（prevHash 自己也在哈希范围里）', () => {
    const vouchers = threeVouchers();
    const target = vouchers[1];
    if (target === undefined) throw new Error('样本构造失败');
    vouchers[1] = { ...target, prevHash: 'a'.repeat(64) };

    const broken = verifyChain(
      located(vouchers.map((voucher, index) => ({ voucher, period: '2026-11', lineNo: index + 1 }))),
    );
    expect(broken?.reason).toBe('HASH_MISMATCH');
    expect(broken?.breakAt).toBe('V-0002');
  });

  it('连 hash 一起重算、但指针指向不存在的凭证 → PREV_HASH_MISMATCH（查得出会算 hash 的手法）', () => {
    const vouchers = threeVouchers();
    const target = vouchers[1];
    if (target === undefined) throw new Error('样本构造失败');
    const rewritten = { ...target, prevHash: 'a'.repeat(64) };
    vouchers[1] = { ...rewritten, hash: hashVoucher(rewritten) };

    const broken = verifyChain(
      located(vouchers.map((voucher, index) => ({ voucher, period: '2026-11', lineNo: index + 1 }))),
    );
    expect(broken?.reason).toBe('PREV_HASH_MISMATCH');
    expect(broken?.breakAt).toBe('V-0002');
  });

  it('中间一张被删 → PREV_HASH_MISMATCH（后继指向了不存在的 hash）', () => {
    const vouchers = threeVouchers();
    const survivors = [vouchers[0], vouchers[2]];
    const entries = survivors
      .filter((voucher): voucher is PostedVoucher => voucher !== undefined)
      .map((voucher, index) => ({ voucher, period: '2026-11', lineNo: index === 0 ? 1 : 3 }));

    const broken = verifyChain(located(entries));
    expect(broken?.reason).toBe('PREV_HASH_MISMATCH');
    expect(broken?.breakAt).toBe('V-0003');
  });

  it('行在文件里被对调 → ORDER_MISMATCH（不能因为各自 hash 都对就放行）', () => {
    const vouchers = threeVouchers();
    const [first, second, third] = vouchers;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('样本构造失败');
    }
    // 链序仍是 V1→V2→V3，但第二三行在文件里换了位置
    const broken = verifyChain(
      located([
        { voucher: first, period: '2026-11', lineNo: 1 },
        { voucher: third, period: '2026-11', lineNo: 2 },
        { voucher: second, period: '2026-11', lineNo: 3 },
      ]),
    );
    expect(broken?.reason).toBe('ORDER_MISMATCH');
    expect(broken?.breakAt).toBe('V-0003');
  });

  it('补录上月凭证不破链：落账顺序跨期间，分片内行号仍递增', () => {
    // 落账顺序：11 月一张 → 12 月一张 → 又补一张 11 月
    const vouchers = chainOf([
      body({ voucherId: 'V-0011', periodId: '2026-11' }),
      body({ voucherId: 'V-0012', periodId: '2026-12', voucherDate: '2026-12-03' }),
      body({ voucherId: 'V-0013', periodId: '2026-11' }),
    ]);
    const [nov1, dec1, nov2] = vouchers;
    if (nov1 === undefined || dec1 === undefined || nov2 === undefined) {
      throw new Error('样本构造失败');
    }
    // 磁盘上的排列按文件名：2026-11 的两行在前，2026-12 的一行在后
    const broken = verifyChain(
      located([
        { voucher: nov1, period: '2026-11', lineNo: 1 },
        { voucher: nov2, period: '2026-11', lineNo: 2 },
        { voucher: dec1, period: '2026-12', lineNo: 1 },
      ]),
    );
    expect(broken).toBeNull();
    // 补录那张接的是「落账顺序的前一张」（12 月那张），不是 11 月的上一张
    expect(nov2.prevHash).toBe(dec1.hash);
  });
});
