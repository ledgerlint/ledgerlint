#!/usr/bin/env node
/**
 * 代码预算门禁（对应开发计划 §⑥ 6.2：core + server + web ≤ 15,000 行）。
 *
 * 口径（刻意写死在这里，不允许各包自己算）：
 * - 只统计 `packages/{core,server,web}` 下的 `.ts` / `.tsx`；
 * - 排除 `*.test.ts` / `*.test.tsx`（测试不计入硬约束）、`node_modules`、`dist`、`coverage`；
 * - 行数按物理行计（文件末尾换行不多算一行），空行与注释都算——预算是给人读的，
 *   注释占的行数也是真实成本，把它排除会让「靠删注释过门禁」变成常规操作。
 *
 * 超限一律 exit 1。裁剪顺序见开发计划 §6.3：先删后加，不调高上限。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本脚本在 <root>/scripts/ 下）。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 计入主预算的包。 */
const BUDGETED_PACKAGES = ['core', 'server', 'web'];

/**
 * 单独设限的包。
 *
 * `cli/` 原来没有上限，2026-11-10 补上：它已经有 550 行胶水代码，而**胶水代码是最容易
 * 悄悄膨胀的地方**——每次加个参数、加个分支都不觉得多，半年后它就变成了第二个 bin。
 * `import/` 的上限来自开发计划 §6.2；`cli/` 是本轮补的，600 行对应「解析参数 + 引导 +
 * 两个评测子命令」，超出说明有逻辑该往下沉到 core 或 server。
 */
const SEPARATE_LIMITS = [
  { pkg: 'import', limit: 1480 },
  { pkg: 'cli', limit: 600 },
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

/** 行数预算上限（core + server + web）。 */
const LINE_LIMIT = 15000;

/**
 * 测试文件是否不计入预算。
 * @param {string} fileName
 * @returns {boolean}
 */
function isTestFile(fileName) {
  return /\.test\.tsx?$/.test(fileName);
}

/**
 * 递归收集某个目录下的源码文件。
 * 目录不存在时返回空数组——包还没落地不应让门禁崩掉，只应算 0 行。
 * @param {string} dir
 * @returns {string[]} 绝对路径列表
 */
function collectSourceFiles(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      found.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    if (isTestFile(entry.name)) continue;
    found.push(fullPath);
  }
  return found;
}

/**
 * 统计单个文件的物理行数。
 * @param {string} filePath
 * @returns {number}
 */
function countLines(filePath) {
  const text = readFileSync(filePath, 'utf8');
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  // 文件以换行结尾时 split 会多出一个空串，它不是一行代码。
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * @typedef {{ pkg: string, files: number, lines: number }} PackageRow
 * @type {PackageRow[]}
 */
const rows = [];
let total = 0;

for (const pkg of BUDGETED_PACKAGES) {
  const files = collectSourceFiles(join(REPO_ROOT, 'packages', pkg));
  const lines = files.reduce((sum, filePath) => sum + countLines(filePath), 0);
  total += lines;
  rows.push({ pkg: `packages/${pkg}`, files: files.length, lines });
}

const nameWidth = Math.max(...rows.map((row) => row.pkg.length), 8);
const header = `${'包'.padEnd(4)}${'路径'.padEnd(nameWidth + 2)}${'文件数'.padStart(6)}${'行数'.padStart(9)}`;
const divider = '-'.repeat(nameWidth + 21);

console.log(header);
console.log(divider);
for (const row of rows) {
  console.log(
    `${''.padEnd(4)}${row.pkg.padEnd(nameWidth + 2)}${String(row.files).padStart(6)}${String(row.lines).padStart(9)}`,
  );
}
console.log(divider);

const headroom = LINE_LIMIT - total;
console.log(`合计 core+server+web：${total} 行 / 预算 ${LINE_LIMIT} 行（余量 ${headroom} 行）`);

if (total > LINE_LIMIT) {
  console.error(`✗ 代码预算超限 ${total - LINE_LIMIT} 行。`);
  console.error('  处置：按开发计划 §6.3 的裁剪顺序先删后加，不要调高上限。');
  process.exit(1);
}

let separateFailed = false;
for (const { pkg, limit } of SEPARATE_LIMITS) {
  const files = collectSourceFiles(join(REPO_ROOT, 'packages', pkg));
  const lines = files.reduce((sum, filePath) => sum + countLines(filePath), 0);
  const ok = lines <= limit;
  console.log(`${ok ? '✓' : '✗'} packages/${pkg}：${lines} 行 / 上限 ${limit} 行（余量 ${limit - lines} 行）`);
  if (!ok) separateFailed = true;
}

if (separateFailed) {
  console.error('✗ 有包超出单独上限。先删后加，或把逻辑下沉到 core/server。');
  process.exit(1);
}

console.log('✓ 代码预算内。');
