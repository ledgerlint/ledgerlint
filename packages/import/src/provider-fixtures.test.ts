/**
 * 银行样例回归（契约测试）。
 *
 * 每个 `fixtures/providers/<id>/` 是一家银行的样例，必须包含三个文件：
 *
 *   bill.csv       一份真实导出的账单（**原样**，不改字节）
 *   expected.json  我们期望解析出的流水（手写或生成后人工核对过）
 *   SOURCE.md      出处：仓库、路径、取得日期、许可证、是否改动
 *
 * 这三件凑齐才算一条样例。**缺 SOURCE.md 直接失败**——不是形式主义：
 * 开源项目里最容易被遗忘的就是"这段样例是从哪来的、能不能用"，
 * 而等到有人来问的时候，往往已经找不到答案了。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatement } from './parse';

const PROVIDERS_DIR = join(__dirname, '..', 'fixtures', 'providers');

interface ExpectedTxn {
  readonly date: string;
  readonly direction: 'IN' | 'OUT';
  readonly amountCents: number;
  readonly counterparty: string;
  readonly summary: string;
}

interface Expected {
  readonly provider: string;
  readonly count: number;
  readonly txns: readonly ExpectedTxn[];
}

const providers = readdirSync(PROVIDERS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('样例目录的引用规范', () => {
  for (const id of providers) {
    it(`${id}：三个文件齐全（bill.csv / expected.json / SOURCE.md）`, () => {
      const dir = join(PROVIDERS_DIR, id);
      expect(existsSync(join(dir, 'bill.csv')), '缺 bill.csv').toBe(true);
      expect(existsSync(join(dir, 'expected.json')), '缺 expected.json').toBe(true);
      expect(existsSync(join(dir, 'SOURCE.md')), '缺 SOURCE.md —— 没有出处的样例不许入库').toBe(true);
    });
  }
});

describe('样例解析回归', () => {
  for (const id of providers) {
    it(`${id}：逐笔与期望一致`, () => {
      const dir = join(PROVIDERS_DIR, id);
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Expected;
      const report = parseStatement({
        bytes: new Uint8Array(readFileSync(join(dir, 'bill.csv'))),
        filename: `${id}.csv`,
      });

      expect(report.txns).toHaveLength(expected.count);

      const actual = report.txns.map((txn) => ({
        date: txn.date,
        direction: txn.direction,
        amountCents: txn.amountCents,
        counterparty: txn.counterparty.trim(),
        summary: txn.summary.trim(),
      }));
      expect(actual).toEqual(expected.txns);
    });
  }
});

describe('样例集合的完整性', () => {
  it('至少覆盖四家来源（少于四家说明样例被误删）', () => {
    expect(providers.length).toBeGreaterThanOrEqual(4);
  });

  it('含一份 GBK 编码的样例（中文账单最常见的坑）', () => {
    expect(providers).toContain('alipay-gbk');
  });
});
