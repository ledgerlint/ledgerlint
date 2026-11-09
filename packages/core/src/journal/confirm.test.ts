/**
 * 确认落账测试（T34 内核）。
 *
 * 最要紧的两条不是"能落账"，而是：
 * 1. **没分录的草稿不许落账**——E99 的意思就是"我认不出来"，给它编分录等于假装处理完了；
 * 2. **重复确认不会重复记账**——草稿归档后就不在待确认区了，这条靠归档生效，不靠去重逻辑。
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../rules/engine';
import { CN_SMALL_RULES } from '../rules/cn-small';
import type { Transaction } from '../types';
import { confirmDrafts } from './confirm';
import { createDraftStore } from './drafts';
import { createJournal } from './io';

function txn(patch: Partial<Transaction> & Pick<Transaction, 'direction' | 'summary'>): Transaction {
  return {
    txnId: 'txn-1',
    sourceHash: 'src',
    rowNo: 10,
    date: '2026-11-05',
    amountCents: 303000,
    balanceCents: null,
    counterparty: 'ABC科技有限公司',
    fingerprint: 'fp',
    account: '1002',
    ...patch,
  };
}

const CTX = { vatRate: 0.01, shareholders: ['张三'] };

async function seed(transactions: readonly Transaction[]) {
  const dir = await mkdtemp(join(tmpdir(), 'll-confirm-'));
  const store = await createDraftStore(dir);
  await store.appendAll(transactions.map((t) => classify(t, CTX, CN_SMALL_RULES)));
  return dir;
}

describe('确认落账', () => {
  it('HIGH 草稿确认后进入哈希链，且草稿被归档', async () => {
    const dir = await seed([txn({ direction: 'IN', summary: '项目款' })]);
    const result = await confirmDrafts(dir);

    expect(result.confirmed).toBe(1);
    expect(result.skipped).toHaveLength(0);

    const journal = await createJournal(dir);
    const vouchers = [];
    for await (const v of journal.readAll()) vouchers.push(v);
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]!.lines).toHaveLength(3);
    expect(vouchers[0]!.summary).toContain('ABC');
    expect((await journal.verify()).ok).toBe(true);

    const store = await createDraftStore(dir);
    expect(await store.readAll()).toHaveLength(0);
    const archived = await readFile(join(dir, 'drafts', 'confirmed', '2026-11.jsonl'), 'utf8');
    expect(archived.trim().split('\n')).toHaveLength(1);
  });

  it('未识别（E99）的草稿不落账，并说明原因', async () => {
    const dir = await seed([txn({ direction: 'IN', summary: '转账', counterparty: '某单位' })]);
    const result = await confirmDrafts(dir, undefined);

    // 默认只确认 HIGH，E99 是 LOW，所以根本不在目标里
    expect(result.confirmed).toBe(0);

    // 即使显式指定，也不能落账——没有分录
    const store = await createDraftStore(dir);
    const drafts = await store.readAll();
    const forced = await confirmDrafts(dir, [drafts[0]!.draftId]);
    expect(forced.confirmed).toBe(0);
    expect(forced.skipped[0]!.reason).toContain('人工判断');
  });

  it('重复确认不会重复记账', async () => {
    const dir = await seed([txn({ direction: 'IN', summary: '项目款' })]);
    expect((await confirmDrafts(dir, undefined)).confirmed).toBe(1);
    expect((await confirmDrafts(dir, undefined)).confirmed).toBe(0);

    const journal = await createJournal(dir);
    let count = 0;
    for await (const _ of journal.readAll()) count += 1;
    expect(count).toBe(1);
  });

  it('凭证号按期间递增，不撞号', async () => {
    const dir = await seed([
      txn({ txnId: 'a', direction: 'IN', summary: '项目款' }),
      txn({ txnId: 'b', direction: 'IN', summary: '项目款', rowNo: 11 }),
    ]);
    await confirmDrafts(dir, undefined);
    const journal = await createJournal(dir);
    const numbers: string[] = [];
    for await (const v of journal.readAll()) numbers.push(v.voucherNo);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect((await journal.verify()).ok).toBe(true);
  });

  it('指定的 id 不存在时要说出来，不能静默成功', async () => {
    const dir = await seed([txn({ direction: 'IN', summary: '项目款' })]);
    const result = await confirmDrafts(dir, ['d-已经归档过的']);
    expect(result.confirmed).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('已经不在了');
  });
});
