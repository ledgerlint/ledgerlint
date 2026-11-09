/**
 * 手工录入凭证（T35）。
 *
 * 为什么必须有这个入口：银行流水只覆盖「钱动了」的业务。计提、摊销、结转、
 * 期末调整、以及用股东垫资直接付掉的费用，都不在任何一份流水里。
 * 没有它，「用这个工具记账」就只能记一半——另一半得回到 Excel，
 * 而回到 Excel 的那一刻，这套账就不再是唯一真相源了。
 *
 * 三条边界：
 *
 * 1. **校验全部交给 `post()`**，这里只做「把界面输入翻译成凭证体」。
 *    再写一套校验必然与 `post()` 漂移，漂移的那天会出现「界面说没问题、
 *    落账被拒」或者更糟的反向情况。
 * 2. **不做「自动配平」**。看起来贴心的「差额自动记财务费用」正是错账的来源：
 *    用户少填一行，程序替他补一行，账平了，但每一分钱都在错的科目上。
 * 3. **`source: 'MANUAL'` 且不带 `hit`**：手工凭证没有规则依据，
 *    留空比编一条「MANUAL 规则」诚实。
 */
import { randomBytes } from 'node:crypto';
import { entryLine } from '../lines';
import { parseYuan, periodOf } from '../money';
import type { Cents, JournalLine, PostedVoucher } from '../types';
import { nextVoucherNo, post } from '../voucher';
import { createJournal, JournalError } from './io';

/** 界面上的一行。金额是**人输入的元字符串**，不是分——由这一层负责解析。 */
export interface ManualLineInput {
  readonly accountCode: string;
  readonly direction: JournalLine['direction'];
  /** 「元」的原样文本，如 `1200.50`；也接受 `1,200.5`、`¥1200`。 */
  readonly amount: string;
  /** 1122/2202/2203 必填；`post()` 会校验，但先在这里翻译成人话更早。 */
  readonly counterparty?: string;
}

export interface ManualVoucherInput {
  readonly voucherDate: string;
  readonly summary: string;
  readonly lines: readonly ManualLineInput[];
  /** 仅测试用：让凭证 ID 可预期。生产路径不传，由时间戳 + 随机后缀生成。 */
  readonly voucherId?: string;
}

export interface ManualVoucherResult {
  readonly voucherId: string;
  readonly voucherNo: string;
  readonly periodId: string;
  readonly hash: string;
}

/**
 * 手填的凭证 ID。
 *
 * 不用自增序号：删除/恢复账套后序号会重排，而 `voucherId` 一旦写进链就永不变化，
 * 两个凭证同 ID 会让「红冲指向哪一张」变成猜谜。时间戳 + 随机后缀不依赖任何状态。
 */
function makeVoucherId(): string {
  return `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** 元字符串 → 正数分。非正数在这里就拦，报错说的是「金额」，不是「分录某字段」。 */
function amountOf(line: ManualLineInput, index: number): Cents {
  const cents = parseYuan(line.amount);
  if (cents <= 0) {
    throw new Error(`第 ${index + 1} 行金额必须大于 0（方向用借/贷表示，不要用负号）。`);
  }
  return cents;
}

export async function postManualVoucher(
  rootDir: string,
  input: ManualVoucherInput,
): Promise<ManualVoucherResult> {
  if (input.lines.length < 2) {
    throw new Error('至少要有两行分录：一借一贷。只有一行的凭证不可能平。');
  }

  const lines: JournalLine[] = input.lines.map((line, index) =>
    entryLine(
      line.accountCode,
      line.direction,
      amountOf(line, index),
      line.counterparty === undefined || line.counterparty.trim() === ''
        ? {}
        : { counterparty: line.counterparty.trim() },
    ),
  );

  const journal = await createJournal(rootDir);
  const period = periodOf(input.voucherDate);
  const voucherId = input.voucherId ?? makeVoucherId();

  // 取号发生在 `append` 的写锁之外：两个人同时点「记入账本」会算出同一个凭证号，
  // 先到的赢，后到的撞号。撞号不是用户的错，重算一次就好——所以这里重试而不是直接失败。
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing: Pick<PostedVoucher, 'periodId' | 'voucherNo'>[] = [];
    for await (const voucher of journal.readAll()) {
      existing.push({ periodId: voucher.periodId, voucherNo: voucher.voucherNo });
    }
    const voucherNo = nextVoucherNo(existing, period);

    // 借贷不平、科目非末级、往来缺对象、摘要为空——全部在 post() 里拦，
    // 抛出的是中文整句，界面直接显示给用户。放在 try 外面：校验错重试没有意义。
    const body = post({
      voucherId,
      voucherDate: input.voucherDate,
      summary: input.summary,
      voucherNo,
      lines,
      source: 'MANUAL',
      ruleSnapshot: {},
    });

    try {
      const { hash } = await journal.append(period, body);
      return { voucherId, voucherNo, periodId: period, hash };
    } catch (error) {
      if (!(error instanceof JournalError) || error.code !== 'DUPLICATE_VOUCHER_NO') throw error;
      lastError = error;
    }
  }

  throw lastError ?? new Error('连续三次取号都撞上了，请稍后再试。');
}
