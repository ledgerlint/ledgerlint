/**
 * 公开样例回归（真实导出文件的形状）。
 *
 * 与 `parse.test.ts` 的分工：
 * - `parse.test.ts` 用**合成**文件，锁定我们自己的逻辑（表头位置、方向表达、幂等）；
 * - 本文件用**上游公开的真实导出文件**，验证"别人的文件和我们的解析器能不能对上"。
 *
 * 后者曾经是 D006 里列出的"未验证"项。合成样例永远能过自己的检查，
 * 只有别人生成的文件才能暴露"我们以为的列名"和"银行实际给的列名"之间的差距。
 *
 * 数据来源与许可见 `fixtures/public/NOTICE.md`（Apache-2.0，文件按原样保留）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatement } from './parse';

const sample = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'public', name)));

describe('公开样例：真实导出文件的形状', () => {
  it('支付宝：GBK 编码 + 表头在第 24 行 + 收/支 标志列', () => {
    const report = parseStatement({ bytes: sample('alipay-gbk.csv'), filename: 'alipay-gbk.csv' });
    expect(report.headerRowNo).toBe(24);
    expect(report.txns).toHaveLength(6);
    // 中文没变成乱码，说明 GBK 解码走通了
    const fund = report.txns.find((t) => t.counterparty.includes('蚂蚁'));
    expect(fund).toBeDefined();
    expect(report.txns[0]!.direction).toBe('OUT');
    expect(report.txns[0]!.amountCents).toBe(4974);
  });

  it('工商银行（借记卡 v1）：11 笔', () => {
    const report = parseStatement({ bytes: sample('icbc-debit-v1.csv'), filename: 'icbc-debit-v1.csv' });
    expect(report.txns).toHaveLength(11);
    expect(report.txns[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.txns[0]!.counterparty.length).toBeGreaterThan(0);
  });

  it('招商银行（借记卡）：5 笔，含公积金代发', () => {
    const report = parseStatement({ bytes: sample('cmb-debit.csv'), filename: 'cmb-debit.csv' });
    expect(report.txns).toHaveLength(5);
    const fund = report.txns.find((t) => t.summary.includes('公积金') || t.counterparty.includes('公积金'));
    expect(fund).toBeDefined();
  });

  it('微信支付：16 笔', () => {
    const report = parseStatement({ bytes: sample('wechat.csv'), filename: 'wechat.csv' });
    expect(report.txns).toHaveLength(16);
    expect(report.txns.some((t) => t.direction === 'IN')).toBe(true);
    expect(report.txns.some((t) => t.direction === 'OUT')).toBe(true);
  });

  it('同一份文件重复解析，指纹稳定（否则重导会重复记账）', () => {
    const a = parseStatement({ bytes: sample('wechat.csv') });
    const b = parseStatement({ bytes: sample('wechat.csv') });
    expect(a.txns.map((t) => t.fingerprint)).toEqual(b.txns.map((t) => t.fingerprint));
  });
});
