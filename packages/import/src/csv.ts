/**
 * 分隔符解析（CSV / TSV）
 *
 * 手写而不是用库，是因为要处理的脏数据就那几类，而库通常会「宽容地猜」：
 *   · 字段被引号包住，内部还有逗号（`"张三,李四"`）
 *   · 引号内的换行（备注里带换行）
 *   · 字段尾部带制表符和空格（工行样例里每个字段都带）
 *   · 空值用 `-` 或 `/` 占位（微信、支付宝）
 * 猜错一个字段，整列就错位；所以清洗规则必须是我们自己写死的。
 */

/** 按前几行里哪种分隔符出现得最多来选；引号内的不算 */
export function guessDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 8).join('\n');
  const counts: Array<[string, number]> = [
    [',', 0],
    ['\t', 0],
    [';', 0],
  ];
  let inQuote = false;
  for (const ch of sample) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote) {
      for (const c of counts) if (ch === c[0]) c[1] += 1;
    }
  }
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] === 0 ? ',' : counts[0]![0];
}

export function parseDelimited(text: string, delimiter = guessDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuote = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  // 最后一行没有换行符结尾
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
