/**
 * 账簿层（T05 迁移）：余额、试算平衡、发生额取数。纯函数，只管算，不管存。
 *
 * **口径只有一句：链上的每一张凭证都计入余额。**
 *
 * BP2 的 `ledger.ts` 用 `v.status === 'POSTED' | 'REVERSED'` 过滤，于是红冲要分两步：
 * 把原凭证改成 `REVERSED`、再插入一张红字凭证。那是**改历史**，而历史一旦可改，
 * 「凭证不可变」就不再是保证，只是一条代码约定。
 *
 * 新模型没有 `status`、也没有 `VOID`：凭证一经追加即事实。
 * 红冲 = **追加**一张 `source: 'REVERSE'` 的反向凭证，原凭证仍在 `readAll()` 里、
 * 仍然计入余额，两者正负相抵为 0。因此这里**不过滤任何凭证**，
 * 也不需要 `isEffective` / `effectiveVouchers` 这类闸门 —— 闸门的存在本身
 * 就意味着「有些已落账的凭证不算数」，而那正是要消灭的东西。
 */
import type { Cents } from './money';
import { periodOf } from './money';
import type { PostedVoucher } from './types';
import { MONEY_CODES } from './accounts';

/** 一个科目的借贷发生额与净额。`netDebitCents > 0` 表示借方余额。 */
export interface Balance {
  readonly code: string;
  readonly debitCents: Cents;
  readonly creditCents: Cents;
  /** 借 − 贷，借方为正。资产类正常为正，负债/权益/收入类正常为负。 */
  readonly netDebitCents: Cents;
}

/**
 * 按科目归集借贷发生额。
 *
 * 这是**全仓唯一的余额出口**：报表、断言、交付包都从这里取数。
 * 多写一份求和，就会出现「明细账和资产负债表差 1 分」这种查不出来源的差异。
 */
export function balances(vouchers: readonly PostedVoucher[]): Map<string, Balance> {
  const map = new Map<string, Balance>();
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      const current = map.get(line.accountCode) ?? {
        code: line.accountCode,
        debitCents: 0,
        creditCents: 0,
        netDebitCents: 0,
      };
      const debitCents = line.direction === 'DEBIT' ? current.debitCents + line.amountCents : current.debitCents;
      const creditCents = line.direction === 'CREDIT' ? current.creditCents + line.amountCents : current.creditCents;
      map.set(line.accountCode, {
        code: line.accountCode,
        debitCents,
        creditCents,
        netDebitCents: debitCents - creditCents,
      });
    }
  }
  return map;
}

/** 前缀净借方（借方为正）。父级科目取数用它，避免每个报表各写一遍 `startsWith`。 */
export function netDebitByPrefix(vouchers: readonly PostedVoucher[], prefix: string): Cents {
  let sum = 0;
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      if (!line.accountCode.startsWith(prefix)) continue;
      sum += line.direction === 'DEBIT' ? line.amountCents : -line.amountCents;
    }
  }
  return sum;
}

/** 前缀贷方发生额（贷方为正）。收入口径用它：贷方记增加，借方（红冲）自然冲减。 */
export function creditByPrefix(vouchers: readonly PostedVoucher[], prefix: string): Cents {
  let sum = 0;
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      if (!line.accountCode.startsWith(prefix)) continue;
      sum += line.direction === 'CREDIT' ? line.amountCents : -line.amountCents;
    }
  }
  return sum;
}

/** 试算平衡结论。`diffCents` 不只是给 B1 报错用，也是「差多少」的唯一证据来源。 */
export interface TrialBalance {
  readonly debitCents: Cents;
  readonly creditCents: Cents;
  readonly balanced: boolean;
  readonly diffCents: Cents;
}

/**
 * 全账试算平衡：借方发生额合计 vs 贷方发生额合计。
 *
 * 注意它**只能证明分录整体自洽**，不能证明账是对的：
 * 借 560205 办公费 / 贷 3104 利润分配 也是一张完全平衡的凭证。
 * 「查不出什么」必须随结论一起交出去（`AssertionResult.limitation`）。
 */
export function trialBalance(vouchers: readonly PostedVoucher[]): TrialBalance {
  let debitCents = 0;
  let creditCents = 0;
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      if (line.direction === 'DEBIT') debitCents += line.amountCents;
      else creditCents += line.amountCents;
    }
  }
  return { debitCents, creditCents, balanced: debitCents === creditCents, diffCents: debitCents - creditCents };
}

/** 货币资金合计（资产负债表口径，也是 B4 的账面方）。科目表改一处，这里自动跟上。 */
export function moneyBalance(vouchers: readonly PostedVoucher[]): Cents {
  return MONEY_CODES.reduce((sum, code) => sum + netDebitByPrefix(vouchers, code), 0);
}

/** 某期间的凭证（含红冲与红冲后的原凭证，两者都在）。 */
export function vouchersInPeriod(vouchers: readonly PostedVoucher[], periodId: string): readonly PostedVoucher[] {
  return vouchers.filter((voucher) => voucher.periodId === periodId);
}

