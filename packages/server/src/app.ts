/**
 * 本地 HTTP 服务（T07）。
 *
 * 三条安全约束写在一旁，因为它们看起来像"过度设计"，但每一条都对应一个真实攻击面：
 *
 * 1. **只听 127.0.0.1**：财务数据不该出现在局域网里。哪怕用户在公司 wifi 上跑，
 *    也不允许同事通过 `http://<他的IP>:7420` 打开。
 * 2. **校验 Host 头**：只认 `127.0.0.1:<port>` / `localhost:<port>`。没有这一条，
 *    一个恶意网页可以把 `<script>` 指向 `127.0.0.1:7420` 并读响应（DNS rebinding）。
 * 3. **token 必填**：本机其他进程（包括浏览器里的任意网页发的请求）不该默认有权读账。
 *    首次打开靠 URL 里的 `?token=`，API 靠 `x-token` 头。
 *
 * 写入口只有两个，且都**不直接写文件**：`/api/confirm`（草稿 → 凭证）与
 * `/api/voucher`（手工录入）。两者都落到 `JournalPort.append`，也就是说
 * 「写账本」这件事在全仓仍然只有一条路径——校验、编号、哈希、锚点都在那条路上。
 * 这样界面再怎么改，也不可能绕开链去写一行账。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ACCOUNTS, balanceSheet, balances, incomeStatement, isOpeningVoucher, leafAccounts, trialBalance, type PostedVoucher } from '@ledgerlint/core';
import {
  closePeriod,
  closedPeriods,
  confirmDrafts,
  createJournal,
  createDraftStore,
  JOURNAL_LIMITATIONS,
  postManualVoucher,
  postOpeningVoucher,
  reopenPeriod,
  reverseVoucher,
} from '@ledgerlint/core/journal';
import type { JournalVerifyResult, JournalWarning, ManualLineInput, ManualVoucherInput } from '@ledgerlint/core/journal';
import pageHtml from './page.html';

export interface ServerOptions {
  readonly rootDir: string;
  readonly token: string;
  readonly port?: number;
}

export interface ServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 7420;
/** 端口被占时向后试几个。财务人员往往同时开着别的本地工具，撞端口不该让程序起不来。 */
const PORT_ATTEMPTS = 10;

/**
 * 全局局限（T44 会接管这份清单）。
 *
 * 现在先放在这里而不是留空：**没有局限说明的绿勾，就是 BP2 的死因**。
 * 每条都必须能回答"用户拿这份结论去做决定时，可能栽在哪"。
 */
const GLOBAL_LIMITATIONS: readonly string[] = [
  '不做折旧、摊销、计提：工资按实际支付入账，跨月会与权责期间错配。',
  '固定资产资本化不在覆盖范围：大额设备支出需人工确认，系统只告警不自动资本化。',
  '不校验发票真伪、不直连税局、不生成申报表：结论不能作为申报依据。',
];

