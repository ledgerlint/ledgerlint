/**
 * 哈希链（T04）：规范化序列化 + 链校验。纯函数，不碰文件系统。
 *
 * 不用 `JSON.stringify` 直接算 hash：键序由生产者决定，同一张凭证「内存 → 落盘 → 读回」
 * 后键序可能变化，hash 会在没人改过内容时自己变，而这种天天瞎响的警报最后一定被忽略。
 * 规范形式即落盘形式（`sealVoucherLine`），所以链上没有两套顺序可以漂移。
 */
import { createHash } from 'node:crypto';

import type { BasisRef, ChainBreakReason, JournalLine, PostedVoucher, Question, RuleHit } from '../types';

/** 链头占位：第一张凭证的 `prevHash`。64 个 0 与 sha256 十六进制等长，比较时不必特判。 */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * 断裂形态已上移到 `types.ts`（D002-D2-2：`JournalPort.verify` 要返回它，留在本文件
 * 会形成 types → journal 的反向依赖）。此处 re-export 只为不打断既有 import 路径。
 */
export type { ChainBreakReason };

/** 一次断裂定位。`breakAt` 必须是精确的 `voucherId`——只说「链断了」等于没查。 */
export interface ChainBreak {
  readonly breakAt: string;
  readonly reason: ChainBreakReason;
  readonly detail: string;
}

/** 一张凭证 + 它在磁盘上的位置。链校验需要位置，否则查不出「行被对调」。 */
export interface LocatedVoucher {
  readonly voucher: PostedVoucher;
  readonly period: string;
  readonly lineNo: number;
}

/** 待落账凭证体：链上两个字段由实现计算，调用方传不进来（见 `JournalPort`）。 */
export type VoucherBody = Omit<PostedVoucher, 'prevHash' | 'hash'>;

/** 补齐 `prevHash`、尚缺 `hash` 的中间态——正是被哈希的输入。 */
export type VoucherWithoutHash = VoucherBody & { readonly prevHash: string };

/** 可哈希输入：完整凭证也行，`hash` 会被忽略。 */
export type HashableVoucher = VoucherWithoutHash | PostedVoucher;

/** 序列化不了。它属于「无法判定」，绝不能当成「内容正确」放行。 */
export class ChainFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainFormatError';
  }
}

/**
 * 顶层字段顺序。**这个数组是协议的一部分：改它等于让全部历史 hash 失效。**
 * `prevHash` 打头，让「接在谁后面」与「自己是什么」在同一次哈希里一起被锁住，
 * 否则把整张凭证搬到链的另一处就能不留痕。
 */
export const VOUCHER_FIELD_ORDER = [
  // `summary` 插在 `voucherDate` 之后、`lines` 之前（D004 指定的位置）：抬头信息（日期、摘要）
  // 先于明细（分录）。**顺序即协议**——挪一个位置，全部历史 hash 立刻失效。
  'prevHash', 'voucherId', 'periodId', 'voucherNo', 'voucherDate', 'summary', 'lines',
  'totalDebitCents', 'totalCreditCents', 'source', 'reverses', 'ruleSnapshot', 'hit',
] as const;

/* 以下四个嵌套顺序同样是协议；数组顺序即语义（分录、依据、问句都不能排序）。 */
const LINE_ORDER = ['accountCode', 'accountName', 'direction', 'amountCents', 'counterparty', 'docNo'] as const;
const HIT_ORDER = ['ruleId', 'ruleVersion', 'event', 'confidence', 'assumed', 'oneLiner', 'basis', 'questions'] as const;
const QUESTION_ORDER = ['id', 'prompt', 'options', 'answer'] as const;
const BASIS_ORDER: Readonly<Record<BasisRef['kind'], readonly string[]>> = {
  RULE: ['kind', 'file', 'line'],
  TXN: ['kind', 'txnId', 'rowNo'],
  INVOICE: ['kind', 'invoiceNo'],
  CITE: ['kind', 'text', 'url'],
};

