/**
 * 金额与日期（T05 迁移 + T30 归位）：整数分、期间派生、**全仓唯一的价税分离实现**。
 *
 * `Cents` 的定义在 `types.ts`（契约冻结），本文件只转出、不另立一份：
 * 两个同名类型在给 `Cents` 加 brand 的那天会变成两个互不兼容的类型，
 * 而编译器只会报一个看不懂的错。
 *
 * 铁律：金额一律整数分；任何「除以 1 + 税率 / 除以 2 / 按期分摊」只在本文件做，
 * 且必须过 `roundCents` —— 一处例外就够让 B3（价税分离）在**本该绿**的月份红灯，
 * 红灯变成噪音之后，机检等于不存在。
 */
import type { Cents } from './types';

export type { Cents };

/**
 * 四舍五入到分。
 *
 * 加 1e-6 抵的是二进制浮点噪声：`103000 / 1.03` 会算出 99999.99999999999，
 * 到了 .5 边界（如 10150/1.01 = 10049.50495）`Math.round` 会被这点噪声推向错误方向。
 * NaN / Infinity 不许静默变成 0：金额入参坏了必须当场炸，不能记一笔「0 元」。
 */
export function roundCents(x: number): Cents {
  if (!Number.isFinite(x)) throw new Error(`金额非法：${String(x)}`);
  return Math.round(x + 1e-6);
}

/** 元 → 分。只用于**输入换算**与展示，内部一律用分。 */
export function fromYuan(y: number): Cents {
  return roundCents(y * 100);
}

/** 分 → 元字符串（两位小数）。只用于展示与人读的报错文案。 */
export function toYuan(cents: Cents): string {
  return (cents / 100).toFixed(2);
}

/**
 * 人输入的「元」→ 整数分（手工记账的文本框、CLI 参数都走这里）。
 *
 * 为什么不用 `fromYuan(Number(text))`：`Number('0.1') * 100` 是 10.000000000000002，
 * 靠 `roundCents` 能在大多数情况下救回来，但那是**把一个输入解析问题交给浮点容差兜**。
 * 金额是从字符串里逐位抄下来的，就应当在字符串上算完：整数部分 × 100 + 补足两位的小数部分。
 *
 * 允许的写法：`1200`、`1200.5`、`1200.50`、`1,200.50`（千分位）、`¥1200`、`￥1,200.5`。
 * 不允许：三位以上小数（1.005 是记不进分的，让人改，而不是替他四舍五入），
 * 科学计数法、空串、中文数字。负数照收——分录金额不许为负由 `post()` 管，
 * 这里不越权，否则「Excel 粘进来的 -500」会得到一句和金额格式无关的错。
 */
export function parseYuan(text: string): Cents {
  const cleaned = text.trim().replace(/[,，\s]/g, '').replace(/^[¥￥]/, '');
  const matched = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (matched === null) {
    throw new Error(`金额「${text.trim()}」读不出来：只能是数字，最多两位小数（例如 1200 或 1200.50）。`);
  }
  const cents = Number(matched[2]) * 100 + Number((matched[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`金额「${text.trim()}」太大，超出可记录范围。`);
  return matched[1] === '-' ? -cents : cents;
}

/**
 * 是不是「整数分」。允许 0 与负数：余额、净额、差额都会是负的。
 * `Number.isSafeInteger` 一并拒掉小数、NaN、Infinity 与超出 2^53 的值。
 */
export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** 运行期校验：坏金额当场抛，不返回兜底值。 */
export function assertCents(value: unknown, label = '金额'): Cents {
  if (!isCents(value)) throw new Error(`${label}必须是整数分（安全整数），收到 ${String(value)}`);
  return value;
}

/** 是不是一笔「可以入账」的金额：正整数分。红冲靠方向表达，不靠负号。 */
export function isValidAmount(cents: unknown): cents is Cents {
  return isCents(cents) && cents > 0;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 校验 `YYYY-MM-DD` 且是真实存在的日期。2026-06-31 必须先在这里死掉。 */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/**
 * 期间编号 `YYYY-MM`，**由业务日期派生，不允许独立赋值**。
 *
 * 全仓只此一处派生期间。期间与日期各存一份，必然出现「12 月的凭证挂在 11 月」，
 * 而它从数据表面完全看不出来，只会让报表整月错位。
 */
export function periodOf(date: string): string {
  if (!isValidDate(date)) throw new Error(`日期非法：${date}`);
  return date.slice(0, 7);
}

/** 期间的起止日。月末按真实天数算，不生成 2026-06-31。 */
export function periodRange(period: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (match === null) throw new Error(`期间非法：${period}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`期间非法：${period}`);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, '0')}` };
}

/** 季度 → 起止日。季度末尾同样按真实天数，Q2 是 -06-30 而不是 -06-31。 */
export function quarterRange(period: string): { start: string; end: string } {
  const match = /^(\d{4})-Q([1-4])$/.exec(period);
  if (match === null) throw new Error(`季度非法：${period}`);
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { start: `${year}-${pad(startMonth)}-01`, end: `${year}-${pad(endMonth)}-${pad(lastDay)}` };
}

/**
 * 含税金额 → { 不含税, 税额 }。**全仓唯一的价税分离实现（T30）**。
 *
 * 生成侧（规则层把 2,030.00 元含税收款拆成收入与销项税）与判定侧（B3 复核这个拆分）
 * 必须调用同一个函数。两处各写一份必然分叉 —— 一方 `Math.round`、一方 `floor`，
 * 或者一方按 1%、一方按 3%，差 1 分就能把「本该绿」的月份判成红灯，而没人能说清是谁错。
 *
 * 税额用**减法**得到（`总额 - 净额`），不用 `总额 × 税率` 再四舍五入：
 * 后者与净额各自独立取整，`净 + 税 ≠ 总额` 的概率不低，而这正是 B1 借贷平衡要抓的缺口。
 *
 * @param amountCents 含税总额，整数分，必须为正
 * @param rate 征收率（0.01 = 1%）。为 0 时净额即总额、税额为 0（免税也走这条路径）
 */
export function splitInclusive(amountCents: Cents, rate: number): { netCents: Cents; taxCents: Cents } {
  assertCents(amountCents, '含税金额');
  if (amountCents <= 0) throw new Error(`含税金额必须为正整数分，收到 ${String(amountCents)}`);
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`征收率非法：${String(rate)}`);
  const netCents = roundCents(amountCents / (1 + rate));
  return { netCents, taxCents: amountCents - netCents };
}

/** 日期先后比较。格式固定为等长字符串，字典序即时间序，不必转 Date（转了就有时区）。 */
export const dateLt = (left: string, right: string): boolean => left < right;
