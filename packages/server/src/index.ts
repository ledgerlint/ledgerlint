/**
 * `@ledgerlint/server` 的公开出口。
 *
 * T01 只建壳。边界（开发计划 §⑤ 5.2）：HTTP + 文件 IO，只依赖 core 的类型与纯函数；
 * 写账只能走 `JournalPort.append()`，不得直写 jsonl。
 * 真实实现（token / 只听 127.0.0.1 / 12 条路由）随 T07 进入本包。
 */

/** 包名标记，供骨架自检与后续替换为真实导出。 */
export const PACKAGE_NAME = '@ledgerlint/server' as const;
