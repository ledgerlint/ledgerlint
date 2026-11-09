/**
 * 输入层测试（T13–T15）。
 *
 * 四份 fixture 是**按各家导出的真实形状合成的**（表头前有说明块、金额带千分位或 ¥、
 * 单列带符号 / 收支两列 / 收支标志列三种方向表达）。它们能证明解析逻辑正确，
 * **但不能证明"对着真实文件也认得出"** —— 那要靠 G2 拿到的真实流水。
 * 这个区别必须留着：合成的样例永远能过自己的检查。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatement } from './parse';
import { toTransactions, contentHash } from './adapt';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', name)));

function parse(name: string) {
  return parseStatement({ bytes: fixture(name), filename: name });
}

describe('四种来源都能认出表头并解析', () => {
  it('工行：表头在第 7 行，收入/支出分列', () => {
    const report = parse('icbc.csv');
    expect(report.headerRowNo).toBe(7);
    expect(report.txns).toHaveLength(3);
    const first = report.txns[0]!;
    expect(first.date).toBe('2026-11-05');
    expect(first.direction).toBe('IN');
    expect(first.amountCents).toBe(303000);
    expect(first.counterparty).toBe('ABC科技有限公司');
  });

  it('招行：单列带符号 + 千分位，负号表示支出', () => {
    const report = parse('cmb.csv');
    expect(report.headerRowNo).toBe(1);
    expect(report.txns).toHaveLength(2);
    expect(report.txns[0]!.direction).toBe('IN');
    expect(report.txns[0]!.amountCents).toBe(303000);
    expect(report.txns[1]!.direction).toBe('OUT');
    expect(report.txns[1]!.amountCents).toBe(120000);
  });

  it('支付宝：表头在第 18 行，收/支 标志列', () => {
    const report = parse('alipay.csv');
    expect(report.headerRowNo).toBe(18);
    expect(report.txns).toHaveLength(2);
    expect(report.txns[0]!.direction).toBe('OUT');
    expect(report.txns[0]!.amountCents).toBe(15150);
    expect(report.txns[1]!.direction).toBe('IN');
  });

  it('微信：BOM + 表头在第 16 行 + 金额带 ¥', () => {
    const report = parse('wechat.csv');
    expect(report.headerRowNo).toBe(16);
    expect(report.txns).toHaveLength(1);
    expect(report.txns[0]!.amountCents).toBe(50000);
    expect(report.txns[0]!.direction).toBe('OUT');
  });
});

describe('可追溯性', () => {
  it('每笔流水都保留原文件行号，报错时用户能直接翻到那一行', () => {
    const report = parse('icbc.csv');
    for (const txn of report.txns) expect(txn.rowNo).toBeGreaterThan(report.headerRowNo);
    // 工行表头第 7 行，数据从第 8 行开始
    expect(report.txns[0]!.rowNo).toBe(8);
  });

  it('同一份文件重复解析，行指纹与 txnId 完全一致（否则重导会重复记账）', () => {
    const a = parse('cmb.csv');
    const b = parse('cmb.csv');
    expect(a.txns.map((t) => t.fingerprint)).toEqual(b.txns.map((t) => t.fingerprint));

    const hash = contentHash(fixture('cmb.csv'));
    const ta = toTransactions(a, { account: '1002', sourceHash: hash });
    const tb = toTransactions(b, { account: '1002', sourceHash: hash });
    expect(ta.map((t) => t.txnId)).toEqual(tb.map((t) => t.txnId));
    expect(ta[0]!.account).toBe('1002');
  });
});

describe('拒绝解析而不是猜', () => {
  it('.xls 明确拒绝并告诉用户下一步怎么做', () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => parseStatement({ bytes })).toThrow(/另存为/);
  });

  it('.xlsx（zip 魔数）明确拒绝', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(() => parseStatement({ bytes })).toThrow(/CSV/);
  });

  it('空文件直接拒绝', () => {
    expect(() => parseStatement({ bytes: new Uint8Array() })).toThrow(/空/);
  });
});
