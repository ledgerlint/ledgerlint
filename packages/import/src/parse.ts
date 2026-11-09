import { createHash } from 'node:crypto';
import type { BalanceBreak, BalanceCheck, BankTxn, ParseIssue, ParseReport, Slot } from './types';
import { ImportError } from './types';
import { decodeBytes } from './decode';
import { parseDelimited } from './csv';
import { detectHeader } from './detect';

/**
 * 格式嗅探（v0.1 只支持 CSV/TSV）。
 *
 * Excel 两种格式在这里**明确拒绝并给出下一步**，而不是"尽量解析"：
 * 读错一个单元格比读不了更糟——用户会拿到一本来路不明的账，而且不会怀疑它。
 * 解析 xlsx 需要引入第三方库，属于供应链负担，留给 v0.2 按 issue 决定。
 */
function sniffFormat(bytes: Uint8Array): 'csv' | 'xls' | 'xlsx' | 'html' {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls';
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b) return 'xlsx';
  const head = new TextDecoder('latin1').decode(b.subarray(0, 256)).trimStart();
  if (head.startsWith('<')) return 'html';
  return 'csv';
}

/** 余额比对容差：1 分。银行是精确的，但「元→分」四舍五入偶尔会差一分 */
const CENT_TOLERANCE = 1;

/** 这些状态的钱不能进账：关闭的交易没发生，退款的钱是流回，算进来会两头虚增 */
const BAD_STATUS = /交易关闭|已关闭|已退款|退款成功|支付失败|交易失败/;

/** 合计行不是流水：工行导出末尾就有「人民币合计」一行，把它当解析失败会吓人一跳 */
const TOTAL_ROW = /^(人民币)?(合计|小计|总计|本页合计|累计)/;

export function parseMoney(raw: string): number | null {
  const s = raw
    .replace(/[\s\u00a0\u3000]/g, '')
    .replace(/[¥￥元,]/g, '')
    .replace(/^\+/, '');
  if (!s || s === '-' || s === '--' || s === '/' || s === '—' || s === '－') return null;
  const paren = /^\((.*)\)$/.exec(s);
  const body = paren ? paren[1]! : s;
  if (!/^-?\d+(\.\d+)?$/.test(body)) return null;
  const v = Number(body);
  if (!Number.isFinite(v)) return null;
  return Math.round((paren ? -v : v) * 100);
}

export function parseDateCell(raw: string): string | null {
  const s = raw
    .replace(/[\s\u00a0\u3000]/g, '')
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/[./]/g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) {
    const mm = m[2]!.padStart(2, '0');
    const dd = m[3]!.padStart(2, '0');
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) return `${m[1]}-${mm}-${dd}`;
  }
  const c = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (c) return `${c[1]}-${c[2]}-${c[3]}`;
  return null;
}

