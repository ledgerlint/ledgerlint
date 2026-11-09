/**
 * `@ledgerlint/web` 的公开出口。
 *
 * T01 只建壳，**刻意不引入 Vite**（构建工程随 T33 落地）。
 * 边界（开发计划 §⑤ 5.2）：web 只 import core 的 **type** 与自身的 format/api，
 * 不得 import core 的运行时实现，避免把会计逻辑复制到界面层。
 */

/** 包名标记，供骨架自检；T33 会替换为页面导出。 */
export const PACKAGE_NAME = '@ledgerlint/web' as const;
