/**
 * 凭证落账的测试（T05）。
 *
 * 四类拒绝必须都在这里被咬住：日期、金额、借贷不平、往来对象缺失。
 * 第三条（借贷不平）**不允许有任何自动填平**：自动填平会让「差 1 分」这种真实错案
 * 在账上永远消失，而它正是 B1 要抓的东西。
 */
import { describe, expect, it } from 'vitest';

import { ACCOUNTS, AUX_OBJECT_CODES } from './accounts';
import { entryLine } from './lines';
import type { JournalLine } from './types';
import type { PostErrorCode, PostedDraft } from './voucher';
import {
  PostError,
  VOUCHER_NO_PREFIX,
  assertAuxiliary,
  assertEntriesPostable,
  makeManualVoucher,
  makeVoucherNo,
  nextVoucherNo,
  post,
  reverse,
} from './voucher';

/** 断言抛出 `PostError` 且 code 匹配。比拿消息做正则稳定。 */
function expectPostError(run: () => unknown, code: PostErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PostError);
    expect((error as PostError).code).toBe(code);
    return;
  }
  throw new Error(`应当抛出 PostError(${code})，但没有抛`);
}

/** 一张正常的赊销凭证：借 1122（带客户）/ 贷 5001。 */
function saleLines(counterparty?: string): JournalLine[] {
  const head = counterparty === undefined ? entryLine('1122', 'DEBIT', 100_000) : entryLine('1122', 'DEBIT', 100_000, { counterparty });
  return [head, entryLine('5001', 'CREDIT', 100_000)];
}

describe('凭证号', () => {
  it('makeVoucherNo 补零到 4 位', () => {
    expect(makeVoucherNo(1)).toBe(`${VOUCHER_NO_PREFIX}-0001`);
    expect(makeVoucherNo(1234)).toBe('记-1234');
    expect(() => makeVoucherNo(0)).toThrow();
    expect(() => makeVoucherNo(1.5)).toThrow();
  });

  it('nextVoucherNo 按同期序号最大值 + 1（红冲凭证也占号，不会撞号）', () => {
    const existing = [
      { periodId: '2026-03', voucherNo: '记-0001' },
      { periodId: '2026-03', voucherNo: '记-0007' },
      { periodId: '2026-04', voucherNo: '记-0009' },
    ];
    expect(nextVoucherNo(existing, '2026-03')).toBe('记-0008');
    expect(nextVoucherNo(existing, '2026-04')).toBe('记-0010');
    expect(nextVoucherNo(existing, '2026-05')).toBe('记-0001');
  });
});

describe('post：合法凭证', () => {
  it('期间由 voucherDate 派生，合计由分录算出', () => {
    const posted = post({
      voucherId: 'V1',
      voucherDate: '2026-03-10',
      voucherNo: makeVoucherNo(1),
      lines: saleLines('甲客户'),
      source: 'IMPORT',
    });
    expect(posted.periodId).toBe('2026-03');
    expect(posted.totalDebitCents).toBe(100_000);
    expect(posted.totalCreditCents).toBe(100_000);
    // 两个链字段不在返回类型里：它们只能由 JournalPort.append 计算
    expect(Object.keys(posted)).not.toContain('hash');
    expect(Object.keys(posted)).not.toContain('prevHash');
  });

  it('一借多贷（代扣个税那种形状）也算得对', () => {
    const posted = post({
      voucherId: 'V2',
      voucherDate: '2026-03-31',
      voucherNo: makeVoucherNo(2),
      lines: [
        entryLine('1122', 'DEBIT', 300_000, { counterparty: '乙客户' }),
        entryLine('5001', 'CREDIT', 200_000),
        entryLine('222101', 'CREDIT', 100_000),
      ],
      source: 'MANUAL',
    });
    expect(posted.totalDebitCents).toBe(300_000);
    expect(posted.totalCreditCents).toBe(300_000);
  });
});

