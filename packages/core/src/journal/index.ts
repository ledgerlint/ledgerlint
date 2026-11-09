/**
 * `journal/` 的出口（T03 + T04）。**刻意不从 `packages/core/src/index.ts` 再导出**：
 * `io.ts` 带 `node:fs`，而 core 根出口的 `export type *` 是「web 只借类型、不借运行时实现」
 * 这条边界（开发计划 §⑤ 5.2）的兑现。要用 journal 走 `@ledgerlint/core/journal` 子路径。
 */
export * from './chain';
export * from './io';
export * from './drafts';
export * from './confirm';
export * from './manual';
