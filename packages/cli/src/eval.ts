/**
 * 规则评测（T29b）。
 *
 * 存在理由只有一个：**在接 LLM 之前，先能证明关键词规则到底有多差**。
 * 没有这个基线，"LLM 有没有用"就只能靠感觉，而感觉在这件事上尤其不可靠——
 * 模型把「转账」翻成「客户回款」时看起来非常合理，你只有对着标注才知道它错了。
 *
 * 两个子命令：
 *   --export-cases <bank.csv> --out <cases.csv>   把一份流水导出成待标注的表
 *   --eval <cases.csv>                            按标注打分
 */
import { readFile, writeFile } from 'node:fs/promises';
import { classify, CN_SMALL_RULES, type Draft, type RuleContext } from '@ledgerlint/core';
import { parseDelimited, parseStatement, toTransactions, contentHash } from '@ledgerlint/import';

const HEADER = [
  'date',
  'direction',
  'amount',
  'counterparty',
  'summary',
  'expected_event',
  'expected_accounts',
  'note',
] as const;

const CSV_SPECIAL = /[",\n]/;

function cell(value: string): string {
  return CSV_SPECIAL.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const yuan = (cents: number): string => (cents / 100).toFixed(2);

// ────────────────────────────────────────────────────────────────────────────
// 导出待标注表
// ────────────────────────────────────────────────────────────────────────────
export async function exportCases(bankCsvPath: string, outPath: string): Promise<void> {
  const bytes = new Uint8Array(await readFile(bankCsvPath));
  const report = parseStatement({ bytes, filename: bankCsvPath });
  const txns = toTransactions(report, { account: '1002', sourceHash: contentHash(bytes) });

  const lines = [
    HEADER.join(','),
    ...txns.map((txn) =>
      [
        txn.date,
        txn.direction,
        yuan(txn.amountCents),
        txn.counterparty,
        txn.summary,
        '', // expected_event：留空待标注
        '', // expected_accounts
        '', // note
      ]
        .map(cell)
        .join(','),
    ),
  ];
  await writeFile(outPath, `${lines.join('\n')}\n`, 'utf8');

  console.log(`已导出 ${txns.length} 条待标注流水 → ${outPath}`);
  console.log('下一步：给 expected_event 填上你认为正确的事件（E1/E5/E8/…；认不出填 E99）。');
  console.log('判错事件比留 E99 更贵——留 E99 至少有人会看，错记没人看。');
}

// ────────────────────────────────────────────────────────────────────────────
// 打分
// ────────────────────────────────────────────────────────────────────────────

interface CaseRow {
  readonly rowNo: number;
  readonly date: string;
  readonly direction: 'IN' | 'OUT';
  readonly amountCents: number;
  readonly counterparty: string;
  readonly summary: string;
  readonly expectedEvent: string;
  readonly expectedAccounts: readonly string[];
}

interface Outcome {
  readonly row: CaseRow;
  readonly draft: Draft;
  readonly kind: 'correct' | 'missed' | 'overreach' | 'wrong-specific' | 'accounts-differ';
}

const EVENT_RE = /^E\d{1,2}$/;

function readCases(rows: readonly (readonly string[])[], headerIndex: number): CaseRow[] {
  const header = rows[headerIndex]!;
  const at = (row: readonly string[], name: string): string => {
    const index = header.indexOf(name);
    return index < 0 ? '' : (row[index] ?? '').trim();
  };

  const out: CaseRow[] = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const expectedEvent = at(row, 'expected_event').toUpperCase();
    if (expectedEvent === '') continue; // 未标注的行不参与打分
    if (!EVENT_RE.test(expectedEvent)) {
      console.warn(`第 ${i + 1} 行 expected_event「${expectedEvent}」不是 E1..E16/E99，已跳过`);
      continue;
    }
    const direction = at(row, 'direction').toUpperCase() === 'OUT' ? 'OUT' : 'IN';
    const amountCents = Math.round(Number(at(row, 'amount').replaceAll(',', '')) * 100);
    if (!Number.isFinite(amountCents)) {
      console.warn(`第 ${i + 1} 行金额读不出，已跳过`);
      continue;
    }
    out.push({
      rowNo: i + 1,
      date: at(row, 'date') || '2026-01-01',
      direction,
      amountCents,
      counterparty: at(row, 'counterparty'),
      summary: at(row, 'summary'),
      expectedEvent,
      expectedAccounts: at(row, 'expected_accounts')
        .split('/')
        .map((code) => code.trim())
        .filter((code) => code !== ''),
    });
  }
  return out;
}

function classifyCase(row: CaseRow, ctx: RuleContext): Draft {
  return classify(
    {
      txnId: `eval-${row.rowNo}`,
      sourceHash: 'eval',
      rowNo: row.rowNo,
      date: row.date,
      direction: row.direction,
      amountCents: row.amountCents,
      balanceCents: null,
      counterparty: row.counterparty,
      summary: row.summary,
      fingerprint: `eval-${row.rowNo}`,
      account: '1002',
    },
    ctx,
    CN_SMALL_RULES,
  );
}

export async function runEval(casesPath: string, ctx: RuleContext): Promise<number> {
  const bytes = new Uint8Array(await readFile(casesPath));
  const rows = parseDelimited(new TextDecoder('utf-8').decode(bytes));
  const headerIndex = rows.findIndex((row) => row.some((c) => c.trim() === 'expected_event'));
  if (headerIndex < 0) throw new Error('找不到表头（需要 expected_event 这一列）。用 --export-cases 生成模板。');

  const cases = readCases(rows, headerIndex);
  if (cases.length === 0) {
    console.log('没有已标注的行。给 expected_event 填上值再跑。');
    return 0;
  }

  const outcomes: Outcome[] = cases.map((row) => {
    const draft = classifyCase(row, ctx);
    const got = draft.event;
    const want = row.expectedEvent;

    let kind: Outcome['kind'];
    if (got === want) {
      const gotAccounts = new Set(draft.lines.map((line) => line.accountCode));
      const wantAccounts = new Set(row.expectedAccounts);
      const sameAccounts =
        wantAccounts.size === 0 || ([...wantAccounts].every((c) => gotAccounts.has(c)) && gotAccounts.size === wantAccounts.size);
      kind = sameAccounts ? 'correct' : 'accounts-differ';
    } else if (got === 'E99') {
      kind = 'missed';
    } else if (want === 'E99') {
      kind = 'overreach';
    } else {
      kind = 'wrong-specific';
    }
    return { row, draft, kind };
  });

  const count = (kind: Outcome['kind']): number => outcomes.filter((o) => o.kind === kind).length;
  const total = outcomes.length;
  const correct = count('correct');
  const accountsDiffer = count('accounts-differ');
  const missed = count('missed');
  const overreach = count('overreach');
  const wrongSpecific = count('wrong-specific');
  const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;

  console.log('');
  console.log(`标注样本 ${total} 条`);
  console.log(`  事件判对        ${correct}  (${pct(correct)})`);
  console.log(`  事件对、科目不同 ${accountsDiffer}  (${pct(accountsDiffer)})`);
  console.log(`  该识别却落 E99   ${missed}  (${pct(missed)})   ← 显形，用户会看到`);
  console.log(`  不该识别却识别   ${overreach}  (${pct(overreach)})   ← 危险，用户不会看`);
  console.log(`  判成了别的具体事件 ${wrongSpecific}  (${pct(wrongSpecific)})   ← 最危险`);
  console.log('');

  const bad = outcomes.filter((o) => o.kind === 'wrong-specific' || o.kind === 'overreach' || o.kind === 'accounts-differ');
  if (bad.length > 0) {
    console.log('需要看的具体差异（最多 20 条）：');
    for (const o of bad.slice(0, 20)) {
      console.log(
        `  行 ${o.row.rowNo}  ${o.row.direction} ${yuan(o.row.amountCents).padStart(10)}  ${o.row.summary.slice(0, 24)}`,
      );
      console.log(`      期望 ${o.row.expectedEvent} → 实际 ${o.draft.event}（${o.draft.ruleId}）`);
      console.log(`      它说：${o.draft.oneLiner}`);
    }
    if (bad.length > 20) console.log(`  ……另有 ${bad.length - 20} 条`);
    console.log('');
  }

  // 危险错误的判据来自 D007：错账比空白更难发现，所以它单独拉出来做退出码。
  return wrongSpecific + overreach > 0 ? 1 : 0;
}
