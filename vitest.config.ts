import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** 仓库根目录（本文件所在目录），用于把包名别名解析成 src 源码而非构建产物。 */
const repoRoot = fileURLToPath(new URL('./', import.meta.url));

/**
 * 单测只在 `packages/<pkg>/src/**` 下生效。
 *
 * 为什么不做覆盖率阈值：本阶段的验收标准是 A1–A10 的对外符合度（见
 * docs/2026-11-09-MVP定义与商业化.md §③），行覆盖率不是其中任何一条，
 * 拿覆盖率当门禁会让「断言全绿而账错」的旧坑换个形式复发。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@ledgerlint/core': `${repoRoot}packages/core/src/index.ts`,
      '@ledgerlint/import': `${repoRoot}packages/import/src/index.ts`,
      '@ledgerlint/server': `${repoRoot}packages/server/src/index.ts`,
      '@ledgerlint/web': `${repoRoot}packages/web/src/index.ts`,
      '@ledgerlint/cli': `${repoRoot}packages/cli/src/index.ts`,
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    reporters: ['default'],
  },
});