/** 单字段编码器；默认 `encodeScalar`，嵌套结构按 key 覆盖。 */
type FieldEncoders = Readonly<Record<string, (value: unknown) => string>>;

/** 只读接口没有索引签名，编码器要按键取值；这是唯一一处必要的类型桥。 */
function asRecord(value: object): Readonly<Record<string, unknown>> {
  return value as unknown as Readonly<Record<string, unknown>>;
}

/** 基元编码。金额必须是安全整数：一旦丢精度，序列化不可逆，等于改账。 */
function encodeScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ChainFormatError(`只允许安全整数（整数分），收到 ${String(value)}`);
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  throw new ChainFormatError(`规范化序列化不支持 ${typeof value} 类型的值`);
}

const encodeStrings = (values: readonly string[]): string => `[${values.map(encodeScalar).join(',')}]`;

/**
 * 按给定顺序编码对象。`undefined` 一律跳过：它与「字段缺失」落盘后无法区分，
 * 编进去会让内存里的凭证与读回来的凭证算出两个 hash。未登记字段直接抛错：
 * 静默丢弃等于给「改一个不进哈希的字段」开一条无痕通道。
 */
function encodeObject(
  record: Readonly<Record<string, unknown>>,
  order: readonly string[],
  encoders: FieldEncoders = {},
  ignored: readonly string[] = [],
): string {
  const parts: string[] = [];
  for (const key of order) {
    const value = record[key];
    if (value === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${(encoders[key] ?? encodeScalar)(value)}`);
  }
  for (const key of Object.keys(record)) {
    if (order.includes(key) || ignored.includes(key) || record[key] === undefined) continue;
    throw new ChainFormatError(`字段 ${key} 不在规范化序列化范围内：新增字段等于改协议，必须显式迁移链`);
  }
  return `{${parts.join(',')}}`;
}

const QUESTION_ENCODERS: FieldEncoders = { options: (value) => encodeStrings(value as readonly string[]) };

const HIT_ENCODERS: FieldEncoders = {
  assumed: (value) => encodeStrings(value as readonly string[]),
  basis: (value) => `[${(value as readonly BasisRef[]).map((b) => encodeObject(asRecord(b), BASIS_ORDER[b.kind])).join(',')}]`,
  questions: (value) =>
    `[${(value as readonly Question[]).map((q) => encodeObject(asRecord(q), QUESTION_ORDER, QUESTION_ENCODERS)).join(',')}]`,
};

const VOUCHER_ENCODERS: FieldEncoders = {
  lines: (value) => `[${(value as readonly JournalLine[]).map((line) => encodeObject(asRecord(line), LINE_ORDER)).join(',')}]`,
  // 规则快照按键名字典序：对象键序不是协议，字典序是唯一稳定口径。
  ruleSnapshot: (value) => {
    const snapshot = value as Readonly<Record<string, string>>;
    const parts = Object.keys(snapshot).sort().map((key) => `${JSON.stringify(key)}:${encodeScalar(snapshot[key])}`);
    return `{${parts.join(',')}}`;
  },
  hit: (value) => encodeObject(asRecord(value as RuleHit), HIT_ORDER, HIT_ENCODERS),
};

/**
 * 规范化序列化：不含 `hash` 自身（自指无解），含 `prevHash` 与全部业务字段。
 * @throws {ChainFormatError} 遇到未登记字段或不可编码的值
 */
export function canonicalize(voucher: HashableVoucher): string {
  return encodeObject(asRecord(voucher), VOUCHER_FIELD_ORDER, VOUCHER_ENCODERS, ['hash']);
}

/** `sha256(canonicalize(voucher))`，64 位小写十六进制（算法由本文件定死，故不加前缀）。 */
export function hashVoucher(voucher: HashableVoucher): string {
  return createHash('sha256').update(canonicalize(voucher), 'utf8').digest('hex');
}

/** 落盘一行 = 规范形式补上 `hash`：落盘与哈希共用一份序列化，不存在两套顺序。 */
export function sealVoucherLine(voucher: PostedVoucher): string {
  return `${canonicalize(voucher).slice(0, -1)},"hash":${encodeScalar(voucher.hash)}}`;
}

/**
 * 校验整条链。`entries` 按「分片名升序 + 分片内行号升序」给出。
 * @returns 第一处断裂；全链完好返回 `null`
 */
export function verifyChain(entries: readonly LocatedVoucher[]): ChainBreak | null {
  if (entries.length === 0) return null;

  // 1) 逐张重算 hash。这是唯一能定位到「具体哪一张」的通道，所以排在最前。
  for (const entry of entries) {
    const breakAt = entry.voucher.voucherId;
    let recomputed: string;
    try {
      recomputed = hashVoucher(entry.voucher);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { breakAt, reason: 'CANONICALIZE_FAILED', detail };
    }
    if (recomputed !== entry.voucher.hash) {
      return { breakAt, reason: 'HASH_MISMATCH', detail: `重算 ${recomputed} ≠ 落盘 ${entry.voucher.hash}` };
    }
  }

  // 2) 用 prevHash 重建落账顺序。它只能从指针读出，不能从日期推——
  //    补录上月凭证时，它接的是「当下最后一张」，不是上月最后一张。
  const childrenOf = new Map<string, LocatedVoucher[]>();
  for (const entry of entries) {
    const siblings = childrenOf.get(entry.voucher.prevHash);
    if (siblings === undefined) childrenOf.set(entry.voucher.prevHash, [entry]);
    else siblings.push(entry);
  }

  const heads = childrenOf.get(GENESIS_PREV_HASH) ?? [];
  const firstHead = heads[0];
  if (firstHead === undefined) {
    const detail = `没有任何凭证的 prevHash 等于链头 ${GENESIS_PREV_HASH}`;
    return { breakAt: entries[0]?.voucher.voucherId ?? '', reason: 'PREV_HASH_MISMATCH', detail };
  }
  if (heads.length > 1) {
    const detail = `有 ${heads.length} 张凭证都自称链上第一张`;
    return { breakAt: heads[1]?.voucher.voucherId ?? '', reason: 'FORK', detail };
  }

  const ordered: LocatedVoucher[] = [];
  let cursor: LocatedVoucher | undefined = firstHead;
  // 上界 entries.length 兼作环的保险丝：指针成环时宁可报断，也不能挂死。
  while (cursor !== undefined && ordered.length <= entries.length) {
    ordered.push(cursor);
    const next: readonly LocatedVoucher[] = childrenOf.get(cursor.voucher.hash) ?? [];
    if (next.length > 1) {
      const detail = `两张凭证都把 prevHash 指向 ${cursor.voucher.voucherId}`;
      return { breakAt: next[1]?.voucher.voucherId ?? '', reason: 'FORK', detail };
    }
    cursor = next[0];
  }

  if (ordered.length !== entries.length) {
    const reached = new Set(ordered.map((entry) => entry.voucher.voucherId));
    const orphan = entries.find((entry) => !reached.has(entry.voucher.voucherId));
    const detail = `${entries.length - ordered.length} 张凭证不在链上：prevHash 指向已不存在的凭证`;
    return { breakAt: orphan?.voucher.voucherId ?? '', reason: 'PREV_HASH_MISMATCH', detail };
  }

  // 3) 分片内行号必须与链序同向递增。指针只锁「谁接谁」，锁不住「文件里第几行」，
  //    而对调两行正是不改任何内容、只改位置的一种破坏。
  const lastLineByPeriod = new Map<string, number>();
  for (const entry of ordered) {
    const previousLine = lastLineByPeriod.get(entry.period);
    if (previousLine !== undefined && entry.lineNo <= previousLine) {
      const detail = `${entry.period}.jsonl 第 ${entry.lineNo} 行出现在第 ${previousLine} 行之后，与链序矛盾`;
      return { breakAt: entry.voucher.voucherId, reason: 'ORDER_MISMATCH', detail };
    }
    lastLineByPeriod.set(entry.period, entry.lineNo);
  }

  return null;
}
