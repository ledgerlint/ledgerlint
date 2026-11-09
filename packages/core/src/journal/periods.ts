/**
 * 期间状态：结账与反结账（T38）。
 *
 * **为什么不是一个 `book.json` 里的 `closedPeriods: ['2026-11']`。**
 * 那样"反结账"就是数组里删一个字符串，没有任何痕迹。会计上反结账是**有后果的动作**
 * （报表会变、对外发过的数字作废），必须留下"谁在什么时候因为什么原因解开的"。
 * 所以这里用事件流：只追加、不改写，当前状态 = 重放事件。
 * 同一期间可以 CLOSE → REOPEN → CLOSE，全过程留在文件里。
 *
 * **为什么和凭证分开存。** 结账不是一笔业务，没有借贷、没有金额，硬塞进
 * `journal/*.jsonl` 会让"凭证"这个概念被污染（而且 `verify()` 会去算它的哈希）。
 * 它是一条**关于账本的事件**，住在 `journal/periods.jsonl`：
 * 与分片同目录（拷走账套时不会漏），但文件名不匹配 `YYYY-MM`，所以永远不会被当成凭证分片。
 *
 * 这个文件刻意不依赖 `io.ts`（否则 io 要读期间状态、periods 又要用 io，成环），
 * 路径在这里重写一遍。两处路径必须一致，改目录时一起改。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PeriodAction = 'CLOSE' | 'REOPEN';

export interface PeriodEvent {
  /** `YYYY-MM` */
  readonly period: string;
  readonly action: PeriodAction;
  /** ISO 时间戳。反结账的"什么时候"本身就是审计信息。 */
  readonly at: string;
  /** 反结账必填：为什么解开。结账时可空。 */
  readonly reason?: string;
  /** 结账时指向那张结转凭证，反结账时要把它红冲掉。 */
  readonly closingVoucherId?: string;
}

export interface PeriodState {
  readonly period: string;
  readonly closed: boolean;
  readonly closedAt: string | null;
  readonly reopenedAt: string | null;
  /** 最近一次反结账的原因。 */
  readonly reason: string | null;
  /** 最近一次结账对应的结转凭证。反结账要冲的就是它。 */
  readonly closingVoucherId: string | null;
}

const PERIODS_FILE = 'periods.jsonl';

function periodsPath(rootDir: string): string {
  return join(rootDir, 'journal', PERIODS_FILE);
}

/** 读全部事件。文件不存在 = 从没结过账，返回空数组而不是抛错。 */
export async function readPeriodEvents(rootDir: string): Promise<PeriodEvent[]> {
  let text: string;
  try {
    text = await readFile(periodsPath(rootDir), 'utf8');
  } catch {
    return [];
  }
  const events: PeriodEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as PeriodEvent;
      // 坏行跳过：期间状态是派生信息，坏一行不该让整个账套打不开；
      // 代价是可能误判"没结账"，由界面上显示的状态不一致来暴露。
      if (typeof parsed.period === 'string' && (parsed.action === 'CLOSE' || parsed.action === 'REOPEN')) {
        events.push(parsed);
      }
    } catch {
      // 同上
    }
  }
  return events;
}

async function appendEvent(rootDir: string, event: PeriodEvent): Promise<void> {
  const dir = join(rootDir, 'journal');
  await mkdir(dir, { recursive: true });
  await appendFile(periodsPath(rootDir), `${JSON.stringify(event)}\n`, 'utf8');
}

/** 重放事件，得到一个期间的当前状态。 */
export function stateFrom(events: readonly PeriodEvent[], period: string): PeriodState {
  let closed = false;
  let closedAt: string | null = null;
  let reopenedAt: string | null = null;
  let reason: string | null = null;
  let closingVoucherId: string | null = null;

  for (const event of events) {
    if (event.period !== period) continue;
    if (event.action === 'CLOSE') {
      closed = true;
      closedAt = event.at;
      closingVoucherId = event.closingVoucherId ?? null;
    } else {
      closed = false;
      reopenedAt = event.at;
      reason = event.reason ?? null;
    }
  }
  return { period, closed, closedAt, reopenedAt, reason, closingVoucherId };
}

export async function periodState(rootDir: string, period: string): Promise<PeriodState> {
  return stateFrom(await readPeriodEvents(rootDir), period);
}

/** 所有当前处于关闭状态的期间（按字典序，等长期间即时间序）。 */
export async function closedPeriods(rootDir: string): Promise<string[]> {
  const events = await readPeriodEvents(rootDir);
  const periods = [...new Set(events.map((event) => event.period))];
  return periods.filter((period) => stateFrom(events, period).closed).sort();
}

/**
 * 是否已结账。`io.append` 每次写之前调它——**闸门放在存储层，不放在调用方**，
 * 否则任何新入口（未来的 CLI、导入、修复脚本）都能绕过去。
 */
export async function isPeriodClosed(rootDir: string, period: string): Promise<boolean> {
  return (await periodState(rootDir, period)).closed;
}

export async function markClosed(
  rootDir: string,
  period: string,
  closingVoucherId: string,
  at = new Date().toISOString(),
): Promise<PeriodEvent> {
  const event: PeriodEvent = { period, action: 'CLOSE', at, closingVoucherId };
  await appendEvent(rootDir, event);
  return event;
}

export async function markReopened(
  rootDir: string,
  period: string,
  reason: string,
  at = new Date().toISOString(),
): Promise<PeriodEvent> {
  if (reason.trim() === '') throw new Error('反结账必须写明原因——报表会变，将来要能回答"为什么解开的"。');
  const event: PeriodEvent = { period, action: 'REOPEN', at, reason: reason.trim() };
  await appendEvent(rootDir, event);
  return event;
}
