/**
 * 语义槽。槽位是「这列是什么」，不是「这列叫什么」。
 *
 * `serial` 是 2026-10-28 新增的：银行流水号 / 凭证号 / 平台订单号。
 * 它是精准对账的唯一钥匙 —— 金额+日期+对手方只能推断「大概是同一笔」，
 * 流水号相等才是「确凿是同一笔」。导入端没有这一列，回单解析出来也没东西可对。
 *
 * `account` 是 2026-10-29 新增的：对方账号（D75）。
 * 之前它被并进 `counterparty` 槽位，而槽位是「一列对一槽」的，
 * 同一张表里既有「对方户名」又有「对方账号」时，后出现的那列会被静默丢弃 ——
 * 丢的恰好是比户名更硬的那个身份锚点。
 */
export type Slot =
  | 'date'
  | 'serial'
  | 'income'
  | 'expense'
  | 'amount'
  | 'flag'
  | 'balance'
  | 'counterparty'
  | 'account'
  | 'summary'
  | 'status';

export interface ColumnBinding {
  index: number;
  header: string;
  slot: Slot | null;
}

export type Confidence = 'VERIFIED' | 'INFERRED' | 'HEURISTIC';

export interface BankTxn {
  /** 在**原文件**里的行号（1 起），报断点时用它，用户能直接翻到那一行 */
  rowNo: number;
  date: string;
  direction: 'IN' | 'OUT';
  /** 正数，单位分 */
  amountCents: number;
  balanceCents: number | null;
  counterparty: string;
  /** 对方账号（D75）。导出文件没有这一列时为 undefined */
  counterpartyAccount?: string;
  summary: string;
  /** 银行/支付平台的流水号。导出文件没有这一列时为 undefined（不影响导入） */
  serialNo?: string;
  /**
   * 行指纹：日期+方向+金额+对方+摘要，用于跨文件去重。
   * **不含流水号、也不含对方账号** —— 它不是业务内容，加进来会让「同一份文件重导」
   * 变成一批新数据（同一笔钱进两次账）。
   */
  fingerprint: string;
}

export interface BalanceBreak {
  rowNo: number;
  expectedCents: number;
  actualCents: number;
  prevRowNo: number;
}

export interface BalanceCheck {
  /** 文件里到底有没有可用的余额证据 */
  available: boolean;
  /** 用哪种证据验的：逐行余额链 / 账单头部汇总 / 都没有 */
  method: 'ROW_CHAIN' | 'FILE_SUMMARY' | 'NONE';
  ok: boolean;
  breaks: BalanceBreak[];
  /** FILE_SUMMARY 模式下的对账明细 */
  summaryReconcile?: {
    declaredIn: { count: number; cents: number } | null;
    declaredOut: { count: number; cents: number } | null;
    actualIn: { count: number; cents: number };
    actualOut: { count: number; cents: number };
  };
}

export interface ParseIssue {
  rowNo: number;
  code: string;
  detail: string;
}

export interface ParseReport {
  source: {
    /** 识别出的来源，识别不出时为「未识别格式」 */
    bank: string;
    confidence: Confidence;
    fingerprint: string;
  };
  encoding: string;
  headerRowNo: number;
  columns: ColumnBinding[];
  /** 行序：银行普遍倒序（最新在上），这个信息决定余额链怎么验 */
  order: 'ASC' | 'DESC' | 'UNKNOWN';
  txns: BankTxn[];
  skipped: { closed: number; neutral: number; unparsable: number };
  balance: BalanceCheck;
  totalInCents: number;
  totalOutCents: number;
  /** 非 VERIFIED 指纹必须让人过一眼列映射（D42） */
  requiresColumnReview: boolean;
  issues: ParseIssue[];
}

export class ImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}