/** 日期闭区间内的凭证。`voucherDate` 是 `YYYY-MM-DD`，等长字符串可直接比较。 */
export function vouchersInRange(vouchers: readonly PostedVoucher[], start: string, end: string): readonly PostedVoucher[] {
  return vouchers.filter((voucher) => voucher.voucherDate >= start && voucher.voucherDate <= end);
}

/** 某日（含）之前的凭证。期末时点取数用它。 */
export function vouchersUntil(vouchers: readonly PostedVoucher[], date: string): readonly PostedVoucher[] {
  return vouchers.filter((voucher) => voucher.voucherDate <= date);
}

/** 一条期间派生不一致。 */
export interface PeriodViolation {
  readonly voucherId: string;
  readonly periodId: string;
  readonly expected: string;
}

/**
 * `periodId` 必须由 `voucherDate` 派生。落账入口已经拦过，
 * 这里再查一遍是因为**磁盘上的凭证可能来自旧版本或人工修补**，
 * 而期间错位的后果（报表整月错位）在数据表面完全看不出来。
 */
export function periodIntegrityViolations(vouchers: readonly PostedVoucher[]): readonly PeriodViolation[] {
  const violations: PeriodViolation[] = [];
  for (const voucher of vouchers) {
    const expected = periodOf(voucher.voucherDate);
    if (voucher.periodId !== expected) {
      violations.push({ voucherId: voucher.voucherId, periodId: voucher.periodId, expected });
    }
  }
  return violations;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 明细账
 * ──────────────────────────────────────────────────────────────────────────── */

/** 明细账的一行。 */
export interface LedgerRow {
  readonly voucherId: string;
  readonly voucherDate: string;
  readonly voucherNo: string;
  readonly summary: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amountCents: Cents;
  /** 记完这一行之后的余额（借正贷负，与科目余额表同一口径）。 */
  readonly balanceCents: Cents;
  /** 红冲凭证指回的原凭证；普通凭证为 `null`。 */
  readonly reverses: string | null;
}

export interface AccountLedger {
  readonly code: string;
  /** 区间开始之前的余额。不传区间时为 0。 */
  readonly openingCents: Cents;
  readonly rows: readonly LedgerRow[];
  readonly closingCents: Cents;
  readonly debitTotalCents: Cents;
  readonly creditTotalCents: Cents;
}

export interface LedgerRange {
  readonly from?: string;
  readonly to?: string;
}

const inRange = (date: string, range: LedgerRange): boolean =>
  (range.from === undefined || date >= range.from) && (range.to === undefined || date <= range.to);

/**
 * 某个科目的明细账。
 *
 * 两个顺序上的注意：
 *
 * 1. **按「日期 + 凭证号」排，不按落账顺序**。明细账是给人查账的，
 *    落账顺序（先记哪张后记哪张）在查账时没有意义，反而会让"11 月的账"
 *    中间夹着一条 10 月补录的、余额一路跳。余额是按这个顺序滚动累加的，
 *    换顺序会让每一行的余额都变——所以这里必须一次定死。
 * 2. **期初 = 区间之前所有分录的净额**，不是"上月结转"。没有结账也能看明细账，
 *    因为余额本来就是连续的，不需要结转来"归零"。
 */
export function accountLedger(
  vouchers: readonly PostedVoucher[],
  code: string,
  range: LedgerRange = {},
): AccountLedger {
  const ordered = [...vouchers].sort((left, right) =>
    left.voucherDate === right.voucherDate
      ? left.voucherNo.localeCompare(right.voucherNo)
      : left.voucherDate < right.voucherDate
        ? -1
        : 1,
  );

  // 期初单独算一遍：余额要**从期初起滚**，不能从 0 起滚——否则区间内第一行的余额
  // 会漏掉区间之前的累计，而后面每一行的余额跟着一起错，且错得很像"正常"。
  let opening = 0;
  if (range.from !== undefined) {
    for (const voucher of ordered) {
      if (voucher.voucherDate >= range.from) break;
      for (const line of voucher.lines) {
        if (line.accountCode !== code) continue;
        opening += line.direction === 'DEBIT' ? line.amountCents : -line.amountCents;
      }
    }
  }

  let running = opening;
  let debitTotal = 0;
  let creditTotal = 0;
  const rows: LedgerRow[] = [];

  for (const voucher of ordered) {
    for (const line of voucher.lines) {
      if (line.accountCode !== code) continue;
      if (!inRange(voucher.voucherDate, range)) continue;
      const delta = line.direction === 'DEBIT' ? line.amountCents : -line.amountCents;
      running += delta;
      if (line.direction === 'DEBIT') debitTotal += line.amountCents;
      else creditTotal += line.amountCents;
      rows.push({
        voucherId: voucher.voucherId,
        voucherDate: voucher.voucherDate,
        voucherNo: voucher.voucherNo,
        summary: voucher.summary,
        direction: line.direction,
        amountCents: line.amountCents,
        balanceCents: running,
        reverses: voucher.reverses ?? null,
      });
    }
  }

  return {
    code,
    openingCents: opening,
    rows,
    closingCents: running,
    debitTotalCents: debitTotal,
    creditTotalCents: creditTotal,
  };
}