describe('post：必须拒绝的四类', () => {
  it('借贷不平 → UNBALANCED，且不允许自动填平', () => {
    const lines = [entryLine('1122', 'DEBIT', 100_000, { counterparty: '甲客户' }), entryLine('5001', 'CREDIT', 99_999)];
    expectPostError(() => post({ voucherId: 'V3', voucherDate: '2026-03-10', voucherNo: '记-0003', lines, source: 'MANUAL' }), 'UNBALANCED');
  });

  it('差额文案要给出借、贷与差额三个数（用户才知道改哪边）', () => {
    const lines = [entryLine('1122', 'DEBIT', 203_000, { counterparty: '甲客户' }), entryLine('5001', 'CREDIT', 200_990)];
    try {
      post({ voucherId: 'V4', voucherDate: '2026-03-10', voucherNo: '记-0004', lines, source: 'MANUAL' });
      expect.unreachable('借贷不平必须抛');
    } catch (error) {
      expect(error).toBeInstanceOf(PostError);
      expect((error as PostError).message).toContain('2030.00');
      expect((error as PostError).message).toContain('2009.90');
      expect((error as PostError).message).toContain('20.10');
    }
  });

  it('金额为 0 → 拒绝（红冲靠方向表达，不靠负号，所以 0 金额没有含义）', () => {
    const lines = [entryLine('1002', 'DEBIT', 0), entryLine('1002', 'CREDIT', 0)];
    expectPostError(() => post({ voucherId: 'V5', voucherDate: '2026-03-10', voucherNo: '记-0005', lines, source: 'MANUAL' }), 'INVALID_AMOUNT');
  });

  it('日期不是真实存在的日期 → INVALID_DATE（期间绝不独立赋值）', () => {
    expectPostError(
      () => post({ voucherId: 'V6', voucherDate: '2026-02-30', voucherNo: '记-0006', lines: saleLines('甲客户'), source: 'MANUAL' }),
      'INVALID_DATE',
    );
  });

  it('只有一条分录 → 拒绝（单边凭证不可能平衡）', () => {
    expect(() =>
      post({ voucherId: 'V7', voucherDate: '2026-03-10', voucherNo: '记-0007', lines: [entryLine('1002', 'DEBIT', 100)], source: 'MANUAL' }),
    ).toThrowError(PostError);
  });

  it('非末级科目 → NOT_LEAF；不存在的科目 → 直接抛', () => {
    expectPostError(() => assertEntriesPostable([entryLine('2221', 'DEBIT', 100)]), 'NOT_LEAF');
    expectPostError(() => assertEntriesPostable([entryLine('5602', 'DEBIT', 100)]), 'NOT_LEAF');
    expect(() => entryLine('9999', 'DEBIT', 100)).toThrow(/科目不存在/);
  });
});

describe('辅助核算的对象级校验（T06 硬要求的原始动机）', () => {
  it('1122 借方不填 counterparty → 必须拒绝（BP2 的 a28 就是这条）', () => {
    const lines = [entryLine('1122', 'DEBIT', 500_000), entryLine('5001', 'CREDIT', 500_000)];
    expectPostError(() => assertAuxiliary(lines), 'AUX_REQUIRED');
    expect(() => post({ voucherId: 'V8', voucherDate: '2026-03-10', voucherNo: '记-0008', lines, source: 'MANUAL' })).toThrowError(
      /必须填客户/,
    );
  });

  it('2202 贷方不填 counterparty → 必须拒绝；填了就能过', () => {
    expectPostError(() => assertAuxiliary([entryLine('2202', 'CREDIT', 100_000)]), 'AUX_REQUIRED');
    expect(() => assertAuxiliary([entryLine('2202', 'CREDIT', 100_000, { counterparty: '丙供应商' })])).not.toThrow();
  });

  it('空白字符串不算填了对象（否则「空格」会成为绕过闸门的习惯）', () => {
    expectPostError(() => assertAuxiliary([entryLine('1122', 'DEBIT', 100_000, { counterparty: '   ' })]), 'AUX_REQUIRED');
  });

  it('非往来科目不拦（1122 之外的资产/费用随便记）', () => {
    expect(() => assertAuxiliary([entryLine('560205', 'DEBIT', 100_000), entryLine('1002', 'CREDIT', 100_000)])).not.toThrow();
  });

  it('声明与实现一一对应：科目表里每个 auxRequired 科目都被拦，其余一律不拦', () => {
    for (const item of ACCOUNTS) {
      const declared = (item.auxRequired?.length ?? 0) > 0;
      const lines = [entryLine(item.code, 'DEBIT', 100)];
      if (declared) {
        expect(AUX_OBJECT_CODES.has(item.code), `${item.code} 声明了却不在校验集合里`).toBe(true);
        expectPostError(() => assertAuxiliary(lines), 'AUX_REQUIRED');
      } else {
        expect(AUX_OBJECT_CODES.has(item.code), `${item.code} 没声明却被拦`).toBe(false);
        expect(() => assertAuxiliary(lines), `${item.code} 没声明却被拦`).not.toThrow();
      }
    }
  });
});