function rowFingerprint(t: Omit<BankTxn, 'fingerprint'>): string {
  const canon = [t.date, t.direction, t.amountCents, t.counterparty.trim(), t.summary.trim()].join('|');
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

/**
 * 余额连续性校验（D41 的落地）
 *
 * 银行导出的顺序不固定：工行/招行多是最新在上（倒序），支付宝/微信是正序。
 * 所以两个方向都试一遍，取断裂更少的那个方向作为「本文件的方向」，
 * 再报告该方向上的第一个断点。
 *
 * 为什么值得强制：用户最常见的错不是金额填错，而是「只导了半段」——
 * 网银一次最多查 3 个月、误点了分页、复制时丢行。这类错在账面上完全无痕：
 * 借贷仍平、断言全绿、报表照出。余额链是唯一能抓住它的机制。
 */
export function checkBalanceChain(txns: readonly BankTxn[]): {
  available: boolean;
  order: 'ASC' | 'DESC' | 'UNKNOWN';
  breaks: BalanceBreak[];
} {
  const withBal = txns.filter((t) => t.balanceCents != null);
  // 有任何一行缺余额（比如被掩码成 xx,yyyy.zz），就无法串成链
  if (txns.length < 2 || withBal.length !== txns.length) {
    return { available: false, order: 'UNKNOWN', breaks: [] };
  }

  const signed = (t: BankTxn) => (t.direction === 'IN' ? t.amountCents : -t.amountCents);

  const asc: BalanceBreak[] = [];
  for (let i = 1; i < txns.length; i += 1) {
    const expected = txns[i - 1]!.balanceCents! + signed(txns[i]!);
    const actual = txns[i]!.balanceCents!;
    if (Math.abs(expected - actual) > CENT_TOLERANCE) {
      asc.push({ rowNo: txns[i]!.rowNo, prevRowNo: txns[i - 1]!.rowNo, expectedCents: expected, actualCents: actual });
    }
  }

  const desc: BalanceBreak[] = [];
  for (let i = txns.length - 2; i >= 0; i -= 1) {
    const expected = txns[i + 1]!.balanceCents! + signed(txns[i]!);
    const actual = txns[i]!.balanceCents!;
    if (Math.abs(expected - actual) > CENT_TOLERANCE) {
      desc.push({ rowNo: txns[i]!.rowNo, prevRowNo: txns[i + 1]!.rowNo, expectedCents: expected, actualCents: actual });
    }
  }

  if (asc.length <= desc.length) return { available: true, order: 'ASC', breaks: asc.slice(0, 5) };
  return { available: true, order: 'DESC', breaks: desc.slice(0, 5) };
}

interface Declared {
  count: number;
  cents: number;
}

/** 从账单头部说明块里读「收入：N 笔 X 元 / 支出：M 笔 Y 元」（支付宝、微信都有） */
export function readDeclaredTotals(text: string): { in: Declared | null; out: Declared | null } {
  const pick = (label: string): Declared | null => {
    const m = new RegExp(`${label}\\s*[：:]?\\s*(\\d+)\\s*笔\\s*([\\d,]+\\.?\\d*)\\s*元`).exec(text);
    if (!m) return null;
    return { count: Number(m[1]), cents: parseMoney(m[2]!) ?? 0 };
  };
  return { in: pick('收入'), out: pick('支出') };
}

export interface ParseInput {
  bytes: Uint8Array;
  filename?: string;
}

export function parseStatement(input: ParseInput): ParseReport {
  const bytes = input.bytes;
  if (bytes.length === 0) throw new ImportError('EMPTY_FILE', '文件是空的，没有任何内容。');

  const format = sniffFormat(bytes);
  if (format === 'xls') {
    throw new ImportError(
      'XLS_UNSUPPORTED',
      '这是 Excel 97-2003 格式（.xls）。请用 Excel 打开后「另存为」→ 选「CSV UTF-8」，再导入。' +
        '（建设银行企业网银默认导出的就是这种格式；我们没做二进制解析器，因为读错一个单元格比读不了更糟。）',
    );
  }
  if (format === 'xlsx') {
    throw new ImportError(
      'XLSX_UNSUPPORTED',
      '这是 .xlsx 格式。请用 Excel 打开后「另存为」→ 选「CSV UTF-8」，再导入。v0.1 只解析 CSV。',
    );
  }
  if (format === 'html') {
    throw new ImportError(
      'HTML_UNSUPPORTED',
      '这看起来是网页另存的表格（HTML）。请用 Excel 打开后另存为「CSV UTF-8」。',
    );
  }

  const decoded = decodeBytes(bytes);
  const encoding = decoded.encoding;
  const rows = parseDelimited(decoded.text);

  const header = detectHeader(rows);
  const colIndex = new Map<Slot, number>();
  for (const c of header.columns) if (c.slot && !colIndex.has(c.slot)) colIndex.set(c.slot, c.index);

  const cell = (row: readonly string[], slot: Slot): string => {
    const i = colIndex.get(slot);
    return i == null ? '' : (row[i] ?? '');
  };

  const txns: BankTxn[] = [];
  const issues: ParseIssue[] = [];
  let closed = 0;
  let neutral = 0;
  let unparsable = 0;
  let allIn = { count: 0, cents: 0 };
  let allOut = { count: 0, cents: 0 };

  for (let r = header.headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const rowNo = r + 1; // 文件里的行号，1 起
    const joined = row.join('').trim();
    if (!joined) continue;

    const date = parseDateCell(cell(row, 'date'));
    if (!date) {
      // 分页导出会重复表头；这类行不算「解析失败」，只跳过
      if (row.some((c) => c.includes('交易日期') || c.includes('记账日期') || c.includes('交易时间'))) continue;
      // 合计 / 小计 / 本页合计：银行在表尾自己汇总，不是流水
      if (TOTAL_ROW.test(row.join('').replace(/\s/g, ''))) continue;
      unparsable += 1;
      issues.push({ rowNo, code: 'DATE_UNPARSABLE', detail: `第 ${rowNo} 行读不出日期：「${cell(row, 'date').slice(0, 20)}」` });
      continue;
    }

    const inc = parseMoney(cell(row, 'income'));
    const exp = parseMoney(cell(row, 'expense'));
    let direction: 'IN' | 'OUT' | null = null;
    let amountCents = 0;

    if (inc != null || exp != null) {
      if (inc != null && inc !== 0) {
        direction = 'IN';
        amountCents = Math.abs(inc);
      } else if (exp != null && exp !== 0) {
        direction = 'OUT';
        amountCents = Math.abs(exp);
      }
    } else {
      const amt = parseMoney(cell(row, 'amount'));
      if (amt != null && amt !== 0) {
        const flag = cell(row, 'flag').replace(/\s/g, '');
        if (flag) {
          const isOut = /支|出账|借/.test(flag);
          const isIn = /收|入账|贷/.test(flag) && !isOut;
          if (isIn) {
            direction = 'IN';
            amountCents = Math.abs(amt);
          } else if (isOut) {
            direction = 'OUT';
            amountCents = Math.abs(amt);
          } else {
            // 「收/支 = /」是微信的中性交易：充值、提现、零钱通存取。既不是收入也不是支出。
            neutral += 1;
            continue;
          }
        } else {
          direction = amt > 0 ? 'IN' : 'OUT';
          amountCents = Math.abs(amt);
        }
      }
    }

    if (!direction || amountCents === 0) {
      unparsable += 1;
      issues.push({ rowNo, code: 'AMOUNT_UNPARSABLE', detail: `第 ${rowNo} 行读不出金额，已跳过（不会静默丢弃，请在银行 App 里核对这一行）` });
      continue;
    }

    const status = cell(row, 'status');
    const counterparty = cell(row, 'counterparty').replace(/[\s\u00a0]+$/g, '').trim();
    // 账号原样保留，同流水号：银行账号常带前导零，按数字读一次就把 '0123…' 变成 '123…'，
    // 之后再拿它去比对对方账号永远对不上。
    const counterpartyAccount = cell(row, 'account').replace(/[\s\u00a0]+$/g, '').trim() || undefined;
    const summary = cell(row, 'summary').replace(/[\s\u00a0]+$/g, '').trim();

    // 汇总对账要用「扫描到的全部行」，包括被状态过滤掉的那些：
    // 账单头部的「收入 N 笔」是按全部记录数的，不是按可入账的。
    if (direction === 'IN') {
      allIn = { count: allIn.count + 1, cents: allIn.cents + amountCents };
    } else {
      allOut = { count: allOut.count + 1, cents: allOut.cents + amountCents };
    }

    if (status && BAD_STATUS.test(status)) {
      closed += 1;
      continue;
    }

    const base = {
      rowNo,
      date,
      direction,
      amountCents,
      balanceCents: parseMoney(cell(row, 'balance')),
      counterparty,
      summary: summary || counterparty || '银行流水',
      // 可选字段用条件展开而不是赋 undefined：`exactOptionalPropertyTypes` 下
      // 「没有这一列」与「这一列是空的」是两件事，而只有前者能表达「文件里确实没有」。
      ...(counterpartyAccount === undefined ? {} : { counterpartyAccount }),
      // 流水号原样保留，不做数字规范化：有些银行的号带前导零或字母后缀，
      // 一旦被当成数字读，'0001234' 会变成 '1234'，跟回单永远对不上
      ...((cell(row, 'serial') || '').trim() === '' ? {} : { serialNo: (cell(row, 'serial') || '').trim() }),
    };
    txns.push({ ...base, fingerprint: rowFingerprint(base) });
  }

  if (txns.length === 0) {
    throw new ImportError(
      'NO_TXN',
      `表头认出来了（第 ${header.headerIndex + 1} 行），但下面一行可用流水都没读到。` +
        `日期读不出 ${unparsable} 行，中性交易 ${neutral} 行，已关闭/退款 ${closed} 行。请核对文件是不是只有表头。`,
    );
  }

  // ===== 完整性校验：余额链优先，账单汇总兜底，两者皆无则拒绝 =====
  const chain = checkBalanceChain(txns);
  let balance: BalanceCheck;
  if (chain.available) {
    balance = {
      available: true,
      method: 'ROW_CHAIN',
      ok: chain.breaks.length === 0,
      breaks: chain.breaks,
    };
  } else {
    const preamble = rows.slice(0, header.headerIndex).flat().join(' ');
    const declared = readDeclaredTotals(preamble);
    if (declared.in || declared.out) {
      const okIn = !declared.in || (declared.in.count === allIn.count && Math.abs(declared.in.cents - allIn.cents) <= CENT_TOLERANCE);
      const okOut = !declared.out || (declared.out.count === allOut.count && Math.abs(declared.out.cents - allOut.cents) <= CENT_TOLERANCE);
      balance = {
        available: true,
        method: 'FILE_SUMMARY',
        ok: okIn && okOut,
        breaks: [],
        summaryReconcile: {
          declaredIn: declared.in,
          declaredOut: declared.out,
          actualIn: allIn,
          actualOut: allOut,
        },
      };
    } else {
      balance = { available: false, method: 'NONE', ok: false, breaks: [] };
    }
  }

  if (unparsable > 0) {
    issues.push({
      rowNo: 0,
      code: 'ROWS_SKIPPED',
      detail: `有 ${unparsable} 行读不出日期或金额，已跳过。它们不会进确认队列，请在银行 App 里逐条核对。`,
    });
  }
  if (closed > 0) {
    issues.push({
      rowNo: 0,
      code: 'ROWS_FILTERED_STATUS',
      detail: `有 ${closed} 行状态为「已关闭/失败/退款」，已剔除：这些钱实际上没有发生（或没净发生），计入会两头虚增。`,
    });
  }
  if (neutral > 0) {
    issues.push({
      rowNo: 0,
      code: 'ROWS_NEUTRAL',
      detail: `有 ${neutral} 行是中性交易（充值/提现/零钱通存取等），既不是收入也不是支出，已剔除。`,
    });
  }

  const totalInCents = txns.filter((t) => t.direction === 'IN').reduce((s, t) => s + t.amountCents, 0);
  const totalOutCents = txns.filter((t) => t.direction === 'OUT').reduce((s, t) => s + t.amountCents, 0);

  return {
    source: {
      bank: header.preset?.bank ?? '未识别格式（按列名猜的映射）',
      confidence: header.confidence,
      fingerprint: header.fingerprint,
    },
    encoding,
    headerRowNo: header.headerIndex + 1,
    columns: header.columns,
    order: chain.order,
    txns,
    skipped: { closed, neutral, unparsable },
    balance,
    totalInCents,
    totalOutCents,
    requiresColumnReview: header.confidence !== 'VERIFIED',
    issues,
  };
}