/** 请求体上限。确认接口只收一组 id，1MB 已经宽得离谱了——设上限是为了不给自己留个吞内存的口子。 */
const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过 1MB');
    chunks.push(buf);
  }
  if (size === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** 从请求体取一个必填字符串。缺失就报人话，不让 `undefined` 漏进内核。 */
function fieldOf(body: unknown, key: string): string {
  if (body === null || typeof body !== 'object') throw new Error('请求内容不是对象。');
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少「${key}」。`);
  return value.trim();
}

/** 写操作的统一收口：成功回 JSON，失败回 400 + 内核抛出的中文整句。 */
async function handleWrite(res: ServerResponse, task: () => Promise<unknown>): Promise<void> {
  try {
    sendText(res, 200, JSON.stringify(await task()), 'application/json; charset=utf-8');
  } catch (error) {
    sendText(
      res,
      400,
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      'application/json; charset=utf-8',
    );
  }
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // 长度不等时 timingSafeEqual 会抛，先比长度；长度本身不是秘密。
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 手工录入的请求体 → 内核入参。
 *
 * 字段逐个判类型，不信任何一个：这是**唯一**从 HTTP 进入写路径的入口，
 * 一个 `undefined` 漏进去就会变成 `NaN` 金额，而 NaN 恰好能通过某些比较。
 * 金额保持字符串形态往下传——解析成"分"只允许发生在 `parseYuan` 一处。
 */
function parseManualInput(payload: unknown): ManualVoucherInput {
  if (payload === null || typeof payload !== 'object') throw new Error('请求内容不是一张凭证。');
  const body = payload as Record<string, unknown>;
  const rawLines = body['lines'];
  if (!Array.isArray(rawLines)) throw new Error('没有分录：一借一贷至少要两行。');

  const lines: ManualLineInput[] = rawLines.map((raw, index) => {
    if (raw === null || typeof raw !== 'object') throw new Error(`第 ${index + 1} 行分录格式不对。`);
    const line = raw as Record<string, unknown>;
    const accountCode = line['accountCode'];
    const direction = line['direction'];
    const amount = line['amount'];
    if (typeof accountCode !== 'string' || accountCode === '') throw new Error(`第 ${index + 1} 行没选科目。`);
    if (direction !== 'DEBIT' && direction !== 'CREDIT') throw new Error(`第 ${index + 1} 行没选借或贷。`);
    if (typeof amount !== 'string') throw new Error(`第 ${index + 1} 行金额格式不对。`);
    const rawCounterparty = line['counterparty'];
    const counterparty =
      typeof rawCounterparty === 'string' && rawCounterparty.trim() !== '' ? rawCounterparty.trim() : undefined;
    return {
      accountCode,
      direction,
      amount,
      ...(counterparty === undefined ? {} : { counterparty }),
    };
  });

  const voucherDate = body['voucherDate'];
  const summary = body['summary'];
  return {
    voucherDate: typeof voucherDate === 'string' ? voucherDate : '',
    summary: typeof summary === 'string' ? summary : '',
    lines,
  };
}

function tokenOf(req: IncomingMessage, url: URL): string {
  const fromQuery = url.searchParams.get('token');
  if (fromQuery !== null && fromQuery !== '') return fromQuery;
  const header = req.headers['x-token'];
  return typeof header === 'string' ? header : '';
}

/** Host 头白名单。挡 DNS rebinding：只看端口不够，必须钉死主机名。 */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? '';
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

async function readVouchers(rootDir: string): Promise<{
  readonly vouchers: readonly PostedVoucher[];
  readonly periods: readonly string[];
  readonly periodCounts: Record<string, number>;
  readonly verify: JournalVerifyResult;
  readonly warnings: readonly JournalWarning[];
}> {
  const journal = await createJournal(rootDir);
  const vouchers: PostedVoucher[] = [];
  for await (const voucher of journal.readAll()) vouchers.push(voucher);
  const shards = journal.index();
  return {
    vouchers,
    periods: shards.map((shard) => shard.period),
    periodCounts: Object.fromEntries(shards.map((shard) => [shard.period, shard.count])),
    verify: await journal.verify(),
    warnings: journal.warnings(),
  };
}

async function stateHandler(rootDir: string): Promise<string> {
  const { vouchers, periods, periodCounts, verify, warnings } = await readVouchers(rootDir);
  const drafts = await (await createDraftStore(rootDir)).readAll();
  const names = new Map(ACCOUNTS.map((item) => [item.code, item.name]));
  const rows = [...balances(vouchers).values()]
    .filter((row) => row.debitCents !== 0 || row.creditCents !== 0)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((row) => ({ ...row, name: names.get(row.code) ?? row.code }));

  // 只回最近 200 张：页面上没人会滚一万行，而全量序列化会让首屏变慢。
  // **显示顺序按日期倒序，不按落账顺序倒序**：确认是攒几天再一起点的，
  // 落账顺序与业务日期本来就不一致，照落账顺序排会让 11-04 排在 11-20 前面。
  const recent = [...vouchers]
    .sort((a, b) =>
      a.voucherDate === b.voucherDate
        ? b.voucherNo.localeCompare(a.voucherNo)
        : a.voucherDate < b.voucherDate
          ? 1
          : -1,
    )
    .slice(0, 200);

  return JSON.stringify({
    rootDir,
    periods,
    periodCounts,
    /**
     * 已结账的期间。界面用它决定「能不能再记」「显示结转还是反结账」。
     * 注意它来自 `journal/periods.jsonl`（事件重放），不是内存里的标记——
     * 重启后、换进程读同一份账本，结果都一样。
     */
    closedPeriods: await closedPeriods(rootDir),
    /** 这个账本建过期初没有。没有的话，资产负债表只有本期发生额。 */
    hasOpening: vouchers.some((voucher) => isOpeningVoucher(voucher)),
    voucherCount: vouchers.length,
    verify,
    warnings,
    trial: trialBalance(vouchers),
    income: incomeStatement(vouchers),
    sheet: balanceSheet(vouchers),
    balances: rows,
    vouchers: recent,
    // 手工录入的科目下拉。只给**末级**科目：给了父级科目，用户选了就是一次
    // "落账被拒"，而他并不知道父级科目不该挂账。
    accounts: leafAccounts().map((item) => ({
      code: item.code,
      name: item.name,
      category: item.category,
      ...(item.auxRequired === undefined ? {} : { auxRequired: item.auxRequired }),
    })),
    // 待确认的草稿。**未识别（E99）的也在里面**，且带空分录——
    // 它们不是"已经处理完的"，而是"需要你判断的"，界面必须能分辨。
    drafts,
    limitations: [...JOURNAL_LIMITATIONS, ...GLOBAL_LIMITATIONS],
  });
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // 页面用的是内联样式与内联脚本；除此之外不允许加载任何外部资源。
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(body);
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const wanted = options.port ?? DEFAULT_PORT;
  let boundPort = wanted;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);

      if (!hostAllowed(req, boundPort)) {
        sendText(res, 403, '{"error":"bad host"}', 'application/json; charset=utf-8');
        return;
      }
      if (!sameToken(tokenOf(req, url), options.token)) {
        if (url.pathname === '/') {
          sendText(
            res,
            401,
            '<!doctype html><meta charset="utf-8"><title>需要令牌</title>' +
              '<body style="font:15px/1.7 system-ui;padding:40px;max-width:640px">' +
              '<h1 style="font-size:18px">需要访问令牌</h1>' +
              '<p>请使用启动时终端里打印的完整链接打开本页（链接里带 <code>?token=</code>）。</p>' +
              '<p style="color:#6b7280">直接访问 127.0.0.1 不带令牌会被拒绝，这是为了避免本机其他程序读到你的账。</p>',
            'text/html; charset=utf-8',
          );
          return;
        }
        sendText(res, 401, '{"error":"unauthorized"}', 'application/json; charset=utf-8');
        return;
      }

      if (url.pathname === '/') {
        sendText(res, 200, pageHtml, 'text/html; charset=utf-8');
        return;
      }
      if (url.pathname === '/api/state') {
        sendText(res, 200, await stateHandler(options.rootDir), 'application/json; charset=utf-8');
        return;
      }
      if (url.pathname === '/api/confirm') {
        if (req.method !== 'POST') {
          sendText(res, 405, '{"error":"method not allowed"}', 'application/json; charset=utf-8');
          return;
        }
        try {
          const payload = await readJsonBody(req);
          const ids =
            payload !== null && typeof payload === 'object' && Array.isArray((payload as { ids?: unknown }).ids)
              ? ((payload as { ids: unknown[] }).ids.filter((id): id is string => typeof id === 'string'))
              : undefined;
          const result = await confirmDrafts(options.rootDir, ids);
          sendText(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
        } catch (error) {
          // 写失败必须原样回给界面：用户要知道是哪一张、为什么，而不是"保存失败"。
          sendText(
            res,
            400,
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            'application/json; charset=utf-8',
          );
        }
        return;
      }
      if (url.pathname === '/api/voucher') {
        if (req.method !== 'POST') {
          sendText(res, 405, '{"error":"method not allowed"}', 'application/json; charset=utf-8');
          return;
        }
        try {
          const input = parseManualInput(await readJsonBody(req));
          const result = await postManualVoucher(options.rootDir, input);
          sendText(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
        } catch (error) {
          // 校验失败的文案是中文整句（"借贷不平：…差额 200.00 元"），直接给界面显示。
          sendText(
            res,
            400,
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            'application/json; charset=utf-8',
          );
        }
        return;
      }
      if (url.pathname === '/api/opening') {
        if (req.method !== 'POST') {
          sendText(res, 405, '{"error":"method not allowed"}', 'application/json; charset=utf-8');
          return;
        }
        // 解析放在 handleWrite 里面：解析失败是 400（用户填错了），不是 500。
        await handleWrite(res, async () => {
          // 期初复用手工凭证的行解析：两者都是"科目 + 借贷 + 金额字符串"。
          const parsed = parseManualInput(await readJsonBody(req));
          return postOpeningVoucher(options.rootDir, { voucherDate: parsed.voucherDate, lines: parsed.lines });
        });
        return;
      }
      if (url.pathname === '/api/closing') {
        if (req.method !== 'POST') {
          sendText(res, 405, '{"error":"method not allowed"}', 'application/json; charset=utf-8');
          return;
        }
        await handleWrite(res, async () => closePeriod(options.rootDir, fieldOf(await readJsonBody(req), 'period')));
        return;
      }
      if (url.pathname === '/api/reopen') {
        if (req.method !== 'POST') {
          sendText(res, 405, '{"error":"method not allowed"}', 'application/json; charset=utf-8');
          return;
        }
        await handleWrite(res, async () => {
          const body = await readJsonBody(req);
          return reopenPeriod(options.rootDir, fieldOf(body, 'period'), fieldOf(body, 'reason'));
        });
        return;
      }
      if (url.pathname === '/api/reverse') {
        if (req.method !== 'POST') {
          sendText(res, 405, '{"error":"method not allowed"}', 'application/json; charset=utf-8');
          return;
        }
        await handleWrite(res, async () => {
          const body = await readJsonBody(req);
          return reverseVoucher(options.rootDir, fieldOf(body, 'voucherId'), fieldOf(body, 'reason'));
        });
        return;
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      sendText(res, 404, '{"error":"not found"}', 'application/json; charset=utf-8');
    })().catch((error: unknown) => {
      /**
       * 兜底：任何没被接住的异常都不能让进程退出。
       *
       * 这不是防御性编程的洁癖——真实发生过：`fieldOf()` 在 `try` 外面抛，
       * 一个 `reason: \"  \"` 的请求就让整个服务进程挂掉，
       * 用户那边看到的是"页面突然打不开"，而日志里只有一行未捕获的 Promise。
       * 本机单用户工具更不该因为一个畸形请求而死。
       */
      if (!res.headersSent) {
        sendText(
          res,
          500,
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          'application/json; charset=utf-8',
        );
      }
    });
  });

  const listenOnce = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  let lastError: unknown = null;
  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    try {
      boundPort = await listenOnce(wanted + offset);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') break;
    }
  }
  if (lastError !== null) throw lastError;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/?token=${encodeURIComponent(options.token)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
