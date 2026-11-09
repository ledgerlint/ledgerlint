/**
 * T03 + T04 的磁盘层测试：真实写文件、真实重启、真实破坏。
 *
 * 刻意不用内存 mock：本任务的全部风险都在「断电那一刻文件长什么样」，
 * 而 mock 文件系统永远不会断在半行。
 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PostedVoucher } from '../types';

import type { VoucherBody } from './chain';
import { GENESIS_PREV_HASH, hashVoucher } from './chain';
import type { JournalHandle } from './io';
import { JOURNAL_LIMITATIONS, JournalError, createJournal } from './io';

let root = '';
let shard = '';

function draft(
  seq: number,
  options: { period?: string; day?: string; amountCents?: number } = {},
): VoucherBody {
  const period = options.period ?? '2026-11';
  const amountCents = options.amountCents ?? 203_000;
  const serial = String(seq).padStart(4, '0');
  return {
    voucherId: `V-${serial}`,
    periodId: period,
    voucherNo: `记-${serial}`,
    voucherDate: `${period}-${options.day ?? '05'}`,
    summary: `第 ${serial} 笔测试流水`,
    lines: [
      { accountCode: '1002', accountName: '银行存款', direction: 'DEBIT', amountCents },
      { accountCode: '6001', accountName: '主营业务收入', direction: 'CREDIT', amountCents },
    ],
    totalDebitCents: amountCents,
    totalCreditCents: amountCents,
    source: 'IMPORT',
    ruleSnapshot: { 'income.received.plain': 'v2026.11.0' },
  };
}

async function collectAll(handle: JournalHandle): Promise<PostedVoucher[]> {
  const all: PostedVoucher[] = [];
  for await (const voucher of handle.readAll()) all.push(voucher);
  return all;
}

async function readRows(): Promise<string[]> {
  const text = await readFile(shard, 'utf8');
  return text.split('\n').filter((row) => row.length > 0);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openledger-journal-'));
  shard = join(root, 'journal', '2026-11.jsonl');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('append-only 存储', () => {
  it(
    '1000 张凭证追加后重启可全量读回，数量与顺序一致',
    async () => {
      const journal = await createJournal(root);
      for (let seq = 1; seq <= 1000; seq += 1) {
        // 跨两个期间，顺便证明 readAll 按文件名（即时间）升序拼接
        const period = seq <= 600 ? '2026-11' : '2026-12';
        await journal.append(period, draft(seq, { period, day: '07' }));
      }

      const restarted = await createJournal(root);
      const all = await collectAll(restarted);

      expect(all).toHaveLength(1000);
      expect(all.map((voucher) => voucher.voucherId)).toEqual(
        Array.from({ length: 1000 }, (_, index) => `V-${String(index + 1).padStart(4, '0')}`),
      );
      expect(all[0]?.prevHash).toBe(GENESIS_PREV_HASH);
      for (let index = 1; index < all.length; index += 1) {
        expect(all[index]?.prevHash).toBe(all[index - 1]?.hash);
      }

      const verdict = await restarted.verify();
      expect(verdict.ok).toBe(true);
      expect(verdict.warnings).toHaveLength(0);
      expect(restarted.index()).toEqual([
        { period: '2026-11', count: 600, lastHash: all[599]?.hash },
        { period: '2026-12', count: 400, lastHash: all[999]?.hash },
      ]);
    },
    180_000,
  );

  it('append 返回值给出实现算出的链字段，且这些字段真的落进了哈希', async () => {
    const journal = await createJournal(root);
    const first = await journal.append('2026-11', draft(1));
    const second = await journal.append('2026-11', draft(2));

    expect(first.prevHash).toBe(GENESIS_PREV_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).toBe(hashVoucher({ ...draft(2), prevHash: first.hash }));
  });

  it('并发两次 append 不撕裂：两行都完整可读，链保持线性', async () => {
    const journal = await createJournal(root);
    const [left, right] = await Promise.all([
      journal.append('2026-11', draft(1)),
      journal.append('2026-11', draft(2)),
    ]);

    expect(left.voucherId).toBe('V-0001');
    expect(right.voucherId).toBe('V-0002');
    // 写锁让第二次 append 看到第一次写出的链尾，否则两次都会接到同一 prevHash 上而分叉
    expect(right.prevHash).toBe(left.hash);

    const text = await readFile(shard, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const rows = await readRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(() => JSON.parse(row) as unknown).not.toThrow();
    }

    const restarted = await createJournal(root);
    expect((await collectAll(restarted)).map((voucher) => voucher.voucherId)).toEqual([
      'V-0001',
      'V-0002',
    ]);
    expect((await restarted.verify()).ok).toBe(true);
  });
});

describe('篡改与崩溃', () => {
  it('改中间一张的金额 → verify 的 breakAt 精确等于那一张', async () => {
    const journal = await createJournal(root);
    for (let seq = 1; seq <= 5; seq += 1) {
      await journal.append('2026-11', draft(seq));
    }

    const rows = await readRows();
    const victim = JSON.parse(rows[2] ?? '{}') as { lines: { amountCents: number }[] };
    const victimLine = victim.lines[0];
    if (victimLine === undefined) throw new Error('样本构造失败');
    victimLine.amountCents = 999_999;
    rows[2] = JSON.stringify(victim);
    await writeFile(shard, `${rows.join('\n')}\n`, 'utf8');

    const restarted = await createJournal(root);
    const verdict = await restarted.verify();

    expect(verdict.ok).toBe(false);
    expect(verdict.breakAt).toBe('V-0003');
    expect(verdict.reason).toBe('HASH_MISMATCH');
    // 断点之后的凭证本身没被改，链校正是从头重算得到的，不是只挑一张报
    expect(verdict.detail).toContain('重算');
  });

  it('文件里两行对调 → verify 报 ORDER_MISMATCH，不因各自 hash 都对而放行', async () => {
    const journal = await createJournal(root);
    for (let seq = 1; seq <= 4; seq += 1) {
      await journal.append('2026-11', draft(seq));
    }

    const rows = await readRows();
    const third = rows[2];
    const fourth = rows[3];
    if (third === undefined || fourth === undefined) throw new Error('样本构造失败');
    rows[2] = fourth;
    rows[3] = third;
    await writeFile(shard, `${rows.join('\n')}\n`, 'utf8');

    const verdict = await (await createJournal(root)).verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('ORDER_MISMATCH');
    expect(verdict.breakAt).toBe('V-0004');
  });

  it('末尾半行（崩溃残留）被跳过并显形为 warning，verify 不崩也不给静默绿勾', async () => {
    const journal = await createJournal(root);
    await journal.append('2026-11', draft(1));
    await journal.append('2026-11', draft(2));
    // 模拟断电：写了一半，没有换行
    await appendFile(shard, '{"voucherId":"V-torn","periodId":"2026-', 'utf8');

    const restarted = await createJournal(root);
    const truncated = restarted.warnings().filter((item) => item.code === 'TRUNCATED_TAIL');
    expect(truncated).toHaveLength(1);
    expect(truncated[0]?.lineNo).toBe(3);

    const all = await collectAll(restarted);
    expect(all).toHaveLength(2);
    expect(all.map((voucher) => voucher.voucherId)).toEqual(['V-0001', 'V-0002']);

    const verdict = await restarted.verify();
    expect(verdict.ok).toBe(true); // 链本身没断
    expect(verdict.warnings.some((item) => item.code === 'TRUNCATED_TAIL')).toBe(true); // 但必须显形

    // 修复后继续追加：残片变成一个解析失败的整行，新记录绝不能粘在它后面
    await restarted.append('2026-11', draft(3));
    const after = await createJournal(root);
    expect((await collectAll(after)).map((voucher) => voucher.voucherId)).toEqual([
      'V-0001',
      'V-0002',
      'V-0003',
    ]);
    expect(after.warnings().some((item) => item.code === 'UNPARSEABLE_LINE')).toBe(true);
    // 修复残片会在文件中间留下一行永久垃圾行（append-only 不删）→ 按 D002-D2-3 必须拉红，
    // 而不是「反正能读」就给绿。
    const afterVerdict = await after.verify();
    expect(afterVerdict.ok).toBe(false);
    expect(afterVerdict.reason).toBe('UNPARSEABLE_LINE');
  });

  it('非 JSON 的完整行不会被当成凭证，只给 warning', async () => {
    const journal = await createJournal(root);
    await journal.append('2026-11', draft(1));
    await appendFile(shard, 'not-json-at-all\n', 'utf8');

    const restarted = await createJournal(root);
    expect((await collectAll(restarted)).map((voucher) => voucher.voucherId)).toEqual(['V-0001']);
    expect(restarted.warnings().some((item) => item.code === 'UNPARSEABLE_LINE')).toBe(true);
  });
});

describe('链外锚点 .head.json（D002-D2-5）', () => {
  it('删掉最后一张凭证 → ok:false、reason 为 HEAD_MISMATCH，breakAt 指向仍存在的最后一张', async () => {
    const journal = await createJournal(root);
    for (let seq = 1; seq <= 3; seq += 1) await journal.append('2026-11', draft(seq));

    const rows = await readRows();
    await writeFile(shard, `${rows.slice(0, 2).join('\n')}\n`, 'utf8');

    const verdict = await (await createJournal(root)).verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('HEAD_MISMATCH');
    expect(verdict.breakAt).toBe('V-0002');
    // 锚点里的原始张数必须出现在 detail 里，否则人无法判断「少了几张」
    expect(verdict.detail).toContain('count=3');
  });

  it('中间坏行（不是尾部残片）→ ok:false 且 reason 为 UNPARSEABLE_LINE', async () => {
    const journal = await createJournal(root);
    await journal.append('2026-11', draft(1));
    await journal.append('2026-11', draft(2));

    const rows = await readRows();
    await writeFile(shard, `${rows[0] ?? ''}\n{"half":"row"}\n${rows[1] ?? ''}\n`, 'utf8');

    const verdict = await (await createJournal(root)).verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('UNPARSEABLE_LINE');
    expect(verdict.detail).toContain('第 2 行');
  });

  it('尾部残片 → ok:true 且 warnings 非空（锁死现状，防止将来被顺手改成 false）', async () => {
    const journal = await createJournal(root);
    await journal.append('2026-11', draft(1));
    await appendFile(shard, '{"voucherId":"V-torn"', 'utf8');

    const verdict = await (await createJournal(root)).verify();
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.some((item) => item.code === 'TRUNCATED_TAIL')).toBe(true);
  });

  it('锚点缺失 → ok:true 但必须在 warnings 里显形（不得静默绿勾）', async () => {
    const journal = await createJournal(root);
    await journal.append('2026-11', draft(1));
    await rm(join(root, 'journal', '.head.json'), { force: true });

    const verdict = await (await createJournal(root)).verify();
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.some((item) => item.code === 'HEAD_MISSING')).toBe(true);
    // 局限性必须活在代码里，否则 T44 的交付包里看不到这块盲区
    expect(JOURNAL_LIMITATIONS.some((line) => line.includes('.head.json'))).toBe(true);
  });

  it('空账套（无锚点）→ ok:true 且 warnings 为空（不许报复性告警）', async () => {
    const verdict = await (await createJournal(root)).verify();
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toHaveLength(0);
  });

  it(
    '1000 张正常追加 → ok:true、warnings 为空、head.count 为 1000',
    async () => {
      const journal = await createJournal(root);
      for (let seq = 1; seq <= 1000; seq += 1) await journal.append('2026-11', draft(seq));

      const head = JSON.parse(await readFile(join(root, 'journal', '.head.json'), 'utf8')) as {
        period: string;
        count: number;
        lastHash: string;
      };
      expect(head.count).toBe(1000);
      expect(head.period).toBe('2026-11');

      const restarted = await createJournal(root);
      const all = await collectAll(restarted);
      expect(head.lastHash).toBe(all[all.length - 1]?.hash);

      const verdict = await restarted.verify();
      expect(verdict.ok).toBe(true);
      expect(verdict.warnings).toHaveLength(0);
    },
    180_000,
  );
});

describe('期间校验', () => {
  it('period 与 voucherDate 派生的期间不一致必须抛错，且不落任何字节', async () => {
    const journal = await createJournal(root);
    await expect(
      journal.append('2026-11', draft(1, { period: '2026-12', day: '01' })),
    ).rejects.toBeInstanceOf(JournalError);

    // 校验在动文件之前完成：先写后校验会留下一张期间错位的凭证
    await expect(readFile(shard, 'utf8')).rejects.toThrow();
  });

  it('voucher.periodId 与 voucherDate 不一致也必须抛错（期间只能派生一次）', async () => {
    const journal = await createJournal(root);
    const inconsistent: VoucherBody = { ...draft(1), periodId: '2026-10' };
    await expect(journal.append('2026-11', inconsistent)).rejects.toMatchObject({
      code: 'PERIOD_MISMATCH',
    });
  });

  it('期间格式不合法直接拒绝', async () => {
    const journal = await createJournal(root);
    await expect(journal.append('2026-13', draft(1))).rejects.toMatchObject({ code: 'BAD_PERIOD' });
    await expect(journal.append('26-11', draft(1))).rejects.toMatchObject({ code: 'BAD_PERIOD' });
  });
});

/**
 * 重复落账的闸门。
 *
 * 这一组的存在理由不是"防手滑"，而是防**并发确认**：两个请求读到同一批草稿，
 * 各自算出同一个 `voucherId`，然后依次 append。链完全自洽（prevHash 接得上、
 * verify 全绿），但同一笔业务被记了两遍——收入凭空翻倍，且没有任何校验看得出来。
 * 绿勾 + 错账是本项目最不能接受的一类错，所以闸门放在 `append` 里，
 * 而不是指望每个调用方都记得去重。
 */