describe('红冲：追加一张反向凭证，不改原凭证', () => {
  const original: PostedDraft = post({
    voucherId: 'V100',
    voucherDate: '2026-03-10',
    voucherNo: makeVoucherNo(100),
    lines: saleLines('甲客户'),
    source: 'IMPORT',
  });

  it('方向全部取反、source=REVERSE、reverses 指向原 voucherId', () => {
    const reversal = reverse(original, { voucherId: 'V101', voucherNo: makeVoucherNo(101), date: '2026-03-20', reason: '客户退款' });
    expect(reversal.source).toBe('REVERSE');
    expect(reversal.reverses).toBe('V100');
    expect(reversal.lines.map((line) => line.direction)).toEqual(['CREDIT', 'DEBIT']);
    expect(reversal.totalDebitCents).toBe(original.totalDebitCents);
    expect(reversal.ruleSnapshot['REVERSE_OF']).toBe(original.voucherNo);
    // 原凭证（内存里的对象）一个字都没变
    expect(original.lines[0]?.direction).toBe('DEBIT');
    expect(original.voucherId).toBe('V100');
  });

  it('期间由红冲日期派生（不沿用原凭证期间）', () => {
    const reversal = reverse(original, { voucherId: 'V102', voucherNo: makeVoucherNo(102), date: '2026-04-02', reason: '跨月红冲' });
    expect(reversal.periodId).toBe('2026-04');
  });

  it('红冲日期不得早于原凭证日期', () => {
    expectPostError(() => reverse(original, { voucherId: 'V103', voucherNo: '记-0103', date: '2026-03-09', reason: 'x' }), 'INVALID_DATE');
  });

  it('红冲必须写原因（否则三个月后没人知道为什么冲）', () => {
    expectPostError(() => reverse(original, { voucherId: 'V104', voucherNo: '记-0104', date: '2026-03-20', reason: '  ' }), 'REVERSE_TARGET');
  });

  it('普通凭证不得带 reverses（否则「谁是红冲」没有唯一答案）', () => {
    expectPostError(
      () =>
        post({
          voucherId: 'V105',
          voucherDate: '2026-03-10',
          voucherNo: '记-0105',
          lines: saleLines('甲客户'),
          source: 'MANUAL',
          reverses: 'V100',
        }),
      'REVERSE_TARGET',
    );
  });

  it('红冲凭证也必须满足辅助核算（对象随分录一起保留）', () => {
    const reversal = reverse(original, { voucherId: 'V106', voucherNo: '记-0106', date: '2026-03-20', reason: '金额错' });
    expect(reversal.lines[0]?.counterparty).toBe('甲客户');
  });
});

describe('makeManualVoucher', () => {
  it('摘要必填、至少两条分录', () => {
    expect(() =>
      makeManualVoucher({ voucherId: 'M1', voucherNo: '记-0001', date: '2026-03-10', summary: 'a', lines: [] }),
    ).toThrowError(/摘要必填/);
    expect(() =>
      makeManualVoucher({
        voucherId: 'M2',
        voucherNo: '记-0002',
        date: '2026-03-10',
        summary: '银行手续费',
        lines: [{ accountCode: '560302', direction: 'DEBIT', amountCents: 1_000 }],
      }),
    ).toThrowError(PostError);
  });

  it('摘要落进 ruleSnapshot.SUMMARY（PostedVoucher 没有 summary 字段）', () => {
    const draft = makeManualVoucher({
      voucherId: 'M3',
      voucherNo: '记-0003',
      date: '2026-03-10',
      summary: '支付办公室租金',
      lines: [
        { accountCode: '560202', direction: 'DEBIT', amountCents: 800_000 },
        { accountCode: '1002', direction: 'CREDIT', amountCents: 800_000 },
      ],
    });
    expect(draft.ruleSnapshot?.['SUMMARY']).toBe('支付办公室租金');
    expect(draft.lines[0]?.accountName).toBe('管理费用—房租物业水电');
    expect(() => post(draft)).not.toThrow();
  });
});
