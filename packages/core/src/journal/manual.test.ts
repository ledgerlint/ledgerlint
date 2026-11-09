/**
 * 手工录入凭证（T35）。
 *
 * 这里最要紧的不是"能记进去"，而是**记不进去的时候账是干净的**：
 * 校验必须发生在 `append` 之前。一条"借贷不平也写进去了"的实现，
 * 会让账本的哈希链完全正常、试算表却永远不平——而链校验是绿的，
 * 用户会先怀疑试算表坏了。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJournal } from './io';
import { postManualVoucher } from './manual';

const date = '2026-11-18';

async function emptyBook(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'll-manual-'));
}

async function countVouchers(dir: string): Promise<number> {
  const journal = await createJournal(dir);
  let count = 0;
  for await (const _ of journal.readAll()) count += 1;
  return count;
}

describe('手工录入凭证', () => {
  it('一借一贷记进哈希链，凭证号从 记-0001 开始', async () => {
    const dir = await emptyBook();
    const result = await postManualVoucher(dir, {
      voucherDate: date,
      summary: '计提 11 月房租',
      lines: [
        { accountCode: '560202', direction: 'DEBIT', amount: '1,200.00' },
        { accountCode: '2241', direction: 'CREDIT', amount: '1200' },
      ],
    });

    expect(result.voucherNo).toBe('记-0001');
    expect(result.periodId).toBe('2026-11');

    const journal = await createJournal(dir);
    const vouchers = [];
    for await (const v of journal.readAll()) vouchers.push(v);
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]!.source).toBe('MANUAL');
    expect(vouchers[0]!.totalDebitCents).toBe(120000);
    // 手工凭证没有规则依据：宁可空着，也不编一条假的
    expect(vouchers[0]!.hit).toBeUndefined();
    expect((await journal.verify()).ok).toBe(true);
  });

  it('借贷不平时抛出中文差额，且什么都没写进去', async () => {
    const dir = await emptyBook();
    await expect(
      postManualVoucher(dir, {
        voucherDate: date,
        summary: '借贷不平',
        lines: [
          { accountCode: '560202', direction: 'DEBIT', amount: '1200' },
          { accountCode: '1002', direction: 'CREDIT', amount: '1000' },
        ],
      }),
    ).rejects.toThrow(/差额 200\.00/);

    expect(await countVouchers(dir)).toBe(0);
  });

  it('非末级科目被拒（5401 必须挂到 540101/540102）', async () => {
    const dir = await emptyBook();
    await expect(
      postManualVoucher(dir, {
        voucherDate: date,
        summary: '科目挂错层级',
        lines: [
          { accountCode: '5401', direction: 'DEBIT', amount: '100' },
          { accountCode: '1002', direction: 'CREDIT', amount: '100' },
        ],
      }),
    ).rejects.toThrow(/末级/);
    expect(await countVouchers(dir)).toBe(0);
  });

  it('往来科目缺对象被拒（1122 应收账款必须有对方）', async () => {
    const dir = await emptyBook();
    await expect(
      postManualVoucher(dir, {
        voucherDate: date,
        summary: '赊销但没写客户',
        lines: [
          { accountCode: '1122', direction: 'DEBIT', amount: '500' },
          { accountCode: '5001', direction: 'CREDIT', amount: '500' },
        ],
      }),
    ).rejects.toThrow(/对方|对象/);
    expect(await countVouchers(dir)).toBe(0);
  });

  it('摘要为空被拒：不替用户补一句默认摘要', async () => {
    const dir = await emptyBook();
    await expect(
      postManualVoucher(dir, {
        voucherDate: date,
        summary: '   ',
        lines: [
          { accountCode: '560205', direction: 'DEBIT', amount: '100' },
          { accountCode: '1002', direction: 'CREDIT', amount: '100' },
        ],
      }),
    ).rejects.toThrow(/摘要/);
    expect(await countVouchers(dir)).toBe(0);
  });

  it('金额为 0 或负数被拒，且报错指向行号', async () => {
    const dir = await emptyBook();
    await expect(
      postManualVoucher(dir, {
        voucherDate: date,
        summary: '金额为零',
        lines: [
          { accountCode: '560205', direction: 'DEBIT', amount: '0' },
          { accountCode: '1002', direction: 'CREDIT', amount: '0' },
        ],
      }),
    ).rejects.toThrow(/第 1 行金额必须大于 0/);
    expect(await countVouchers(dir)).toBe(0);
  });

  it('三行分录也能记（一借两贷）', async () => {
    const dir = await emptyBook();
    await postManualVoucher(dir, {
      voucherDate: date,
      summary: '收货款并拆税',
      lines: [
        { accountCode: '1002', direction: 'DEBIT', amount: '3030' },
        { accountCode: '5001', direction: 'CREDIT', amount: '3000' },
        { accountCode: '222101', direction: 'CREDIT', amount: '30' },
      ],
    });
    expect(await countVouchers(dir)).toBe(1);
  });

  it('手工凭证与已落账凭证连续编号，不撞号', async () => {
    const dir = await emptyBook();
    const lines = [
      { accountCode: '560205' as const, direction: 'DEBIT' as const, amount: '10' },
      { accountCode: '1002' as const, direction: 'CREDIT' as const, amount: '10' },
    ];
    const first = await postManualVoucher(dir, { voucherDate: date, summary: '第一张', lines });
    const second = await postManualVoucher(dir, { voucherDate: date, summary: '第二张', lines });
    expect(first.voucherNo).toBe('记-0001');
    expect(second.voucherNo).toBe('记-0002');
    expect((await (await createJournal(dir)).verify()).ok).toBe(true);
  });
});
