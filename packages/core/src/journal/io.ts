/**
 * journal 的唯一写入口（T03）：append-only、月分片、启动索引、崩溃恢复。
 *
 * 全仓只有本文件的 `append` 会写 `journal/*.jsonl`（注入点只有一个实现）。布局
 * `<root>/journal/YYYY-MM.jsonl`，一行一张凭证；按月分片是因为期间天然是分片键。
 */
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';

import { isValidDate, periodOf } from '../money';
import type { ChainBreakReason, JournalPort, JournalWarning, JournalWarningCode, PostedVoucher } from '../types';

import type { LocatedVoucher, VoucherBody } from './chain';
import { GENESIS_PREV_HASH, hashVoucher, sealVoucherLine, verifyChain } from './chain';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 调用方用错了。静默兜底会让「12 月的凭证挂进 11 月」从数据表面彻底消失。 */
export type JournalErrorCode = 'BAD_PERIOD' | 'BAD_DATE' | 'PERIOD_MISMATCH';

export class JournalError extends Error {
  readonly code: JournalErrorCode;

  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}

/** 这两个类型已上移到 `types.ts`（D002-D2-2）；re-export 只为不打断既有 import 路径。 */
export type { ChainBreakReason, JournalWarning, JournalWarningCode };
/** 启动索引一行：`append` 取 `prevHash`、报数都不必再读文件。 */
export interface JournalShardIndex { readonly period: string; readonly count: number; readonly lastHash: string }

/**
 * `verify()` 结果。`ok` 只允许表示「链完整且没有已知损伤」（D002-D2-3）：
 * 已知损伤要么拉红，要么必须在 `warnings` 里显形——调用方不得只读 `ok`。
 */
export interface JournalVerifyResult {
  readonly ok: boolean;
  readonly breakAt?: string;
  readonly reason?: ChainBreakReason;
  readonly detail?: string;
  readonly warnings: readonly JournalWarning[];
}

/** 注入了文件系统的 `JournalPort`；读写方法与冻结契约逐字一致。 */
export interface JournalHandle extends JournalPort {
  readonly rootDir: string;
  index(): readonly JournalShardIndex[];
  warnings(): readonly JournalWarning[];
  verify(): Promise<JournalVerifyResult>;
}

/**
 * 锚点文件名（D002-D2-5）。它与 journal **同目录、可被一并修改**——这是已知局限，
 * 见 `JOURNAL_LIMITATIONS` 第 1 条。它防的是误删与换机恢复旧备份，不防有意的内部篡改。
 */
const HEAD_FILE = '.head.json';

/** 锚点内容。`count` 是**全账套**凭证总数，不是分片内张数。 */
interface JournalHead {
  readonly period: string;
  readonly lastHash: string;
  readonly count: number;
  readonly updatedAt: string;
}

/** 本模块**已知查不出什么**。T44 直接消费这个常量：只写在报告里的边界，交付包里等于不存在。 */
export const JOURNAL_LIMITATIONS: readonly string[] = [
  '锚点在本地（journal/.head.json），可与 journal 一并被修改：它防的是误删与换机恢复旧备份，不防有意的内部篡改。',
  'verify 只证明「文件里的凭证与链一致」，不能证明这些就是全部业务事实：漏记一笔流水与「本来就没这笔」在链内同形，归 B1–B5 与 A1/A4 管。',
  '断电若发生在凭证行已落盘、.head.json 尚未更新之间，verify 会报 HEAD_MISMATCH（与「末尾被删」同形）；下一次 append 会用实际张数重写锚点自愈。',
  '崩溃残片修复后会在分片里留下一行永久垃圾行（append-only 不许删），此后 verify 恒为 ok:false（UNPARSEABLE_LINE），直到人工按 .head.json 核对并处置；系统不自动改写历史文件。',
  '分片内行号校验只能发现「同一文件内对调两行」；把整段凭证搬到另一个分片而链仍连通时不可见。',
  'updatedAt 取本机时钟，可被回拨或伪造，不构成时间证据。',
  '启动索引是全量扫描，凭证数上万后启动耗时会线性上升（未做增量索引）。',
];

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

