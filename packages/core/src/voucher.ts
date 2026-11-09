/**
 * 凭证落账与红冲（T05 迁移）：**纯函数，不碰文件系统，不自己算 hash**。
 *
 * BP2 的 `post(draft, ctx)` 直接返回一张完整 `Voucher`，还顺手算了折旧计划、
 * 检查期间是否结账。这三件事在新模型里都不属于它：
 *
 * - **hash 与链字段由 `JournalPort.append` 计算**，调用方连传都传不进来
 *   （`append` 的入参是 `Omit<PostedVoucher, 'prevHash' | 'hash'>`）。
 *   因此 `post` 返回的是「待落账凭证体」—— 一张完整的、链字段留白的凭证。
 * - **没有 `status`，也没有 VOID。** 凭证一经追加即事实，只有「再追加一张反向凭证」；
 *   所以这里没有 `PeriodStatus`、没有「已结账锁定」，也没有 `assertNoMutation`
 *   （不可变性由 append-only 存储结构保证，不靠运行时比对）。
 * - **折旧 / 摊销计划、`EventFact` 相关入参**属于规则层（T20 起）与资产模块，
 *   本步一律不引：提前留个空壳，就是下一个「声明了但没人读」。
 */
import type { Cents } from './money';
import { isValidAmount, isValidDate, periodOf, toYuan } from './money';
import type { JournalLine, PostedVoucher, RuleHit } from './types';
import { AUX_OBJECT_CODES, account, isLeafAccount } from './accounts';

/** 凭证号前缀。期间序号形如 `记-0001`（`PostedVoucher.voucherNo` 的约定形态）。 */
export const VOUCHER_NO_PREFIX = '记';

/** 期间内序号 → 凭证号。补零到 4 位，保证「按号排序 == 按发生顺序」。 */
export function makeVoucherNo(seq: number): string {
  if (!Number.isInteger(seq) || seq <= 0) throw new Error(`凭证序号必须是正整数，收到 ${String(seq)}`);
  return `${VOUCHER_NO_PREFIX}-${String(seq).padStart(4, '0')}`;
}

/**
 * 从已有凭证推出同一期间的下一个号。
 *
 * 号会被红冲凭证一起用掉（红冲也是一张凭证），所以按「该期间现有序号的最大值 + 1」取，
 * 而不是按业务凭证张数取 —— 后者会在红冲之后撞号。
 */
export function nextVoucherNo(existing: readonly Pick<PostedVoucher, 'periodId' | 'voucherNo'>[], periodId: string): string {
  let max = 0;
  for (const voucher of existing) {
    if (voucher.periodId !== periodId) continue;
    const tail = Number(voucher.voucherNo.split('-').pop());
    if (Number.isFinite(tail) && tail > max) max = tail;
  }
  return makeVoucherNo(max + 1);
}

/** 落账被拒绝的原因。每个值都要能对应上「用户下一步该改什么」。 */
export type PostErrorCode =
  /** 日期不是真实存在的 `YYYY-MM-DD`。 */
  | 'INVALID_DATE'
  /** 金额不是正整数分。 */
  | 'INVALID_AMOUNT'
  /** 借贷不平。 */
  | 'UNBALANCED'
  /** 合计为 0。 */
  | 'ZERO_AMOUNT'
  /** 科目不存在或不是末级。 */
  | 'NOT_LEAF'
  /** 往来科目缺对象。 */
  | 'AUX_REQUIRED'
  /** 摘要缺失、纯空白或超长（D004）。 */
  | 'INVALID_SUMMARY'
  /** 凭证号过长（红冲摘要要放进 40 字里）。不许它伪装成摘要超长（D004 §7.3）。 */
  | 'INVALID_VOUCHER_NO'
  /** 红冲凭证没指明冲哪张，或非红冲凭证却带了 `reverses`。 */
  | 'REVERSE_TARGET';

export class PostError extends Error {
  readonly code: PostErrorCode;

  constructor(code: PostErrorCode, message: string) {
    super(message);
    this.name = 'PostError';
    this.code = code;
  }
}

