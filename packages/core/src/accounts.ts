/**
 * 科目表（T06）：**只保留本 MVP 12 类事件、三表列报与 5 条断言真的会用到的末级科目**。
 *
 * 三条裁剪纪律（BP2 的死因逐条对应）：
 *
 * 1. **`auxRequired` 声明即实现，不存在第三种状态。**
 *    BP2 在 21 处声明了 `auxRequired`，但只有 1122/1123/2202/2203 这 4 个科目被
 *    `voucher.ts` 真的校验过，另外 17 处是「看起来有闸门、其实没有」。
 *    声明了不实现的闸门比不声明更坏：它让人以为这关已经过了。
 *    因此本文件里 `auxRequired` **只允许出现在 voucher.assertAuxiliary 会读的那 4 个科目上**
 *    （校验器直接遍历本表的声明，而不是另存一份清单 —— 两边不可能再漂移），
 *    其余科目的辅助核算需求一律降级为 `usageNote` 的人话说明。
 *
 * 2. **删掉的不是「暂时用不上」，而是「本 MVP 结构性不成立」。**
 *    没有工资单 → 没有 2211 应付职工薪酬、222106 代扣个税；
 *    没有固定资产卡片 → 没有 1601/1602/1701/1702；没有存货台账 → 没有 1405；
 *    没有研发归集 → 没有 4301；没有合并报表/长期股权投资/个体户适配档。
 *    留着它们的唯一效果是让人以为这些场景有人管。
 *
 * 3. **末级判定只有一处来源。** `isLeaf` 与「有没有下级」必须一致，
 *    否则「声明末级却挂不住账」和「非末级却能挂账」会同时存在；
 *    模块加载时 `assertChartSane()` 直接把不一致炸掉，不等用户点到那一格。
 *
 * 科目编码严格遵循《小企业会计准则》附录，不自造编号。
 */
/*
 * 科目表不是六型契约之一（`types.ts` 里没有 `Account`，也刻意不加）：
 * 科目表是**账套配置**，随准则与行业变；六型是进哈希的记账形状，不随配置变。
 * 两者的变更节奏完全不同，放进同一个文件会让「加一个科目」看起来像「改契约」。
 */

/** 科目大类。五类对应资产负债表的三大块 + 成本 + 损益。 */
export type AccountCategory = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'COST' | 'PNL';

/** 科目的正常余额方向。抵减科目（如累计折旧）为 `CREDIT`。 */
export type AccountDirection = 'DEBIT' | 'CREDIT';

/**
 * 对象级辅助核算的维度。**只有这两个值**，且都落到 `JournalLine.counterparty` 一个字段上。
 *
 * 为什么不放开成任意字符串：放开之后又多了一堆「声明了但没人读」的维度 ——
 * 而 BP2 正是死在 21 处声明、4 处实现上。要加维度就先加校验器与落点字段。
 */
export type AuxObjectKey = '客户' | '供应商';

/** 一个科目。 */
export interface Account {
  /** 末级科目编码，遵循《小企业会计准则》附录，不自造。 */
  readonly code: string;
  readonly name: string;
  readonly category: AccountCategory;
  readonly direction: AccountDirection;
  /** 自己声明是末级；能否真挂账还要看有没有下级（见 `isLeafAccount`）。 */
  readonly isLeaf: boolean;
  readonly parentCode?: string;
  /** 必填的对象维度。**声明即校验**，见文件头第 1 条。 */
  readonly auxRequired?: readonly AuxObjectKey[];
  /** 用途边界：什么时候对、什么时候错。不是「是什么」的复述。 */
  readonly usageNote?: string;
}

/** 构造器。只为让下面 45 行科目表一行一个科目、可 diff 可 review。 */
const A = (
  code: string,
  name: string,
  category: AccountCategory,
  direction: AccountDirection,
  opts: Partial<Account> = {},
): Account => ({
  code,
  name,
  category,
  direction,
  isLeaf: opts.isLeaf ?? true,
  // 可选字段用条件展开而不是赋 undefined：`exactOptionalPropertyTypes` 下
  // 「没有这个字段」与「这个字段是 undefined」是两件事，前者才是事实。
  ...(opts.parentCode === undefined ? {} : { parentCode: opts.parentCode }),
  ...(opts.auxRequired === undefined ? {} : { auxRequired: opts.auxRequired }),
  ...(opts.usageNote === undefined ? {} : { usageNote: opts.usageNote }),
});

