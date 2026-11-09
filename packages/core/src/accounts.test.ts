/**
 * 科目表的测试（T06）。
 *
 * 这一组测试守的不是代码，而是**会计判断与它的实现是否对齐**：
 * `auxRequired` 声明了几处，就必须有几处校验器读它；删掉的科目必须真的不可达
 * （否则「声明了但没人管」会以另一种形式复活）。
 */
import { describe, expect, it } from 'vitest';

import {
  ACCOUNTS,
  ACCOUNT_BY_CODE,
  AUX_OBJECT_ACCOUNTS,
  AUX_OBJECT_CODES,
  MONEY_CODES,
  account,
  accountsByCategory,
  assertChartSane,
  findAccount,
  hasChildren,
  isLeafAccount,
  isMoneyAccount,
  isPnlAccount,
  leafAccounts,
} from './accounts';

describe('科目表自检', () => {
  it('表内没有矛盾（加载时已跑过一次，这里显式再断言一次）', () => {
    expect(() => assertChartSane()).not.toThrow();
  });

  it('编码唯一', () => {
    expect(new Set(ACCOUNTS.map((a) => a.code)).size).toBe(ACCOUNTS.length);
  });

  it('每个 parentCode 都真实存在，且父科目是非末级', () => {
    for (const item of ACCOUNTS) {
      if (item.parentCode === undefined) continue;
      const parent = findAccount(item.parentCode);
      expect(parent, `${item.code} 的父科目`).toBeDefined();
      expect(parent?.isLeaf).toBe(false);
    }
  });

  it('非末级科目都有下级（否则它永远挂不上账）', () => {
    for (const item of ACCOUNTS.filter((a) => !a.isLeaf)) {
      expect(hasChildren(item.code), `${item.code} 应有下级`).toBe(true);
    }
  });

  it('末级判定 = 自己标 isLeaf 且没有下级', () => {
    expect(isLeafAccount('2221')).toBe(false);
    expect(isLeafAccount('5401')).toBe(false);
    expect(isLeafAccount('5602')).toBe(false);
    expect(isLeafAccount('1122')).toBe(true);
    expect(isLeafAccount('9800')).toBe(false);
    expect(() => account('9800')).toThrow(/科目不存在/);
  });
});

describe('辅助核算：声明即实现（T06 硬要求）', () => {
  it('声明了 auxRequired 的科目正好是 4 个往来科目，且都是对象级维度', () => {
    expect(AUX_OBJECT_CODES.size).toBe(4);
    expect([...AUX_OBJECT_CODES].sort()).toEqual(['1122', '1123', '2202', '2203']);
    for (const item of AUX_OBJECT_ACCOUNTS) {
      expect(item.auxRequired).toBeDefined();
      for (const key of item.auxRequired ?? []) expect(['客户', '供应商']).toContain(key);
    }
  });

  it('声明列表与编码集合同源（不可能一边加声明、一边忘了校验）', () => {
    expect([...AUX_OBJECT_CODES]).toEqual(AUX_OBJECT_ACCOUNTS.map((a) => a.code));
    expect(AUX_OBJECT_CODES).toEqual(new Set(ACCOUNTS.filter((a) => (a.auxRequired?.length ?? 0) > 0).map((a) => a.code)));
  });

  it('非往来科目不再挂空声明（BP2 的 21 处声明 / 4 处实现就是死因）', () => {
    const declared = ACCOUNTS.filter((a) => (a.auxRequired?.length ?? 0) > 0).map((a) => a.code);
    expect(declared.sort()).toEqual(['1122', '1123', '2202', '2203']);
    // 曾经声明过、但本 MVP 没有校验器的科目，必须只剩 usageNote 说明文字
    for (const code of ['1002', '1012', '1221', '2241', '5001']) {
      expect(findAccount(code)?.auxRequired, code).toBeUndefined();
    }
  });
});

describe('科目裁剪结果', () => {
  it('工资、研发、固定资产、存货、长投相关科目已全部删除', () => {
    for (const code of ['2211', '222106', '4301', '430101', '430102', '1601', '1602', '1701', '1702', '1801', '1405', '1511']) {
      expect(findAccount(code), `${code} 应当已删除`).toBeUndefined();
    }
  });

  it('12 类事件会触碰的科目全部在册', () => {
    for (const code of ['1001', '1002', '1012', '1122', '1123', '1221', '2202', '2203', '2241', '3001', '3002', '5001', '540101', '560202', '5801']) {
      expect(findAccount(code), `${code} 应保留`).toBeDefined();
    }
  });

  it('三表列报与 5 条断言需要的科目在册', () => {
    for (const code of ['3101', '3103', '3104', '222101', '222102', '222103', '222104', '222105', '222107', '5403', '560301', '5711']) {
      expect(findAccount(code), `${code} 应保留`).toBeDefined();
    }
  });

  it('货币资金三科目都是末级，且科目表里的名字与编码一致', () => {
    expect(MONEY_CODES).toEqual(['1001', '1002', '1012']);
    for (const code of MONEY_CODES) {
      expect(isLeafAccount(code)).toBe(true);
      expect(isMoneyAccount(code)).toBe(true);
    }
    expect(isMoneyAccount('1122')).toBe(false);
    expect(ACCOUNT_BY_CODE.get('1002')?.name).toBe('银行存款');
  });

  it('科目规模在预算内（45 行科目表，末级 40 个）', () => {
    expect(ACCOUNTS.length).toBe(45);
    expect(leafAccounts().length).toBe(40);
  });

  it('分类口径可直接取用', () => {
    expect(accountsByCategory('EQUITY').map((a) => a.code)).toEqual(['3001', '3002', '3101', '3103', '3104']);
    expect(isPnlAccount('5602')).toBe(true);
    expect(isPnlAccount('1122')).toBe(false);
  });
});
