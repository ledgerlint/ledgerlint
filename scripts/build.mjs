/**
 * 打包脚本（T07）。
 *
 * 为什么是打包而不是 `tsc` 逐包产出：
 * 仓库里的 import 是**无扩展名**的（`./money`），配合 `moduleResolution: bundler` 做类型检查；
 * 而 Node 的 ESM 要求写全扩展名。逐包 tsc 出来的产物在 Node 里跑不起来，
 * 改成带扩展名的写法又要改动每一个文件（且会污染 bundler 语义）。
 *
 * 打成一个文件还有两个附带好处：`npx` 只需下载一个文件；发布包里不存在
 * 「workspace 包没装到」这类问题。
 */
import { build } from 'esbuild';
import { rm, chmod } from 'node:fs/promises';

const outfile = 'dist/ledgerlint.js';

await rm('dist', { recursive: true, force: true });

const result = await build({
  entryPoints: ['packages/cli/src/bin.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // 页面作为字符串内联：发布包不依赖任何相对路径的资源文件。
  loader: { '.html': 'text' },
  // bin 的 shebang 由这里补，源文件里不写——否则 tsc 会把它当语法错误。
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

await chmod(outfile, 0o755).catch(() => undefined);

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`built ${outfile}  ${(bytes / 1024).toFixed(1)} KB`);
