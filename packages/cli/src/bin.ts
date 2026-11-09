/**
 * `ledgerlint` 命令行入口（T07）。
 *
 * 设计上只有一条路径要顺：**一条命令、一个浏览器页面、不需要读文档**。
 * 开源工具的第一个用户是路过的人，他给 90 秒；90 秒里跑不起来不会再回来。
 *
 * 两个刻意的选择：
 *
 * - **token 不落在账套目录里**。账套是"纯文本、可 git diff、可拷走"的资产，
 *   把凭据塞进去，用户一分享账本就把访问权一起分享了。token 放在用户主目录下、
 *   按账套绝对路径哈希索引——换机器换 token，这正是想要的。
 * - **没有子命令**。`ledgerlint ./mybook` 就是全部。子命令留给真正需要分叉的那天。
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { entryLine, periodOf, post } from '@ledgerlint/core';
import { createJournal } from '@ledgerlint/core/journal';
import { startServer } from '@ledgerlint/server';

const DEFAULT_DIR = './mybook';
const TOKEN_DIR = join(homedir(), '.ledgerlint', 'tokens');

interface BookMeta {
  readonly name: string;
  readonly standard: string;
  readonly taxpayerKind: string;
  readonly vatRate: number;
  readonly createdAt: string;
}

/** 演示账套：一家 3 人技术型公司的一个月。每个数字都在科目表里有落点。 */
const DEMO: readonly {
  date: string;
  summary: string;
  lines: readonly [string, 'DEBIT' | 'CREDIT', number][];
}[] = [
  {
    date: '2026-11-02',
    summary: '股东实缴注册资本',
    lines: [
      ['1002', 'DEBIT', 20_000_000],
      ['3001', 'CREDIT', 20_000_000],
    ],
  },
  {
    date: '2026-11-05',
    summary: '收到 A 客户项目款（含 1% 征收率）',
    lines: [
      ['1002', 'DEBIT', 3_030_000],
      ['5001', 'CREDIT', 3_000_000],
      ['222101', 'CREDIT', 30_000],
    ],
  },
  {
    date: '2026-11-06',
    summary: '支付 11 月办公室房租',
    lines: [
      ['560202', 'DEBIT', 1_200_000],
      ['1002', 'CREDIT', 1_200_000],
    ],
  },
  {
    date: '2026-11-10',
    summary: '购买办公用品与云服务',
    lines: [
      ['560205', 'DEBIT', 151_500],
      ['1002', 'CREDIT', 151_500],
    ],
  },
  {
    date: '2026-11-15',
    summary: '发放 11 月工资（未计提，按实付入账）',
    lines: [
      ['560201', 'DEBIT', 1_500_000],
      ['1002', 'CREDIT', 1_500_000],
    ],
  },
  {
    date: '2026-11-20',
    summary: '缴纳 10 月增值税',
    lines: [
      ['222101', 'DEBIT', 30_000],
      ['1002', 'CREDIT', 30_000],
    ],
  },
  {
    date: '2026-11-25',
    summary: '银行账户管理费',
    lines: [
      ['560302', 'DEBIT', 1_500],
      ['1002', 'CREDIT', 1_500],
    ],
  },
];

function tokenPathFor(rootDir: string): string {
  const digest = createHash('sha1').update(resolve(rootDir)).digest('hex').slice(0, 16);
  return join(TOKEN_DIR, `${digest}.token`);
}

async function loadOrCreateToken(rootDir: string): Promise<string> {
  const path = tokenPathFor(rootDir);
  if (existsSync(path)) {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  }
  await mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString('hex');
  await writeFile(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

async function ensureBook(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, 'journal'), { recursive: true });
  const bookPath = join(rootDir, 'book.json');
  if (existsSync(bookPath)) return;
  const meta: BookMeta = {
    name: '我的账套',
    standard: '小企业会计准则',
    taxpayerKind: '小规模纳税人',
    vatRate: 0.01,
    createdAt: new Date().toISOString().slice(0, 10),
  };
  await writeFile(bookPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

async function seedDemo(rootDir: string): Promise<number> {
  const journal = await createJournal(rootDir);
  const existing: { periodId: string; voucherNo: string }[] = [];
  for await (const voucher of journal.readAll()) {
    existing.push({ periodId: voucher.periodId, voucherNo: voucher.voucherNo });
  }
  if (existing.length > 0) return 0;

  for (let index = 0; index < DEMO.length; index += 1) {
    const item = DEMO[index];
    if (item === undefined) continue;
    const draft = post({
      voucherId: `demo-${String(index + 1).padStart(4, '0')}`,
      voucherDate: item.date,
      summary: item.summary,
      voucherNo: `记-${String(index + 1).padStart(4, '0')}`,
      lines: item.lines.map(([code, direction, cents]) => entryLine(code, direction, cents)),
      source: 'MANUAL',
      ruleSnapshot: { SEED: 'demo' },
    });
    await journal.append(periodOf(item.date), draft);
  }
  return DEMO.length;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore' }).on('error', () => undefined);
  } catch {
    // 打不开浏览器不是致命错误：下面会把链接打出来，用户自己贴。
  }
}

/**
 * 终端里的显示宽度。
 * 中文、全角标点在等宽终端里占 2 列，按字符数算会让右边框一路歪——
 * 这个框是用户看到的第一个东西，歪了就显得"没做完"。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function banner(lines: readonly string[]): void {
  const width = Math.max(...lines.map(displayWidth)) + 2;
  const bar = '─'.repeat(width);
  console.log(`\n┌${bar}┐`);
  for (const line of lines) {
    const pad = width - displayWidth(line);
    console.log(`│ ${line}${' '.repeat(pad - 1)}│`);
  }
  console.log(`└${bar}┘\n`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      demo: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help === true) {
    console.log(
      [
        '用法: ledgerlint [账套目录] [选项]',
        '',
        '选项:',
        '  --demo        账套为空时写入一份演示数据',
        '  --port <n>    指定端口（默认 7420，被占用时自动向后试）',
        '  --no-open     不自动打开浏览器',
        '  -h, --help    显示本帮助',
        '',
        '示例:',
        '  npx ledgerlint ./mybook --demo',
      ].join('\n'),
    );
    return;
  }

  const rootDir = resolve(positionals[0] ?? DEFAULT_DIR);
  await ensureBook(rootDir);

  const seeded = values.demo === true ? await seedDemo(rootDir) : 0;
  const token = await loadOrCreateToken(rootDir);
  const port = values.port === undefined ? undefined : Number.parseInt(values.port, 10);
  const server = await startServer({ rootDir, token, ...(port === undefined ? {} : { port }) });

  banner([
    '账本 lint 已启动（仅本机可访问）',
    '',
    `账套   ${rootDir}`,
    `地址   ${server.url}`,
    `令牌   ${token}`,
    '',
    seeded > 0 ? `已写入 ${seeded} 张演示凭证` : '按 Ctrl+C 停止',
  ]);

  if (values['no-open'] !== true) openBrowser(server.url);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

await main();
