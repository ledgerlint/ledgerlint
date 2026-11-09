/**
 * `@ledgerlint/cli` 的公开出口。
 *
 * T01 只建壳。真实入口 `bin.ts`（`node bin.ts ./mybook` 一行起来、自动开浏览器）
 * 随 T07 落地；本包不计入 15k 行预算（开发计划 §6.2 只数 core+server+web）。
 */

/** 包名标记，供骨架自检与后续替换为真实导出。 */
export const PACKAGE_NAME = '@ledgerlint/cli' as const;