/** 待落账凭证。链字段刻意不在这里（由 `JournalPort.append` 计算）。 */
export interface VoucherDraft {
  /** 凭证 ID，落账时生成、一旦写入永不变化；红冲是新 ID。 */
  readonly voucherId: string;
  /** 记账日期 `YYYY-MM-DD`，`periodId` 的唯一来源。 */
  readonly voucherDate: string;
  /** 摘要，必填且非空（D004）。刻意不给默认值：默认值会让「没写摘要」看起来像「写了」。 */
  readonly summary: string;
  readonly voucherNo: string;
  readonly lines: readonly JournalLine[];
  readonly source: PostedVoucher['source'];
  readonly ruleSnapshot?: Readonly<Record<string, string>>;
  /** `MANUAL` / `REVERSE` 凭证没有规则命中，留空比编一个假依据好。 */
  readonly hit?: RuleHit;
  /** 只在 `source === 'REVERSE'` 时出现，指向被冲的原凭证。 */
  readonly reverses?: string;
}

/** 落账后的凭证体：除链字段外与 `PostedVoucher` 逐字一致。 */
export type PostedDraft = Omit<PostedVoucher, 'prevHash' | 'hash'>;

function totals(lines: readonly JournalLine[]): { debitCents: Cents; creditCents: Cents } {
  let debitCents = 0;
  let creditCents = 0;
  for (const line of lines) {
    if (line.direction === 'DEBIT') debitCents += line.amountCents;
    else creditCents += line.amountCents;
  }
  return { debitCents, creditCents };
}

/**
 * 分录可落账性：科目存在、且是末级。
 *
 * 单独导出的理由是**草稿保存时就要过这一关**：只拦在 `post()` 里，草稿会一路漂到
 * 确认那一步才炸，而用户点「确认」看到报错时分不清是自己填错了还是系统坏了。
 */
export function assertEntriesPostable(lines: readonly JournalLine[]): void {
  for (const line of lines) {
    const found = account(line.accountCode); // 不存在直接抛
    if (!isLeafAccount(line.accountCode)) {
      throw new PostError('NOT_LEAF', `科目「${line.accountCode} ${found.name}」不是末级，不能直接挂账。`);
    }
  }
}

/**
 * 往来科目缺对象 → 直接阻断。
 *
 * 检查的科目集合**直接来自 `accounts.ts` 的 `auxRequired` 声明**（`AUX_OBJECT_CODES`）。
 * 这是 T06 的核心改动：BP2 把清单写死在这里（4 个），科目表却声明了 21 处，
 * 于是 17 个科目「看起来有闸门、其实没有」。现在声明与实现共用同一份数据，
 * 第三种状态在结构上不存在 —— 想加一个校验科目，只能在科目表里加声明。
 *
 * 为什么是阻断而不是提示：缺对象时「按客户/供应商查」这个动作从这一刻起就不成立，
 * 而且不可逆（凭证落账后不能改，只能红冲重做）。事后提示等于让人重做一遍。
 */
export function assertAuxiliary(lines: readonly JournalLine[]): void {
  for (const line of lines) {
    if (!AUX_OBJECT_CODES.has(line.accountCode)) continue;
    if ((line.counterparty ?? '').trim().length > 0) continue;
    const found = account(line.accountCode);
    const keys = (found.auxRequired ?? []).join('/');
    throw new PostError(
      'AUX_REQUIRED',
      `科目「${line.accountCode} ${found.name}」必须填${keys}（往来对象）。` +
        '没有对象就没有账龄、没有对账，余额照样平，但往来明细从此查不出来。',
    );
  }
}

/** 摘要长度上限（字）。同 `RuleHit.oneLiner`：长了没人读，没人读等于没有解释。 */
export const SUMMARY_MAX_LENGTH = 40;

/** 摘要闸门（D004）：必填、非空白、≤40 字，空格不算填了（同 `counterparty`）；超限文案必须带「当前 N 字」与来源提示（§7.2）。
 * @throws {PostError} code 为 `INVALID_SUMMARY` */
export function assertSummary(summary: unknown): void {
  const text = typeof summary === 'string' ? summary.trim() : '';
  if (text.length === 0) {
    throw new PostError('INVALID_SUMMARY', '摘要必填：三个月后你得靠它认出这笔账（空串和空格都不算填了）。');
  }
  if (text.length > SUMMARY_MAX_LENGTH) {
    throw new PostError('INVALID_SUMMARY', `摘要最多 ${SUMMARY_MAX_LENGTH} 字（当前 ${text.length} 字）；若来自规则，请检查该规则的一句人话。`);
  }
}

