/**
 * 小规模纳税人的事件规则（T21 第一版）。
 *
 * 只覆盖小微流水里最高频的几类：股东出资 / 股东往来 / 客户回款 / 预收 / 付供应商 / 付费用。
 * **其余一律落 `E99` 等人判断**，不猜。
 *
 * 一条贯穿全文件的原则：**命中必须有正面证据**（关键词或对方是股东），
 * 不允许"因为方向是收入所以肯定算客户款"这种推断。政府补助、退税、押金退回
 * 都是进账，但都不是收入——BP2 的 G31 就是把这三类全出成了收入。
 *
 * 资金账户一律用 `txn.account`（这笔流水所在账户），不写死 1002：
 * 微信/支付宝的钱在 1012，现金在 1001，写死会让月末对账差一大截。
 */
import { entryLine } from '../lines';
import { splitInclusive } from '../money';
import type { Cents, EventKey, JournalLine, Transaction } from '../types';
import type { DraftBody, Rule, RuleContext } from './types';

const yuan = (cents: Cents): string => (cents / 100).toFixed(2);

const textOf = (txn: Transaction): string => `${txn.summary} ${txn.counterparty}`;

function heard(txn: Transaction, pattern: RegExp): boolean {
  return pattern.test(textOf(txn));
}

function isShareholder(txn: Transaction, ctx: RuleContext): boolean {
  const name = txn.counterparty.trim();
  if (name === '') return false;
  return ctx.shareholders.some((holder) => holder !== '' && (name.includes(holder) || holder.includes(name)));
}

/**
 * 「这笔钱是跟谁有关的」。
 *
 * 对方户名为空时退回银行原始摘要，而不是留空：小微流水里「对方」经常缺失
 * （现金存入、平台代收），但摘要一般都写着「11月房租」「张三还款」。
 * 若两者都没有，才写「对方」——**摘要不能出现「房租物业：」这种半句话**。
 */
function who(txn: Transaction): string {
  const name = txn.counterparty.trim();
  if (name !== '') return name;
  const memo = txn.summary.trim();
  return memo !== '' ? memo : '对方';
}

/** 费用关键词 → 科目。顺序有意义：先专后泛。 */
const EXPENSE_KEYWORDS: readonly { readonly pattern: RegExp; readonly code: string; readonly label: string }[] = [
  { pattern: /工资|薪|社保|公积金/, code: '560201', label: '工资社保' },
  { pattern: /房租|租金|物业|水电|电费|水费/, code: '560202', label: '房租物业' },
  { pattern: /办公|耗材|打印|云服务|服务器|域名|软件|订阅/, code: '560205', label: '办公与云服务' },
  { pattern: /差旅|机票|火车|酒店|住宿|打车|交通费/, code: '560206', label: '差旅' },
  { pattern: /招待|餐饮|团建|聚餐/, code: '560207', label: '业务招待' },
  { pattern: /审计|法律|律师|代账|咨询|中介|财税/, code: '560208', label: '中介服务' },
  { pattern: /推广|广告|投放|营销|竞价/, code: '560101', label: '市场推广' },
  { pattern: /平台服务费|佣金|抽成/, code: '560102', label: '平台佣金' },
  { pattern: /手续费|账户管理费|转账费/, code: '560302', label: '银行手续费' },
  { pattern: /利息/, code: '560301', label: '利息支出' },
];

