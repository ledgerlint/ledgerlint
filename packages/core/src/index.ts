/**
 * `@ledgerlint/core` 的公开出口。
 *
 * 两条边界写在这里，避免后来者用「顺手加一行 export」破坏它们：
 *
 * 1. **六型契约只以类型出口**（`export type *`）。web 可以借 `PostedVoucher` 的画形状，
 *    但借不到任何运行时实现 —— 契约是规格书，不是工具箱。
 * 2. **`journal/` 不在本文件出口**。`io.ts` 带 `node:fs`，一旦从这里导出，
 *    浏览器端 import 到 `@ledgerlint/core` 就会把文件系统打进 bundle。
 *    要用 journal 走 `@ledgerlint/core/journal` 子路径（见 `journal/index.ts`）。
 *
 * 纯函数层（money / lines / accounts / ledger / voucher）可以放心出口：
 * 它们是零 IO 的，web 与 cli 都要用同一份实现 —— 尤其是 `splitInclusive`，
 * 生成侧与 B3 判定侧必须是同一个函数（T30）。
 *
 * 后续任务按序追加：reports（T10–T12）、assertions（T39–T44）、rules（T21–T29）。
 */
export type * from './types';

/* `Cents` 同时出现在 types 与 money 的出口里。显式导出优先于星号导出，
 * 因此这里点名一次，保证 `import type { Cents } from '@ledgerlint/core'` 永远可用。 */
export type { Cents } from './types';

export * from './money';
export * from './lines';
export * from './accounts';
export * from './ledger';
export * from './reports';
export * from './cashflow';
export * from './voucher';
export * from './rules';
