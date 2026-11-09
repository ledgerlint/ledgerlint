import type { Confidence, Slot } from './types';

/**
 * 指纹库 —— 预设的列映射
 *
 * 每条预设只声明两件事：**用哪几列认出它**（signature）、**每列是什么**（columns）。
 * 认出它靠的是列名而不是文件名：文件名带日期、带账号，同一个人下次导出就变了；
 * 列名反而稳定，且同银行不同产品的列名本来就不同（工行借记卡与信用卡不一样）。
 *
 * confidence 是这一条的核心（D42）：
 *   VERIFIED —— 对着真实样例文件逐字核对过列名
 *   INFERRED —— 来自文档或二手资料，没见过真实文件
 * 非 VERIFIED 的预设**不允许静默导入**，必须让人过一眼列映射。
 * 标错比没有更糟：用户会以为可以直接导。
 */
export interface Preset {
  id: string;
  bank: string;
  confidence: Confidence;
  /** 认它出来所需的列（全部要出现） */
  signature: string[];
  /** 列名（归一化后）→ 槽位。没列出的列保留但不参与解析 */
  columns: Record<string, Slot>;
  note?: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'icbc-debit-v1',
    bank: '工商银行（借记卡）',
    confidence: 'VERIFIED',
    signature: ['交易日期', '记账金额(收入)', '记账金额(支出)', '余额'],
    columns: {
      交易日期: 'date',
      // 关键：工行同时有「交易金额」与「记账金额」两套列。
      // 交易金额是原币（外币消费时是外币数字），记账金额才是入账人民币。
      // 取错列，外币消费会按外币数字入账 —— 这里只映射记账金额，交易金额留空不用。
      '记账金额(收入)': 'income',
      '记账金额(支出)': 'expense',
      余额: 'balance',
      对方户名: 'counterparty',
      摘要: 'summary',
      凭证号: 'serial',
    },
    note: '表头在第 7 行（前面是卡号与子账户信息），编码多为 UTF-8 BOM 或 GBK。',
  },
  {
    id: 'cmb-debit',
    bank: '招商银行（借记卡）',
    confidence: 'VERIFIED',
    signature: ['记账日期', '交易金额', '联机余额', '交易摘要'],
    columns: {
      记账日期: 'date',
      交易金额: 'amount',
      联机余额: 'balance',
      交易摘要: 'summary',
      对手信息: 'counterparty',
      流水号: 'serial',
    },
    note: '金额是**单列带符号**（-1,000.00 表示支出），且有千分位逗号。',
  },
  {
    id: 'alipay',
    bank: '支付宝（交易明细）',
    confidence: 'VERIFIED',
    signature: ['交易时间', '交易对方', '收/支', '交易订单号'],
    columns: {
      交易时间: 'date',
      '收/支': 'flag',
      金额: 'amount',
      交易对方: 'counterparty',
      商品说明: 'summary',
      交易状态: 'status',
      交易订单号: 'serial',
    },
    note: 'GBK 编码，表头约在第 20 行（前面 18–19 行是说明块）。交易关闭/退款成功的行要剔除。',
  },
  {
    id: 'wechat',
    bank: '微信支付（账单明细）',
    confidence: 'VERIFIED',
    signature: ['交易时间', '交易对方', '收/支', '商户单号'],
    columns: {
      交易时间: 'date',
      '收/支': 'flag',
      '金额(元)': 'amount',
      交易对方: 'counterparty',
      商品: 'summary',
      当前状态: 'status',
      商户单号: 'serial',
    },
    note: 'UTF-8 BOM，表头在第 17 行，金额带 ¥ 前缀。`收/支` 为 `/` 的是中性交易（充值/提现/零钱通）。',
  },
  {
    id: 'ccb-debit',
    bank: '建设银行（交易明细）',
    confidence: 'INFERRED',
    signature: ['记账日', '收入', '支出'],
    columns: {
      '记账日': 'date',
      收入: 'income',
      支出: 'expense',
      // D75：这一列是**账号**不是户名。以前映射到 counterparty，等于把唯一的身份锚点
      // 当成名字用：别名对不上、护栏也判不了主体。户名列单列声明，文件里没有就自然用不上。
      对方账号: 'account',
      对方户名: 'counterparty',
      交易流水号: 'serial',
    },
    note: '样例文件是 .xls（BIFF8），列名只部分可读，**未经真实文件逐字核对**。导入时必须人工确认列映射。',
  },
];

/** 归一化列名：去空白、去尾部冒号、全角括号转半角 */
export function normalizeHeader(s: string): string {
  return s
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[：:]$/, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[￥¥]/g, '')
    .trim();
}

export function findPreset(headers: readonly string[]): Preset | null {
  const set = new Set(headers.map(normalizeHeader));
  let best: { p: Preset; hit: number } | null = null;
  for (const p of PRESETS) {
    const hit = p.signature.filter((s) => set.has(normalizeHeader(s))).length;
    if (hit === p.signature.length && (!best || hit > best.hit)) best = { p, hit };
  }
  return best?.p ?? null;
}