/** 本 MVP 的科目表。增删一行就是一次会计判断，见文件头第 2 条。 */
export const ACCOUNTS: readonly Account[] = [
  // ==================== 资产 ====================
  A('1001', '库存现金', 'ASSET', 'DEBIT', { usageNote: '技术型公司极少使用；现金收付需有单据。' }),
  A('1002', '银行存款', 'ASSET', 'DEBIT', {
    usageNote: '开户行与账号属于账户维度，由账户选择器管；不做科目级辅助核算校验。',
  }),
  A('1012', '其他货币资金', 'ASSET', 'DEBIT', {
    usageNote: '微信/支付宝/第三方支付账户余额。不要把个人码收款长期挂这里却不确认收入。',
  }),
  A('1122', '应收账款', 'ASSET', 'DEBIT', {
    auxRequired: ['客户'],
    usageNote: '已确认收入但未收款。收款必须冲同一客户，否则往来对不上。',
  }),
  A('1123', '预付账款', 'ASSET', 'DEBIT', {
    auxRequired: ['供应商'],
    usageNote: '预付房租/服务费/货款，受益期通常在 1 年内。预付租金不许挂长期待摊：会触发「不低于 3 年摊销」，白白产生税会差异。',
  }),
  A('1221', '其他应收款', 'ASSET', 'DEBIT', {
    usageNote: '备用金、押金、股东借款。股东借款超过 12 个月未还可能被视同分红（20% 个税）。',
  }),

  // ==================== 负债 ====================
  A('2202', '应付账款', 'LIABILITY', 'CREDIT', {
    auxRequired: ['供应商'],
    usageNote: '赊购形成的欠款。付款冲同一供应商。',
  }),
  A('2203', '预收账款', 'LIABILITY', 'CREDIT', {
    auxRequired: ['客户'],
    usageNote: 'SaaS 年费、服务期未开始的收款走这里；已交付却挂预收会少计收入。',
  }),
  A('2221', '应交税费', 'LIABILITY', 'CREDIT', { isLeaf: false, usageNote: '非末级，分录只能挂下面 6 个明细。' }),
  A('222101', '应交税费—应交增值税', 'LIABILITY', 'CREDIT', {
    parentCode: '2221',
    usageNote: '小规模纳税人单科目核算销项/进项；一般纳税人的专栏不在本 MVP。',
  }),
  A('222102', '应交税费—应交企业所得税', 'LIABILITY', 'CREDIT', { parentCode: '2221' }),
  A('222103', '应交税费—应交城市维护建设税', 'LIABILITY', 'CREDIT', {
    parentCode: '2221',
    usageNote: '市区 7%、县城/镇 5%、其他 1%，按登记所在地取参数。',
  }),
  A('222104', '应交税费—应交教育费附加', 'LIABILITY', 'CREDIT', { parentCode: '2221' }),
  A('222105', '应交税费—应交地方教育附加', 'LIABILITY', 'CREDIT', { parentCode: '2221' }),
  A('222107', '应交税费—应交印花税', 'LIABILITY', 'CREDIT', {
    parentCode: '2221',
    usageNote: '资金账簿按实收资本+资本公积合计 0.025%；技术合同按 0.03%。',
  }),
  A('2241', '其他应付款', 'LIABILITY', 'CREDIT', {
    usageNote: '只装要还的钱：押金、股东垫资、代收代付。不得装收入（会漏增值税），也不得装分红（应走 3104）。',
  }),

  // ==================== 所有者权益 ====================
  A('3001', '实收资本', 'EQUITY', 'CREDIT', {
    usageNote: '只装股东真实投入且无需偿还、已实缴的注册资本。认缴未实缴不得挂账；股东垫资走 2241；股东取用走 3104。',
  }),
  A('3002', '资本公积', 'EQUITY', 'CREDIT', {
    usageNote: '投资额超出注册资本的部分（资本溢价）。先记 3001 至注册资本，超出部分才进本科目。',
  }),
  A('3101', '盈余公积', 'EQUITY', 'CREDIT', {
    usageNote: '承接期初与外部导入的余额；本 MVP 不做年末计提，因此不会有新发生额，只有列报。',
  }),
  A('3103', '本年利润', 'EQUITY', 'CREDIT', {
    usageNote: '只由损益结转写入，禁止手工挂账。B5 的滚动等式以本科目为枢纽。',
  }),
  A('3104', '利润分配', 'EQUITY', 'CREDIT', {
    usageNote: '年末由 3103 转入；期间内直接借方挂账会出现负数余额。股东取现走「借 3104／贷货币资金」。',
  }),

  // ==================== 损益 ====================
  A('5001', '主营业务收入', 'PNL', 'CREDIT', {
    usageNote: '收入只在这里确认。已收款但未交付的挂 2203，不得直接进本科目。',
  }),
  A('5401', '主营业务成本', 'PNL', 'DEBIT', { isLeaf: false, usageNote: '非末级，按成本结构挂下面 2 个明细。' }),
  A('540101', '主营业务成本—云资源与 API', 'PNL', 'DEBIT', {
    parentCode: '5401',
    usageNote: '对外交付直接消耗的服务器、模型调用、SaaS 订阅。',
  }),
  A('540102', '主营业务成本—项目实施', 'PNL', 'DEBIT', { parentCode: '5401', usageNote: '交付项目的外包与实施人工。' }),
  A('5403', '税金及附加', 'PNL', 'DEBIT', {
    usageNote: '附加税、印花税、房产税、土地使用税、车船税。这些不得记入管理费用（财会〔2016〕22 号）。',
  }),
  A('5601', '销售费用', 'PNL', 'DEBIT', { isLeaf: false, usageNote: '非末级。' }),
  A('560101', '销售费用—市场推广费', 'PNL', 'DEBIT', {
    parentCode: '5601',
    usageNote: '广告与业务宣传费税前扣除限额为营业收入 15%，超出可结转以后年度。',
  }),
  A('560102', '销售费用—平台佣金', 'PNL', 'DEBIT', { parentCode: '5601' }),
  A('560103', '销售费用—其他', 'PNL', 'DEBIT', { parentCode: '5601' }),
  A('560104', '销售费用—职工薪酬', 'PNL', 'DEBIT', {
    parentCode: '5601',
    usageNote: '销售/商务人员的工资与社保。与 560201 分开，销售费用率才不会失真。',
  }),
  A('5602', '管理费用', 'PNL', 'DEBIT', { isLeaf: false, usageNote: '非末级。' }),
  A('560201', '管理费用—职工薪酬', 'PNL', 'DEBIT', {
    parentCode: '5602',
    usageNote: '非研发人员。研发人员走 560203。本 MVP 不做工资计提，付款时直接计入本科目。',
  }),
  A('560202', '管理费用—房租物业水电', 'PNL', 'DEBIT', { parentCode: '5602' }),
  A('560203', '管理费用—研发费用', 'PNL', 'DEBIT', {
    parentCode: '5602',
    usageNote: '研发费用在利润表上的出口。资本化研发出不来本科目。',
  }),
  A('560205', '管理费用—办公与通讯', 'PNL', 'DEBIT', { parentCode: '5602' }),
  A('560206', '管理费用—差旅费', 'PNL', 'DEBIT', { parentCode: '5602' }),
  A('560207', '管理费用—业务招待费', 'PNL', 'DEBIT', {
    parentCode: '5602',
    usageNote: '税前按发生额 60% 扣除，且不超过营业收入 5‰；申报时需调增。',
  }),
  A('560208', '管理费用—中介服务费', 'PNL', 'DEBIT', { parentCode: '5602', usageNote: '审计、法律、代账、咨询。' }),
  A('560209', '管理费用—其他', 'PNL', 'DEBIT', { parentCode: '5602' }),
  A('5603', '财务费用', 'PNL', 'DEBIT', { isLeaf: false, usageNote: '非末级。' }),
  A('560301', '财务费用—利息支出', 'PNL', 'DEBIT', {
    parentCode: '5603',
    usageNote: '银行手续费不进本科目；活期利息收入以红字冲减本科目。',
  }),
  A('560302', '财务费用—手续费', 'PNL', 'DEBIT', { parentCode: '5603', usageNote: '银行账户管理费与转账手续费。' }),
  A('5711', '营业外支出', 'PNL', 'DEBIT', {
    usageNote: '罚款、滞纳金、捐赠（限额内）、坏账。罚款与滞纳金不得税前扣除。',
  }),
  A('5801', '所得税费用', 'PNL', 'DEBIT', { usageNote: '只装企业所得税；增值税、附加税、印花税不进本科目。' }),
];

