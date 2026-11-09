import { createHash } from 'node:crypto';
import type { ColumnBinding, Confidence, Slot } from './types';
import { ImportError } from './types';
import { findPreset, normalizeHeader, type Preset } from './presets';

/**
 * 表头探测 —— 不假设「表头在第一行」
 *
 * 真实文件里表头出现在第 1 / 7 / 17 / 20 行都见过：前面是卡号、子账户、账单汇总、
 * 免责声明。所以做法是「给前 30 行每行打分，取最高分」，而不是按固定行号切。
 */

/** 槽位关键词。顺序有意义：先认「收/支」这种标志列，最后才认泛化的「金额」 */
const KEYWORDS: Array<[Slot, string[]]> = [
  ['date', ['交易日期', '记账日期', '交易时间', '记账时间', '入账日期', '交易日', '日期']],
  // 流水号要抢在「摘要/备注」之前认：有些表把流水号写在「备注」列里，
  // 但那是值不是列名，这里只认列名。放前面是为了避免「交易流水号」被其它关键词抢先。
  ['serial', ['交易流水号', '银行流水号', '流水号', '凭证号', '交易序号', '交易订单号', '商户单号', '业务编号']],
  ['flag', ['收/支', '收支标志', '借贷标志', '收支']],
  ['income', ['收入', '贷方发生额', '贷方金额', '转入', '存入']],
  ['expense', ['支出', '借方发生额', '借方金额', '转出', '支取']],
  ['balance', ['联机余额', '账户余额', '当前余额', '余额']],
  // 对方账号要抢在对方户名之前认：`slotOf` 是「按关键词顺序命中第一个就返回」，
  // 而「对方账号」里的「对方」两个字同时出现在 counterparty 的泛化词里。
  // 顺序颠倒过来的话，账号列会被判成户名列 —— 这是 D75 之前一直存在的情况。
  ['account', ['对方账号', '对方账户', '对方帐号', '对方卡号', '对方银行卡号', '收付款人账号']],
  ['counterparty', ['对方户名', '对方名称', '对方单位', '对手信息', '交易对方', '收付款人', '对方']],
  ['status', ['交易状态', '当前状态', '状态']],
  ['summary', ['交易摘要', '商品说明', '摘要', '商品', '用途', '备注', '客户摘要']],
  ['amount', ['交易金额', '发生额', '金额(元)', '金额']],
];

function slotOf(header: string): Slot | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  for (const [slot, words] of KEYWORDS) {
    if (words.some((w) => h.includes(w))) {
      // 「对方账号及户名」这类合并列里账号和户名挤在一格；「对方账户名称」更是名字却带「账户」二字。
      // 这两种都按户名处理：名字能进别名表参与匹配，账号那一半人补一次就够；反过来则两个都用不上。
      if (slot === 'account' && /户名|名称|单位/.test(h)) return 'counterparty';
      return slot;
    }
  }
  return null;
}

export interface HeaderDetection {
  headerIndex: number;
  columns: ColumnBinding[];
  preset: Preset | null;
  confidence: Confidence;
  /** 表头指纹：归一化后整行做 SHA-256 取前 12 位 */
  fingerprint: string;
}

/** 表头指纹：比文件名稳定（文件名带日期），比银行名精确（同银行不同产品列名不同） */
export function headerFingerprint(headers: readonly string[]): string {
  const canon = headers.map(normalizeHeader).filter((s) => s.length > 0).join('|');
  return createHash('sha256').update(canon).digest('hex').slice(0, 12);
}

function rowScore(row: readonly string[]): number {
  let n = 0;
  for (const cell of row) if (slotOf(cell)) n += 1;
  return n;
}

/**
 * 启发式映射：没有预设时，靠关键词把列对到槽位。
 * 同一个槽位只认第一列 —— 两列都叫「金额」时，第二列大概率是别的币种或备用列，
 * 猜它不如留空让人看见。
 */
export function heuristicSlots(headers: readonly string[]): ColumnBinding[] {
  const taken = new Set<Slot>();
  const out: ColumnBinding[] = [];
  headers.forEach((header, index) => {
    const slot = slotOf(header);
    if (!slot || taken.has(slot)) {
      out.push({ index, header, slot: null });
      return;
    }
    taken.add(slot);
    out.push({ index, header, slot });
  });
  return out;
}

/** 预设映射：按列名查表，查不到的列留空 */
function presetSlots(headers: readonly string[], preset: Preset): ColumnBinding[] {
  const taken = new Set<Slot>();
  const out: ColumnBinding[] = [];
  headers.forEach((header, index) => {
    const slot = preset.columns[normalizeHeader(header)] ?? null;
    if (!slot || taken.has(slot)) {
      out.push({ index, header, slot: null });
      return;
    }
    taken.add(slot);
    out.push({ index, header, slot });
  });
  return out;
}

export function hasAmountSlots(cols: readonly ColumnBinding[]): boolean {
  const slots = new Set(cols.map((c) => c.slot));
  return slots.has('amount') || (slots.has('income') && slots.has('expense'));
}

export function detectHeader(rows: readonly string[][], scanLimit = 30): HeaderDetection {
  let bestIndex = -1;
  let bestScore = 0;
  const limit = Math.min(rows.length, scanLimit);
  for (let i = 0; i < limit; i += 1) {
    const score = rowScore(rows[i] ?? []);
    // 严格大于才替换：并列时取更靠上的那行，符合人的直觉
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0 || bestScore < 3) {
    throw new ImportError(
      'HEADER_NOT_FOUND',
      '在前 30 行里找不到表头（至少要有「日期」「金额」这类列名）。' +
        '请确认导出的是「交易明细」而不是汇总表，或直接把文件前几行的说明删掉再导。',
    );
  }

  const headers = (rows[bestIndex] ?? []).map((h) => h.trim());
  const preset = findPreset(headers);
  const columns = preset ? presetSlots(headers, preset) : heuristicSlots(headers);

  if (!hasAmountSlots(columns) || !columns.some((c) => c.slot === 'date')) {
    throw new ImportError(
      'SLOTS_INCOMPLETE',
      `识别到表头（第 ${bestIndex + 1} 行），但找不到${columns.some((c) => c.slot === 'date') ? '金额列' : '日期列'}。` +
        '这个格式不在预设里，请在导入页手动指定哪一列是日期、哪一列是金额。',
    );
  }

  return {
    headerIndex: bestIndex,
    columns,
    preset,
    confidence: preset?.confidence ?? 'HEURISTIC',
    fingerprint: headerFingerprint(headers),
  };
}
