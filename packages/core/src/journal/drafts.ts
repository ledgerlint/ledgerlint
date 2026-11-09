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
  };
}
