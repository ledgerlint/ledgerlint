/**
 * `@ledgerlint/import` 的公开出口。
 *
 * T01 只建壳：本包的职责边界先写死在这里，避免后续实现时越界——
 * 纯函数解析，只输出 `Transaction`，**不碰 journal、不碰 core 的可变状态**。
 * 真实实现（解码 / 表头探测 / preset / 幂等 / 余额断点）随 T13–T19 进入本包。
 */

/** 包名标记，供骨架自检与后续替换为真实导出。 */
export const PACKAGE_NAME = '@ledgerlint/import' as const;