const RULES: readonly Rule[] = [
  {
    id: 'equity.paid-in',
    version: '1',
    event: 'E11',
    match: (txn) => txn.direction === 'IN' && heard(txn, /投资款|实缴|注册资本|资本金|入股|增资/),
    build: (txn) => ({
      lines: [
        entryLine(txn.account, 'DEBIT', txn.amountCents),
        entryLine('3001', 'CREDIT', txn.amountCents),
      ],
      oneLiner: `收到股东 ${who(txn)} 的实缴出资 ${yuan(txn.amountCents)} 元`,
      summary: `${who(txn)} 实缴注册资本`,
      assumed: ['按实收资本处理；若实际是股东借款，应改为其他应付款'],
      confidence: 'HIGH',
    }),
  },
  {
    id: 'equity.shareholder-loan',
    version: '1',
    event: 'E13',
    match: (txn, ctx) => isShareholder(txn, ctx) || heard(txn, /借款|还款|备用金|垫付|往来款|股东/),
    build: (txn) => {
      const inbound = txn.direction === 'IN';
      return {
        lines: inbound
          ? [
              entryLine(txn.account, 'DEBIT', txn.amountCents),
              entryLine('2241', 'CREDIT', txn.amountCents),
            ]
          : [
              entryLine('1221', 'DEBIT', txn.amountCents),
              entryLine(txn.account, 'CREDIT', txn.amountCents),
            ],
        oneLiner: inbound
          ? `收到 ${who(txn)} 的往来款 ${yuan(txn.amountCents)} 元，公司欠他`
          : `付给 ${who(txn)} ${yuan(txn.amountCents)} 元，他欠公司`,
        summary: inbound ? `${who(txn)} 往来款转入` : `付 ${who(txn)} 往来款`,
        assumed: ['按股东往来处理；若属于出资，应改为实收资本'],
        confidence: 'LOW',
      };
    },
  },
  {
    id: 'income.prepaid',
    version: '1',
    event: 'E12',
    match: (txn) => txn.direction === 'IN' && heard(txn, /预收|预付款|定金/),
    build: (txn) => ({
      lines: [
        entryLine(txn.account, 'DEBIT', txn.amountCents),
        entryLine('2203', 'CREDIT', txn.amountCents),
      ],
      oneLiner: `收到 ${who(txn)} 的预付款 ${yuan(txn.amountCents)} 元，服务还没做完`,
      summary: `预收 ${who(txn)} 款项`,
      assumed: ['按预收处理：交付后才确认收入；若已交付请改为确认收入'],
      confidence: 'LOW',
    }),
  },
  {
    id: 'income.sale',
    version: '1',
    event: 'E1',
    match: (txn) =>
      txn.direction === 'IN' &&
      heard(txn, /货款|项目款|服务费|合同款|尾款|回款|开发费|设计费|咨询费|技术服务|结算款/),
    build: (txn, ctx) => {
      const gross = txn.amountCents;
      const { netCents, taxCents } = splitInclusive(gross, ctx.vatRate);
      const lines: JournalLine[] = [
        entryLine(txn.account, 'DEBIT', gross),
        entryLine('5001', 'CREDIT', netCents),
      ];
      if (taxCents > 0) lines.push(entryLine('222101', 'CREDIT', taxCents));
      return {
        lines,
        oneLiner: `收 ${who(txn)} 的货款 ${yuan(gross)} 元（含税，已拆出增值税 ${yuan(taxCents)} 元）`,
        summary: `收 ${who(txn)} 货款`,
        assumed: [
          `按含税价拆分：征收率 ${(ctx.vatRate * 100).toFixed(0)}%`,
          '未判断本月是否适用小规模免征额；若适用需冲回计提的增值税',
        ],
        confidence: 'HIGH',
      };
    },
  },
  {
    id: 'expense.supplier',
    version: '1',
    event: 'E5',
    match: (txn) =>
      txn.direction === 'OUT' && heard(txn, /采购|货款|外包|加工|运费|物流|供应商|材料/),
    build: (txn) => ({
      lines: [
        entryLine('5401', 'DEBIT', txn.amountCents),
        entryLine(txn.account, 'CREDIT', txn.amountCents),
      ],
      oneLiner: `付 ${who(txn)} ${yuan(txn.amountCents)} 元采购款`,
      summary: `付 ${who(txn)} 采购款`,
      assumed: ['按主营业务成本归集；若属于管理用途，应改为费用科目'],
      confidence: 'LOW',
    }),
  },
  {
    id: 'expense.operating',
    version: '1',
    event: 'E8',
    match: (txn) => txn.direction === 'OUT' && EXPENSE_KEYWORDS.some((item) => heard(txn, item.pattern)),
    build: (txn) => {
      const matched = EXPENSE_KEYWORDS.find((item) => heard(txn, item.pattern));
      // match 已经保证了至少命中一条，这里的兜底只为满足类型；
      // 真走到兜底也说明规则表被改坏了，用一个明显不对的科目比静默好查。
      const code = matched?.code ?? '560209';
      return {
        lines: [
          entryLine(code, 'DEBIT', txn.amountCents),
          entryLine(txn.account, 'CREDIT', txn.amountCents),
        ],
        oneLiner: `付 ${who(txn)} ${yuan(txn.amountCents)} 元，属于${matched?.label ?? '其他费用'}`,
        summary: `${matched?.label ?? '费用'}：${who(txn)}`,
        assumed: [
          matched?.code === '560201' ? '工资按实付入账，未做计提' : '按摘要关键词归入该费用明细',
        ],
        confidence: 'LOW',
      };
    },
  },
];

/** 规则顺序即优先级：股东相关必须早于客户收款，否则"股东打款备注写项目款"会被记成收入。 */
export const CN_SMALL_RULES: readonly Rule[] = RULES;

export type { DraftBody, Rule, RuleContext };
export type { EventKey };
