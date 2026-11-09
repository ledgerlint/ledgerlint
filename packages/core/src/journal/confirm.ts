/**
 * 确认落账（T34 的内核部分）。
 *
 * 这是全仓**唯一**把草稿变成凭证的地方。它做四件事，顺序不能换：
 *
 *   1. 取草稿 → 2. 逐张 `post()` 校验并构造凭证体 → 3. `journal.append()` 写入哈希链
 *   → 4. 把已落账的草稿归档
 *
 * 第 3 步成功才算第 4 步的输入。反过来（先归档再写链）会在写链失败时把草稿弄丢，
 * 而用户看到的只是"草稿不见了、凭证也没多"。
 *
 * **不做批量事务**：一张失败不影响其他张。理由是失败通常是单张的问题（科目被改坏、
 * 摘要为空），整批回滚会让用户不知道到底是哪一张有问题，只能重来一遍。
 */
import { periodOf } from '../money';
import type { Draft } from '../rules/types';
import type { PostedVoucher, RuleHit } from '../types';
import { nextVoucherNo, post } from '../voucher';
import { createDraftStore, type DraftStore } from './drafts';
import { createJournal } from './io';

export interface ConfirmSkipped {
  readonly draftId: string;
  readonly reason: string;
}

export interface ConfirmResult {
  readonly confirmed: number;
  readonly skipped: readonly ConfirmSkipped[];
}

/** 草稿 → 凭证体。依据链只保留「来自哪条流水」，规则信息进 `ruleSnapshot`。 */
function toVoucherDraft(draft: Draft, voucherNo: string): Parameters<typeof post>[0] {
  const hit: RuleHit = {
    ruleId: draft.ruleId,
    ruleVersion: draft.ruleVersion,
    event: draft.event,
    confidence: draft.confidence,
    assumed: draft.assumed,
    oneLiner: draft.oneLiner,
    basis: [{ kind: 'TXN', txnId: draft.txn.txnId, rowNo: draft.txn.rowNo }],
  };
  return {
    voucherId: `v-${draft.txn.txnId}`,
    voucherDate: draft.txn.date,
    summary: draft.summary,
    voucherNo,
    lines: draft.lines,
    source: 'IMPORT',
    ruleSnapshot: { [draft.ruleId]: draft.ruleVersion, EVENT: draft.event },
    hit,
  };
}

/**
 * @param draftIds 指定要确认的草稿；省略时只确认 `confidence === 'HIGH'` 的。
 *                 「只确认 HIGH」是默认值，因为 LOW 的意思就是"我猜的，你得看一眼"。
 */
export async function confirmDrafts(
  rootDir: string,
  draftIds?: readonly string[],
): Promise<ConfirmResult> {
  const journal = await createJournal(rootDir);
  const store: DraftStore = await createDraftStore(rootDir);
  const drafts = await store.readAll();

  const existing: Pick<PostedVoucher, 'periodId' | 'voucherNo'>[] = [];
  for await (const voucher of journal.readAll()) {
    existing.push({ periodId: voucher.periodId, voucherNo: voucher.voucherNo });
  }

  const target =
    draftIds === undefined
      ? drafts.filter((draft) => draft.confidence === 'HIGH')
      : drafts.filter((draft) => draftIds.includes(draft.draftId));

  const skipped: ConfirmSkipped[] = [];
  const done: string[] = [];

  // 指定的 id 找不到时必须说出来。静默跳过会让界面显示「没有落账」，
  // 而用户明明点了确认——他只会以为按钮坏了，然后再点三次。
  if (draftIds !== undefined) {
    const known = new Set(drafts.map((draft) => draft.draftId));
    for (const id of draftIds) {
      if (!known.has(id)) {
        skipped.push({ draftId: id, reason: '这张草稿已经不在了（可能已经确认过，或导入时被新的覆盖）' });
      }
    }
  }

  for (const draft of target) {
    if (draft.lines.length === 0) {
      skipped.push({ draftId: draft.draftId, reason: '没有分录：这类流水需要先人工判断业务性质' });
      continue;
    }
    try {
      const period = periodOf(draft.txn.date);
      const voucherNo = nextVoucherNo(existing, period);
      const body = post(toVoucherDraft(draft, voucherNo));
      await journal.append(period, body);
      existing.push({ periodId: period, voucherNo });
      done.push(draft.draftId);
    } catch (error) {
      skipped.push({
        draftId: draft.draftId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const archived = await store.archive(done);
  if (archived !== done.length) {
    // 归档数与落账数对不上：凭证已经写进链了，不能回滚，只能让上层知道。
    skipped.push({ draftId: '-', reason: `已落账 ${done.length} 张，但只归档了 ${archived} 张草稿` });
  }

  return { confirmed: done.length, skipped };
}