describe('重复落账的闸门', () => {
  it('同一 voucherId 第二次 append 被拒，账本里只有一张', async () => {
    const journal = await createJournal(root);
    await journal.append('2026-11', draft(1));
    await expect(journal.append('2026-11', draft(1))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
    expect(await collectAll(journal)).toHaveLength(1);
    expect(await readRows()).toHaveLength(1);
  });

  it('同一期间同一凭证号、不同 voucherId 也被拒', async () => {
    const journal = await createJournal(root);
    await journal.append('2026-11', draft(1));
    const clash: VoucherBody = { ...draft(2), voucherNo: '记-0001' };
    await expect(journal.append('2026-11', clash)).rejects.toMatchObject({ code: 'DUPLICATE_VOUCHER_NO' });
    expect(await collectAll(journal)).toHaveLength(1);
  });

  it('重启后仍认得用过的号：闸门不靠内存，靠启动扫描', async () => {
    const first = await createJournal(root);
    await first.append('2026-11', draft(1));
    const reopened = await createJournal(root);
    await expect(reopened.append('2026-11', draft(1))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
  });

  it('同一张并发落三次：只有一张进账本，链仍然完整', async () => {
    const journal = await createJournal(root);
    const results = await Promise.allSettled([
      journal.append('2026-11', draft(1)),
      journal.append('2026-11', draft(1)),
      journal.append('2026-11', draft(1)),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(await collectAll(journal)).toHaveLength(1);
    expect((await (await createJournal(root)).verify()).ok).toBe(true);
  });
});
