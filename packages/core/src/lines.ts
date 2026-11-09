/**
 * 分录行构造器（T05）。
 *
 * 抽出来的唯一理由是**科目名的来源必须唯一**：分录上的 `accountName` 是落账当时的
 * 科目名快照，只能从科目表抄一次。若让规则层、手工凭证、工资合并各写一份
 * 「code + 从科目表查名字」，迟早出现「凭证上的科目名和科目表对不上」——
 * 而没有任何一条断言会去查这种错，它只会以「报表科目名怪怪的」的形式被人偶然发现。
 */
import type { Cents } from './money';
import type { JournalLine } from './types';
import { account } from './accounts';

/** 调用方可以附带的信息。**不含金额、方向、科目**：那三个由参数强制给，不给覆盖的机会。 */
export type LineExtra = Partial<Pick<JournalLine, 'counterparty' | 'docNo'>>;

/**
 * 造一条分录。
 * @param code 末级科目编码；不存在会抛（科目编码的来源只允许 `accounts.ts`）
 * @param direction 借 / 贷
 * @param amountCents 整数分，恒为正；方向由 `direction` 表达
 */
export function entryLine(
  code: string,
  direction: JournalLine['direction'],
  amountCents: Cents,
  extra: LineExtra = {},
): JournalLine {
  return {
    accountCode: code,
    accountName: account(code).name,
    direction,
    amountCents,
    ...extra,
  };
}