/** 编码 → 科目。一次性建表，取科目不做数组扫描（每次发凭证扫 45 行，代价白付）。 */
export const ACCOUNT_BY_CODE: ReadonlyMap<string, Account> = new Map(ACCOUNTS.map((a) => [a.code, a]));

/** 查不到返回 `undefined`。要给用户报错的地方用 `account()`。 */
export function findAccount(code: string): Account | undefined {
  return ACCOUNT_BY_CODE.get(code);
}

/** 取科目，不存在直接抛。分录上的科目编码来源只允许这里。 */
export function account(code: string): Account {
  const found = ACCOUNT_BY_CODE.get(code);
  if (found === undefined) throw new Error(`科目不存在：${code}`);
  return found;
}

/** 有没有下级。只按静态 `parentCode` 判，不设第二份「启用状态」清单。 */
export function hasChildren(code: string): boolean {
  return ACCOUNTS.some((a) => a.parentCode === code);
}

/**
 * 能不能直接挂账：末级 = 自己标了 `isLeaf` 且没有下级。
 * 两个条件都要判 —— 父级挂了下级之后，它自己那行 `isLeaf: true` 就成了历史遗留。
 */
export function isLeafAccount(code: string): boolean {
  const found = ACCOUNT_BY_CODE.get(code);
  return found !== undefined && found.isLeaf && !hasChildren(code);
}

