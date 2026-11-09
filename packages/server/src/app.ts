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
 * 这里只做"读"。所有写入仍然只能走 `JournalPort.append`，不经 HTTP——
 * 在还没做确认页（T34）之前，先不开写接口：**开一个不完整的写入口比不开更危险**。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ACCOUNTS, balances, trialBalance, type PostedVoucher } from '@ledgerlint/core';
import { createJournal, createDraftStore, JOURNAL_LIMITATIONS } from '@ledgerlint/core/journal';
import type { JournalVerifyResult, JournalWarning } from '@ledgerlint/core/journal';
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

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // 长度不等时 timingSafeEqual 会抛，先比长度；长度本身不是秘密。
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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
  readonly verify: JournalVerifyResult;
  readonly warnings: readonly JournalWarning[];
}> {
  const journal = await createJournal(rootDir);
  const vouchers: PostedVoucher[] = [];
  for await (const voucher of journal.readAll()) vouchers.push(voucher);
  return {
    vouchers,
    periods: journal.index().map((shard) => shard.period),
    verify: await journal.verify(),
    warnings: journal.warnings(),
  };
}

async function stateHandler(rootDir: string): Promise<string> {
  const { vouchers, periods, verify, warnings } = await readVouchers(rootDir);
  const drafts = await (await createDraftStore(rootDir)).readAll();
  const names = new Map(ACCOUNTS.map((item) => [item.code, item.name]));
  const rows = [...balances(vouchers).values()]
    .filter((row) => row.debitCents !== 0 || row.creditCents !== 0)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((row) => ({ ...row, name: names.get(row.code) ?? row.code }));

  // 只回最近 200 张：页面上没人会滚一万行，而全量序列化会让首屏变慢。
  const recent = vouchers.slice(-200).reverse();

  return JSON.stringify({
    rootDir,
    periods,
    voucherCount: vouchers.length,
    verify,
    warnings,
    trial: trialBalance(vouchers),
    balances: rows,
    vouchers: recent,
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
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      sendText(res, 404, '{"error":"not found"}', 'application/json; charset=utf-8');
    })();
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