/** 校验并规范化（去首尾空白）：否则「同一句话 + 尾随空格」会算出第二个 hash。 */
export function normalizeSummary(summary: unknown): string {
  assertSummary(summary);
  return (summary as string).trim();
}

/**
 * 草稿 → 待落账凭证体。
 *
 * 校验顺序刻意是「日期 → 摘要 → 金额 → 平衡 → 末级 → 对象」：报错要指向**最靠前**的那个错误，
 * 否则用户改完平衡才发现日期填错，要来回两趟。
 *
 * 借贷不平**一律拒绝**，不做任何自动填平：自动填平会让「差 1 分」这种真实错案
 * 在账上永远消失，而它恰恰是 B1 要抓的东西。
 */
export function post(draft: VoucherDraft): PostedDraft {
  if (!isValidDate(draft.voucherDate)) {
    throw new PostError('INVALID_DATE', `凭证日期必须是真实存在的 YYYY-MM-DD，收到「${draft.voucherDate}」。`);
  }
  const summary = normalizeSummary(draft.summary);
  if (draft.lines.length < 2) {
    throw new PostError('INVALID_AMOUNT', '一张凭证至少要有两条分录（借与贷）。');
  }
  for (const line of draft.lines) {
    if (!isValidAmount(line.amountCents)) {
      throw new PostError('INVALID_AMOUNT', `科目 ${line.accountCode} 的金额必须是正整数分，收到 ${String(line.amountCents)}。`);
    }
  }

  const { debitCents, creditCents } = totals(draft.lines);
  if (debitCents !== creditCents) {
    throw new PostError(
      'UNBALANCED',
      `借贷不平：借方 ${toYuan(debitCents)} 元，贷方 ${toYuan(creditCents)} 元，差额 ${toYuan(debitCents - creditCents)} 元。`,
    );
  }
  if (debitCents <= 0) throw new PostError('ZERO_AMOUNT', '凭证金额必须大于 0。');

  assertEntriesPostable(draft.lines);
  assertAuxiliary(draft.lines);

  // 红冲凭证必须指名冲哪张；反过来，普通凭证带 reverses 会让「谁是红冲」失去唯一答案。
  if (draft.source === 'REVERSE' && draft.reverses === undefined) {
    throw new PostError('REVERSE_TARGET', '红冲凭证必须用 reverses 指向被冲的原凭证 voucherId。');
  }
  if (draft.source !== 'REVERSE' && draft.reverses !== undefined) {
    throw new PostError('REVERSE_TARGET', `source 为 ${draft.source} 的凭证不得带 reverses。`);
  }

  return {
    voucherId: draft.voucherId,
    periodId: periodOf(draft.voucherDate),
    voucherNo: draft.voucherNo,
    voucherDate: draft.voucherDate,
    summary,
    lines: draft.lines,
    totalDebitCents: debitCents,
    totalCreditCents: creditCents,
    source: draft.source,
    ...(draft.reverses === undefined ? {} : { reverses: draft.reverses }),
    ruleSnapshot: draft.ruleSnapshot ?? {},
    ...(draft.hit === undefined ? {} : { hit: draft.hit }),
  };
}

/** 红冲需要知道的原凭证字段。给形状而不是整张 `PostedVoucher`，落账前也能红冲。 */
export type ReverseSource = Pick<PostedVoucher, 'voucherId' | 'voucherNo' | 'voucherDate' | 'lines'>;

export interface ReverseOptions {
  /** 红字凭证的 ID（新 ID，绝不复用原 ID）。 */
  readonly voucherId: string;
  readonly voucherNo: string;
  /** 红冲日期。不得早于原凭证日期 —— 回填历史等于在已交付的报告上重新记一笔。 */
  readonly date: string;
  /** 红冲原因。它进 `ruleSnapshot`，是三个月后唯一能解释「为什么冲」的东西。 */
  readonly reason: string;
}

/**
 * 红冲：**追加一张方向全反的凭证，原凭证一个字都不改**。
 *
 * 与原凭证的关系只由 `reverses` 一个字段表达（指向原 `voucherId`），
 * 因此「原凭证被冲掉了」这件事不需要改原凭证就能被读到 —— 这是 append-only 与
 * 「把原凭证状态改成 REVERSED」的根本区别：后者要改历史，前者只追加事实。
 *
 * 不加 `assertAuxiliary` 以外的判断：原凭证已经过 post，方向和金额都是合法的，
 * 取反之后借贷合计互换，仍然平衡。
 *
 * 摘要是自动生成的「红冲 <原凭证号>」，不接受调用方自填（D004）：`ReverseOptions` 里没有 `summary` 字段。
 */