/** 落盘一行是否配得上 `PostedVoucher`。只判形状；账务合理性归 B1/B2。 */
function looksLikeVoucher(value: unknown): value is PostedVoucher {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const keyed = ['voucherId', 'periodId', 'voucherDate', 'prevHash', 'hash'].every((k) => typeof r[k] === 'string');
  return keyed && Array.isArray(r['lines']) && typeof r['totalDebitCents'] === 'number' && typeof r['totalCreditCents'] === 'number';
}

/** 目录 fsync：让「刚建的分片文件」这个目录项也落盘。Windows 不允许 open 目录，忽略即可。 */
async function syncDir(path: string): Promise<void> {
  try {
    const dir = await fsp.open(path, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // 平台无此语义；文件本身已 fsync，这里没有可补的动作。
  }
}

/**
 * 打开（必要时创建）一个账套的 journal，并扫全部分片建内存索引。
 *
 * 启动时必须**用链指针找链尾**：补录上月凭证会写到更早的分片末尾，按期间猜就会接错 prevHash。
 * @param rootDir 账套根目录（`mybook/`），其下 `journal/` 按需创建
 */
export async function createJournal(rootDir: string): Promise<JournalHandle> {
  const journalDir = join(rootDir, 'journal');
  const shards = new Map<string, { count: number; lastHash: string }>();
  const warningLog: JournalWarning[] = [];
  const seenWarnings = new Set<string>();
  let tailHash = GENESIS_PREV_HASH;
  let totalCount = 0;
  let writeQueue: Promise<unknown> = Promise.resolve();
  let dirReady: Promise<void> | null = null;

  const shardPath = (period: string): string => join(journalDir, `${period}.jsonl`);

  /** 读锚点。缺失或损坏一律按「没有锚点」处理（由 HEAD_MISSING 显形），不抛断。 */
  async function readHead(): Promise<JournalHead | null> {
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(join(journalDir, HEAD_FILE), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const { period, lastHash, count, updatedAt } = record;
      if (typeof period !== 'string' || typeof lastHash !== 'string' || typeof count !== 'number') return null;
      return { period, lastHash, count, updatedAt: typeof updatedAt === 'string' ? updatedAt : '' };
    } catch {
      return null;
    }
  }

  /** 原子更新锚点：临时文件 → fsync → rename。读到半张锚点比没有锚点更坏（会报出不存在的断点）。 */
  async function writeHead(period: string, lastHash: string, count: number): Promise<void> {
    const head: JournalHead = { period, lastHash, count, updatedAt: new Date().toISOString() };
    const path = join(journalDir, HEAD_FILE);
    const handle = await fsp.open(`${path}.tmp`, 'w');
    try {
      await handle.write(`${JSON.stringify(head)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(`${path}.tmp`, path);
    await syncDir(journalDir);
  }

  /** 同一条 warning 只记一次：启动扫描与多次 `read` 会反复撞见同一个残片。 */
  function addWarning(code: JournalWarningCode, period: string, lineNo: number, message: string): void {
    const key = `${code}|${period}|${lineNo}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warningLog.push({ code, period, lineNo, message });
  }

  /** 期间只能是 `YYYY-MM`：放宽写法会让「按文件名排序 == 按时间排序」不再成立。 */
  function assertPeriod(period: string): void {
    if (!PERIOD_PATTERN.test(period)) throw new JournalError('BAD_PERIOD', `期间必须是 YYYY-MM，收到 ${period}`);
  }

  /** 期间只由 `money.periodOf` 派生一处：两处派生必然有一处先被改，而期间错位从数据表面看不出来。 */
  function assertPeriodMatches(period: string, draft: VoucherBody): void {
    if (!isValidDate(draft.voucherDate)) {
      throw new JournalError('BAD_DATE', `voucherDate 必须是真实存在的 YYYY-MM-DD，收到 ${draft.voucherDate}`);
    }
    const derived = periodOf(draft.voucherDate);
    if (derived !== period || draft.periodId !== derived) {
      const message = `append('${period}') / periodId ${draft.periodId} / voucherDate ${draft.voucherDate} 三者派生的期间不一致`;
      throw new JournalError('PERIOD_MISMATCH', message);
    }
  }

  async function listPeriods(): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await fsp.readdir(journalDir);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    // 期间字符串等长零填充，字典序即时间序。
    const periods = names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6));
    return periods.filter((period) => PERIOD_PATTERN.test(period)).sort();
  }

  /**
   * 读一个分片并逐张产出。不用 `readline`：它不告诉你最后一行有没有换行，
   * 而「有没有换行」正是区分「崩溃残片」与「坏数据」的唯一依据。
   */
  async function* readLocated(period: string): AsyncGenerator<LocatedVoucher> {
    assertPeriod(period);
    let text: string;
    try {
      text = await fsp.readFile(shardPath(period), 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (text.length === 0) return;
    const lines = text.split('\n');
    const torn = lines.pop() ?? '';
    if (torn !== '') {
      const bytes = Buffer.byteLength(torn, 'utf8');
      addWarning('TRUNCATED_TAIL', period, lines.length + 1, `末尾有 ${bytes} 字节残片（写入中断），已跳过`);
    }
    for (let index = 0; index < lines.length; index += 1) {
      const lineNo = index + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index] ?? '');
      } catch {
        addWarning('UNPARSEABLE_LINE', period, lineNo, '该行不是合法 JSON，疑似中断写入的残留');
        continue;
      }
      if (!looksLikeVoucher(parsed)) {
        addWarning('UNPARSEABLE_LINE', period, lineNo, '该行是 JSON 但不是一张凭证（缺链字段或分录）');
        continue;
      }
      if (parsed.periodId !== period) addWarning('SHARD_MISMATCH', period, lineNo, `凭证 ${parsed.voucherId} 期间为 ${parsed.periodId}`);
      yield { voucher: parsed, period, lineNo };
    }
  }

  async function* readAllLocated(): AsyncGenerator<LocatedVoucher> {
    for (const period of await listPeriods()) yield* readLocated(period);
  }

  /**
   * 单次追加：写一行 + `\n`，然后 `fsync`。写前补换行是**必须的**：上次若断在半行，
   * 新行会直接粘在残片尾部，一条残片会把紧随其后的那条真实记录一起毁掉。
   */
  async function appendLine(period: string, voucher: PostedVoucher): Promise<void> {
    if (dirReady === null) dirReady = fsp.mkdir(journalDir, { recursive: true }).then(() => undefined);
    await dirReady;
    const handle = await fsp.open(shardPath(period), 'a+');
    let created = false;
    try {
      const { size } = await handle.stat();
      created = size === 0;
      if (size > 0) {
        const probe = Buffer.alloc(1);
        const { bytesRead } = await handle.read(probe, 0, 1, size - 1);
        if (bytesRead !== 1 || probe[0] !== 0x0a) await handle.write('\n');
      }
      // 单次 write 一次系统调用；行与行之间不会交错（见 append 的写锁）。
      await handle.write(`${sealVoucherLine(voucher)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (created) await syncDir(journalDir);
  }

  /** 写入串行化。链是**全局**一条，并发 append 读到同一个 `prevHash` 就直接分叉。 */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => undefined);
    return run;
  }

  async function append(period: string, draft: VoucherBody): Promise<{ voucherId: string; prevHash: string; hash: string }> {
    // 参数错误在动文件之前抛：先写后校验会留下半张凭证。
    assertPeriod(period);
    assertPeriodMatches(period, draft);
    return enqueue(async () => {
      const prevHash = tailHash;
      const hash = hashVoucher({ ...draft, prevHash });
      await appendLine(period, { ...draft, prevHash, hash });
      // 索引与链尾只在写成功后推进：写失败时内存状态必须退回原样。
      tailHash = hash;
      totalCount += 1;
      shards.set(period, { count: (shards.get(period)?.count ?? 0) + 1, lastHash: hash });
      // 锚点最后写。若它失败，凭证行已在盘上、append 抛错——此时应先核对再重试，
      // 而不是盲目重发（重发会多出一张）。这条权衡写进 JOURNAL_LIMITATIONS 第 3 条。
      await writeHead(period, hash, totalCount);
      return { voucherId: draft.voucherId, prevHash, hash };
    });
  }

  async function verify(): Promise<JournalVerifyResult> {
    const entries: LocatedVoucher[] = [];
    for await (const located of readAllLocated()) entries.push(located);
    const tail = entries[entries.length - 1]?.voucher;
    const tailId = tail?.voucherId ?? '';

    // 1) 链内检查（内容 / 指针 / 顺序）：唯一能定位到「具体哪张凭证」的通道，排最前。
    const broken = verifyChain(entries);
    if (broken !== null) {
      return { ok: false, breakAt: broken.breakAt, reason: broken.reason, detail: broken.detail, warnings: [...warningLog] };
    }

    // 2) 中间坏行 = 有数据丢了或被手改，不能给绿（D002-D2-3）。尾部残片不在此列：
    //    它是一次可解释的中断，只拉 warning（见下面 head 分支之后的返回）。
    const unreadable = warningLog.find((item) => item.code === 'UNPARSEABLE_LINE');
    if (unreadable !== undefined) {
      const detail = `${unreadable.period}.jsonl 第 ${unreadable.lineNo} 行：${unreadable.message}`;
      return { ok: false, breakAt: tailId, reason: 'UNPARSEABLE_LINE', detail, warnings: [...warningLog] };
    }

    // 3) 链外锚点。链内分不清「末尾被删」与「从来没记过」，这一步才是那个区分（D002-D2-5）。
    const head = await readHead();
    if (head === null) {
      if (entries.length > 0) {
        addWarning('HEAD_MISSING', '', 0, `缺少 ${HEAD_FILE} 锚点：只能证明文件内自洽，判断不了末尾有没有被删`);
      }
      return { ok: true, warnings: [...warningLog] };
    }
    if (head.count === entries.length && head.lastHash === (tail?.hash ?? GENESIS_PREV_HASH)) {
      return { ok: true, warnings: [...warningLog] };
    }
    const detail =
      `锚点 count=${head.count} lastHash=${head.lastHash}，实际 count=${entries.length} ` +
      `lastHash=${tail?.hash ?? '（空）'}：可能是末尾被删，也可能是断电时锚点来不及更新（下次 append 会重写锚点自愈）`;
    return { ok: false, breakAt: tailId, reason: 'HEAD_MISMATCH', detail, warnings: [...warningLog] };
  }

  async function scan(): Promise<void> {
    const hashes = new Set<string>();
    const referenced = new Set<string>();
    let lastScannedHash = GENESIS_PREV_HASH;
    for (const period of await listPeriods()) {
      let count = 0;
      let lastHash = GENESIS_PREV_HASH;
      for await (const { voucher } of readLocated(period)) {
        count += 1;
        lastHash = voucher.hash;
        lastScannedHash = voucher.hash;
        hashes.add(voucher.hash);
        referenced.add(voucher.prevHash);
      }
      shards.set(period, { count, lastHash });
      totalCount += count;
    }
    // 链尾 = 没被任何凭证当作 prevHash 引用的那张。与期间先后无关，补录后仍找得对。
    const candidates = [...hashes].filter((hash) => !referenced.has(hash));
    if (candidates.length === 1) {
      tailHash = candidates[0] ?? GENESIS_PREV_HASH;
      return;
    }
    if (candidates.length > 1) {
      const message = `有 ${candidates.length} 张凭证没人接在其后，链已分叉；append 暂接在最后扫描到的一张之后`;
      addWarning('CHAIN_TAIL_AMBIGUOUS', '', 0, message);
    }
    tailHash = lastScannedHash;
  }

  const handle: JournalHandle = {
    rootDir,
    append,
    verify,
    async *read(period: string) {
      for await (const located of readLocated(period)) yield located.voucher;
    },
    async *readAll() {
      for await (const located of readAllLocated()) yield located.voucher;
    },
    index: () =>
      [...shards.entries()]
        .map(([period, entry]) => ({ period, count: entry.count, lastHash: entry.lastHash }))
        .sort((left, right) => left.period.localeCompare(right.period)),
    warnings: () => [...warningLog],
  };

  await scan();
  return handle;
}
