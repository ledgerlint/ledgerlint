/**
 * 规则引擎测试（T21）。
 *
 * 重点不是"能识别"，而是**该不识别的时候不识别**：
 * 补助、退税、押金退回都是进账，但都不是收入。把它们错记成收入，
 * 报表会好看，税会多交，而且没有任何一条机检能查出来。
 */
import { describe, expect, it } from 'vitest';
import type { Transaction } from '../types';
import { classify } from './engine';
import { CN_SMALL_RULES } from './cn-small';
import type { RuleContext } from './types';

const CTX: RuleContext = { vatRate: 0.01, shareholders: ['邓某某'] };

function txn(patch: Partial<Transaction> & Pick<Transaction, 'direction' | 'summary'>): Transaction {
  return {
    txnId: 't1',
    sourceHash: 's1',
    rowNo: 10,
    date: '2026-11-05',
    amountCents: 303000,
    balanceCents: null,
    counterparty: '',
    fingerprint: 'fp1',
    account: '1002',
    ...patch,
  };
}

const run = (patch: Parameters<typeof txn>[0]) => classify(txn(patch), CTX, CN_SMALL_RULES);

describe('六类事件的科目落点', () => {
  it('股东实缴 → 实收资本', () => {
    const d = run({ direction: 'IN', summary: '投资款', counterparty: '邓某某' });
    expect(d.event).toBe('E11');
    expect(d.lines.map((l) => [l.accountCode, l.direction])).toEqual([
      ['1002', 'DEBIT'],
      ['3001', 'CREDIT'],
    ]);
  });

  it('客户货款 → 收入 + 销项税，且净额与税额相加等于总额', () => {
    const d = run({ direction: 'IN', summary: '项目款', counterparty: 'ABC科技有限公司' });
    expect(d.event).toBe('E1');
    const net = d.lines.find((l) => l.accountCode === '5001')!;
    const tax = d.lines.find((l) => l.accountCode === '222101')!;
    expect(net.amountCents + tax.amountCents).toBe(303000);
    expect(tax.amountCents).toBe(3000);
    expect(d.assumed.length).toBeGreaterThan(0);
  });

  it('预收 → 预收账款，不提前确认收入', () => {
    const d = run({ direction: 'IN', summary: '预付款', counterparty: '客户A' });
    expect(d.event).toBe('E12');
    expect(d.lines.some((l) => l.accountCode === '2203')).toBe(true);
    expect(d.lines.some((l) => l.accountCode === '5001')).toBe(false);
  });

  it('付供应商采购款 → 主营业务成本', () => {
    const d = run({ direction: 'OUT', summary: '采购款', counterparty: '某供应商', amountCents: 500000 });
    expect(d.event).toBe('E5');
    expect(d.lines[0]!.accountCode).toBe('5401');
  });

  it('付房租 → 管理费用—房租物业', () => {
    const d = run({ direction: 'OUT', summary: '11月房租', counterparty: '某某物业', amountCents: 120000 });
    expect(d.event).toBe('E8');
    expect(d.lines[0]!.accountCode).toBe('560202');
  });

  it('付银行手续费 → 财务费用', () => {
    const d = run({ direction: 'OUT', summary: '账户管理费', amountCents: 1500 });
    expect(d.lines[0]!.accountCode).toBe('560302');
  });
});

describe('顺序即优先级', () => {
  it('股东打款但备注写「项目款」→ 仍判为股东往来，不判收入', () => {
    const d = run({ direction: 'IN', summary: '项目款', counterparty: '邓某某' });
    expect(d.event).toBe('E13');
    expect(d.confidence).toBe('LOW');
    expect(d.lines.some((l) => l.accountCode === '5001')).toBe(false);
  });

  it('对方不在股东名单、备注也没有关键词 → 不猜', () => {
    const d = run({ direction: 'IN', summary: '转账', counterparty: '某单位' });
    expect(d.event).toBe('E99');
    expect(d.lines).toHaveLength(0);
    expect(d.oneLiner).toContain('没认出');
  });
});

describe('不该识别的时候不识别', () => {
  for (const [name, summary, counterparty] of [
    ['政府补助', '科技局研发补助', '某某区科技局'],
    ['出口退税', '退税', '税务局'],
    ['押金退回', '保证金退回', '某园区'],
  ] as const) {
    it(`${name} 必须落 E99，不得记成收入`, () => {
      const d = run({ direction: 'IN', summary, counterparty, amountCents: 1000000 });
      expect(d.event).toBe('E99');
      expect(d.lines).toHaveLength(0);
    });
  }
});

describe('摘要长度', () => {
  it('超长摘要被截到 40 字以内（生成侧就截，不等 post 报错）', () => {
    const long = '这是一个非常非常长的流水摘要'.repeat(5);
    const d = run({ direction: 'OUT', summary: `房租 ${long}`, amountCents: 100 });
    expect([...d.summary].length).toBeLessThanOrEqual(40);
    expect(d.summary.endsWith('…')).toBe(true);
  });
});