export function reverse(original: ReverseSource, options: ReverseOptions): PostedDraft {
  if (!isValidDate(options.date)) {
    throw new PostError('INVALID_DATE', `红冲日期必须是真实存在的 YYYY-MM-DD，收到「${options.date}」。`);
  }
  if (options.date < original.voucherDate) {
    throw new PostError('INVALID_DATE', `红冲日期 ${options.date} 不能早于原凭证日期 ${original.voucherDate}（不得回填历史）。`);
  }
  if ((options.reason ?? '').trim().length === 0) {
    throw new PostError('REVERSE_TARGET', '红冲必须写明原因：三个月后没人记得为什么冲。');
  }
  // 先校验凭证号再拼摘要（D004 §7.3）：进摘要的是**原凭证号**（新凭证号不进摘要），要拦的就是它。
  const summaryPrefix = '红冲 ';
  const noLimit = SUMMARY_MAX_LENGTH - summaryPrefix.length;
  if (original.voucherNo.length > noLimit) {
    const message = `凭证号过长：原凭证号最多 ${noLimit} 字，当前 ${original.voucherNo.length} 字（红冲摘要要放进 ${SUMMARY_MAX_LENGTH} 字）。`;
    throw new PostError('INVALID_VOUCHER_NO', message);
  }

  const lines: readonly JournalLine[] = original.lines.map((line) => ({
    ...line,
    direction: line.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
  }));

  return post({
    voucherId: options.voucherId,
    voucherDate: options.date,
    voucherNo: options.voucherNo,
    summary: `${summaryPrefix}${original.voucherNo}`,
    lines,
    source: 'REVERSE',
    reverses: original.voucherId,
    ruleSnapshot: { REVERSE_OF: original.voucherNo, REASON: options.reason },
  });
}

/** 手工凭证的一行输入。金额为分，方向显式给，不靠正负号。 */
export interface ManualLineInput {
  readonly accountCode: string;
  readonly direction: JournalLine['direction'];
  readonly amountCents: Cents;
  readonly counterparty?: string;
  /** 单据号（发票号/合同号）：挂在应收借方或应付贷方那一行，核销时按它精确匹配。 */
  readonly docNo?: string;
}

/** 手工凭证输入。`voucherId` / `voucherNo` 由调用方给（期间序号要按已有凭证推）。 */
export interface ManualVoucherInput {
  readonly voucherId: string;
  readonly voucherNo: string;
  readonly date: string;
  readonly summary: string;
  readonly lines: readonly ManualLineInput[];
}

/**
 * 手工凭证 —— 12 类事件覆盖不到的业务（政府补助、社保退费、押金退还）的唯一出口。
 *
 * 三条硬约束一条都不放松：借贷必须平衡、科目必须末级、摘要必填。
 * 不做的事：不提供「改已记账凭证」—— 那条路只有红冲。
 *
 * 摘要落在 `summary` 字段里（D004），不再塞进 `ruleSnapshot.SUMMARY`：那是配置快照，不是「我说了什么」。
 */
export function makeManualVoucher(input: ManualVoucherInput): VoucherDraft {
  if (!isValidDate(input.date)) {
    throw new PostError('INVALID_DATE', '凭证日期格式不对，应为 YYYY-MM-DD。');
  }
  const summary = normalizeSummary(input.summary);

  const lines: readonly JournalLine[] = input.lines.map((line) => {
    const found = account(line.accountCode); // 不存在直接抛
    return {
      accountCode: line.accountCode,
      accountName: found.name,
      direction: line.direction,
      amountCents: line.amountCents,
      ...(line.counterparty === undefined ? {} : { counterparty: line.counterparty }),
      ...(line.docNo === undefined ? {} : { docNo: line.docNo }),
    };
  });

  const draft: VoucherDraft = {
    voucherId: input.voucherId,
    voucherDate: input.date,
    voucherNo: input.voucherNo,
    summary,
    lines,
    source: 'MANUAL',
  };
  // 让 post 做全部账务校验（平衡、末级、对象），手工凭证不走第二套规则。
  post(draft);
  return draft;
}