/** 货币资金科目（B4 的分母，也是资产负债表的「货币资金」行）。 */
export const MONEY_CODES: readonly string[] = ['1001', '1002', '1012'];
export const isMoneyAccount = (code: string): boolean => MONEY_CODES.includes(code);

/**
 * **声明了对象级辅助核算的科目** —— 由科目表自己派生，不另存清单。
 *
 * `voucher.assertAuxiliary` 遍历的就是这个集合：声明与实现共用同一份数据，
 * 「声明了但没人校验」这种状态在结构上不可能出现（T06 的硬要求）。
 */
export const AUX_OBJECT_ACCOUNTS: readonly Account[] = ACCOUNTS.filter((a) => (a.auxRequired?.length ?? 0) > 0);

/** 对象级辅助核算的科目编码集合，给校验器做 O(1) 判定。 */
export const AUX_OBJECT_CODES: ReadonlySet<string> = new Set(AUX_OBJECT_ACCOUNTS.map((a) => a.code));

/** 损益类（5xxx）。 */
export const isPnlAccount = (code: string): boolean => code.startsWith('5');

/** 按类别取科目（报表与科目表的展示口径）。 */
export function accountsByCategory(category: AccountCategory): readonly Account[] {
  return ACCOUNTS.filter((a) => a.category === category);
}

/** 全部末级科目。下拉选项与「科目是否存在且可挂账」的校验都用这个口径。 */
export function leafAccounts(): readonly Account[] {
  return ACCOUNTS.filter((a) => isLeafAccount(a.code));
}

/**
 * 科目表自检：把「表内自相矛盾」提前到模块加载时炸掉。
 *
 * 检查的是**表本身的一致性**，不是账务正确性：父子关系断链、非末级却没有下级、
 * 辅助核算声明挂在非末级上、货币资金科目不是末级 —— 这四类错的共同点是
 * 平时看不出来，只在用户点到那一格时表现为「填不进去」或「余额对不上」。
 */
export function assertChartSane(): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of ACCOUNTS) {
    if (seen.has(item.code)) problems.push(`${item.code} 重复声明`);
    seen.add(item.code);
    if (item.parentCode !== undefined && ACCOUNT_BY_CODE.get(item.parentCode) === undefined) {
      problems.push(`${item.code} 的父科目 ${item.parentCode} 不存在`);
    }
    if (!item.isLeaf && !hasChildren(item.code)) problems.push(`${item.code} 声明非末级却没有下级，永远挂不上账`);
    if ((item.auxRequired?.length ?? 0) > 0 && !isLeafAccount(item.code)) {
      problems.push(`${item.code} 不是末级，辅助核算声明永远读不到`);
    }
  }
  for (const code of MONEY_CODES) {
    if (!isLeafAccount(code)) problems.push(`货币资金科目 ${code} 不是末级`);
  }
  if (problems.length > 0) {
    throw new Error(`科目表自相矛盾：${problems.join('；')}。请改 ACCOUNTS，不要另立清单。`);
  }
}

assertChartSane();
