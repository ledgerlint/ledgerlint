/**
 * 草稿存储（T18 前置）。
 *
 * 草稿与凭证分开存，理由是**它们的不可变性不同**：
 * 凭证一经确认永不修改（进哈希链），草稿可以被反复覆盖、删除、重算。
 * 放进同一份文件，就必须为「可改的行」发明一套豁免规则，而那条规则迟早会被绕过。
 *
 * 落 `drafts/YYYY-MM.jsonl`，与 `journal/` 同一套形状（一行一条、按月分片），
 * 好处是用户拷走账套时不必区分"哪些是我的账、哪些是机器的草稿"——都在明处。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { periodOf } from '../money';
import type { Draft } from '../rules/types';

export interface DraftStore {
  /** 追加草稿；已存在同 `draftId` 的跳过。返回新增与跳过条数。 */
  appendAll(drafts: readonly Draft[]): Promise<{ added: number; skipped: number }>;
  readAll(): Promise<Draft[]>;
  /**
   * 把已落账的草稿移出待确认区。
   *
   * **不是删除，是归档**：移到 `drafts/confirmed/` 而不是抹掉。
   * 理由是可追溯——三个月后有人问"这笔当时系统是怎么判断的"，
   * 凭证上只有规则 ID，而当时的草稿里有完整的一句人话和「我猜的」。
   */
  archive(ids: readonly string[]): Promise<number>;
}

const DRAFT_DIR = 'drafts';

export async function createDraftStore(rootDir: string): Promise<DraftStore> {
  const dir = join(rootDir, DRAFT_DIR);

  const readAll = async (): Promise<Draft[]> => {
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
    const out: Draft[] = [];
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          out.push(JSON.parse(line) as Draft);
        } catch {
          // 草稿是机器的中间产物，坏一行不该让整个账套打不开；
          // 但它也不能静默消失——下次导入会按 txnId 重新生成同一份草稿。
        }
      }
    }
    return out;
  };

  return {
    async appendAll(drafts) {
      if (drafts.length === 0) return { added: 0, skipped: 0 };
      await mkdir(dir, { recursive: true });

      const existing = new Set((await readAll()).map((draft) => draft.draftId));
      const byPeriod = new Map<string, Draft[]>();
      let skipped = 0;
      for (const draft of drafts) {
        if (existing.has(draft.draftId)) {
          skipped += 1;
          continue;
        }
        existing.add(draft.draftId);
        const period = periodOf(draft.txn.date);
        const bucket = byPeriod.get(period) ?? [];
        bucket.push(draft);
        byPeriod.set(period, bucket);
      }

      let added = 0;
      for (const [period, bucket] of byPeriod) {
        const path = join(dir, `${period}.jsonl`);
        let prefix = '';
        try {
          const current = await readFile(path, 'utf8');
          // 上一行若没有换行（异常退出留下的半行），先补一个，
          // 否则新草稿会粘在残片尾部，连它一起变成坏行。
          prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
        } catch {
          prefix = '';
        }
        const body = bucket.map((draft) => JSON.stringify(draft)).join('\n');
        await writeFile(path, `${prefix}${body}\n`, 'utf8');
        added += bucket.length;
      }
      return { added, skipped };
    },
    readAll,
    async archive(ids) {
      if (ids.length === 0) return 0;
      const target = new Set(ids);
      const all = await readAll();
      const moving = all.filter((draft) => target.has(draft.draftId));
      if (moving.length === 0) return 0;

      // 先写归档，再重写待确认区。顺序反了会在中途崩溃时丢草稿；
      // 顺序对了最坏情况是"归档里有、待确认区也有"，用户多看一眼就能发现。
      const archiveDir = join(dir, 'confirmed');
      await mkdir(archiveDir, { recursive: true });
      const movingByPeriod = new Map<string, Draft[]>();
      for (const draft of moving) {
        const period = periodOf(draft.txn.date);
        const bucket = movingByPeriod.get(period) ?? [];
        bucket.push(draft);
        movingByPeriod.set(period, bucket);
      }
      for (const [period, bucket] of movingByPeriod) {
        const path = join(archiveDir, `${period}.jsonl`);
        let prefix = '';
        try {
          const current = await readFile(path, 'utf8');
          prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
        } catch {
          prefix = '';
        }
        await writeFile(path, `${prefix}${bucket.map((draft) => JSON.stringify(draft)).join('\n')}\n`, 'utf8');
      }

      // 重写待确认区，去掉已归档的。
      const remainingByPeriod = new Map<string, Draft[]>();
      const allFiles = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'));
      for (const name of allFiles) {
        const period = name.replace(/\.jsonl$/, '');
        const keep = all.filter((draft) => periodOf(draft.txn.date) === period && !target.has(draft.draftId));
        remainingByPeriod.set(period, keep);
      }
      for (const [period, keep] of remainingByPeriod) {
        const path = join(dir, `${period}.jsonl`);
        await writeFile(path, keep.length === 0 ? '' : `${keep.map((draft) => JSON.stringify(draft)).join('\n')}\n`, 'utf8');
      }
      return moving.length;
    },
  };
}
