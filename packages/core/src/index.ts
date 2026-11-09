/**
 * `@ledgerlint/core` 的公开出口。
 *
 * 本阶段（T01/T02）core 只导出一个纯类型模块。所有导出都是 **type-only**：
 * 用 `export type *` 而不是 `export *`，是为了让「core 的类型可被 web 直接 import，
 * 但 core 的运行时实现不被 web 借用」这条边界（开发计划 §⑤ 5.2）在语法层面成立。
 *
 * 后续任务按序追加：money / lines / chain / ledger / voucher（T05）、accounts（T06）、
 * journal（T03/T04）、reports（T10–T12）、assertions（T39–T44）、rules（T21–T29）。
 */
export type * from './types';
