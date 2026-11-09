/**
 * `money.ts` 的测试（T05 + T30）。
 *
 * 除了常规的取整与日期，这里有两个**验收级**的用例：
 * ① `splitInclusive` 的分毫不差（B3 的判定基准就是它）；
 * ② 价税分离在全仓只有一处实现 —— 生成侧与判定侧一旦各写一份，差 1 分会把
 *    「本该绿」的月份判成红灯，而没人能说清是谁错。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertCents,
  dateLt,
  fromYuan,
  isCents,
  isValidAmount,
  isValidDate,
  periodOf,
  periodRange,
  quarterRange,
  roundCents,
  splitInclusive,
  toYuan,
} from './money';

describe('金额：整数分', () => {
  it('roundCents 抵掉二进制浮点噪声，.5 边界向正确方向进位', () => {
    expect(roundCents(100100 * 0.01 * 0.5)).toBe(501); // 500.5 → 501
    expect(roundCents(10198.019801980198)).toBe(10198);
    expect(fromYuan(123.45)).toBe(12345);
    expect(toYuan(203000)).toBe('2030.00');
  });

  it('NaN / Infinity 不许静默变成 0', () => {
    expect(() => roundCents(Number.NaN)).toThrow();
    expect(() => roundCents(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('isCents 只认安全整数；assertCents 拒绝小数、NaN 与超安全整数', () => {
    expect(isCents(0)).toBe(true);
    expect(isCents(-1)).toBe(true); // 余额可以是负的
    expect(isCents(1.5)).toBe(false);
    expect(isCents(Number.NaN)).toBe(false);
    expect(isCents(2 ** 53)).toBe(false);
    expect(() => assertCents(1.5, '含税金额')).toThrow(/整数分/);
  });

  it('isValidAmount：入账金额必须为正（方向靠 direction 表达，不靠负号）', () => {
    expect(isValidAmount(1)).toBe(true);
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount(-100)).toBe(false);
    expect(isValidAmount(1.5)).toBe(false);
  });
});

describe('日期与期间', () => {
  it('isValidDate 拒绝不存在的日期', () => {
    expect(isValidDate('2026-06-30')).toBe(true);
    expect(isValidDate('2026-06-31')).toBe(false);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-1-1')).toBe(false);
  });

  it('periodOf 是期间派生的唯一来源', () => {
    expect(periodOf('2026-03-15')).toBe('2026-03');
    expect(() => periodOf('2026-03-32')).toThrow();
  });

  it('periodRange / quarterRange 的月末按真实天数', () => {
    expect(periodRange('2026-06')).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    expect(periodRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(quarterRange('2026-Q2')).toEqual({ start: '2026-04-01', end: '2026-06-30' });
    expect(quarterRange('2026-Q3')).toEqual({ start: '2026-07-01', end: '2026-09-30' });
  });

  it('dateLt 就是字符串比较（格式固定，不必转 Date）', () => {
    expect(dateLt('2026-03-01', '2026-03-02')).toBe(true);
    expect(dateLt('2026-03-02', '2026-03-02')).toBe(false);
  });
});

describe('价税分离（T30）', () => {
  it('2,030.00 元按 1% 征收率 → 净 2,009.90 / 税 20.10，且分毫不差', () => {
    const { netCents, taxCents } = splitInclusive(203_000, 0.01);
    expect(netCents).toBe(200_990);
    expect(taxCents).toBe(2_010);
    expect(netCents + taxCents).toBe(203_000);
  });

  it('3% 征收率 → 净 1,000.00 / 税 30.00（103,000 分）', () => {
    const { netCents, taxCents } = splitInclusive(103_000, 0.03);
    expect(netCents).toBe(100_000);
    expect(taxCents).toBe(3_000);
    expect(netCents + taxCents).toBe(103_000);
  });

  it('会被四舍五入咬到的金额：100 分 × 1% → 净 99 / 税 1（截断会得 99 与 1，但 101.50 元会分叉）', () => {
    expect(splitInclusive(100, 0.01)).toEqual({ netCents: 99, taxCents: 1 });
    // 10,150 分 / 1.01 = 10,049.5049… → 净 10,050、税 100。用「税=总额×税率」的写法会得净 10,049 / 税 101。
    expect(splitInclusive(10_150, 0.01)).toEqual({ netCents: 10_050, taxCents: 100 });
  });

  it('任意金额 × 任意征收率都满足 净 + 税 === 总额（逐分扫描，含 0 税率）', () => {
    for (const rate of [0, 0.01, 0.03, 0.05, 0.06, 0.13]) {
      for (let amount = 1; amount <= 2_000; amount += 1) {
        const { netCents, taxCents } = splitInclusive(amount, rate);
        expect(netCents + taxCents).toBe(amount);
        expect(taxCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('非法入参直接抛：负金额、0 金额、负税率、NaN 税率', () => {
    expect(() => splitInclusive(0, 0.01)).toThrow();
    expect(() => splitInclusive(-100, 0.01)).toThrow();
    expect(() => splitInclusive(1.5, 0.01)).toThrow();
    expect(() => splitInclusive(100, -0.01)).toThrow();
    expect(() => splitInclusive(100, Number.NaN)).toThrow();
  });
});

/** 递归收集源码文件（跳过测试、node_modules 与构建产物）。 */
function collectSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      found.push(...collectSources(full));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    found.push(full);
  }
  return found;
}

describe('单一实现（T30 的判定基准）', () => {
  it('全仓只有 money.ts 定义了 splitInclusive，其余地方只能 import', () => {
    // `packages/money.test.ts` 位于 packages/core/src/，上溯三级即仓库根。
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const pattern = /(export\s+)?function\s+splitInclusive\b/;
    const defining = collectSources(join(repoRoot, 'packages'))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(repoRoot.length).replaceAll('\\', '/'));

    expect(defining).toEqual(['packages/core/src/money.ts']);
  });
});
