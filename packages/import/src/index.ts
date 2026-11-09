/**
 * `@ledgerlint/import` 的公开出口（T13–T15）。
 *
 * 分层：`parseStatement` 只回答"这份文件里有什么"；`toTransactions` 回答
 * "这些流水属于哪个账套、哪个资金账户"。两层之间不共享状态，便于单测。
 *
 * 包边界：纯函数解析，只输出 `Transaction`，**不碰 journal、不碰 core 的可变状态**。
 * 依赖策略：只用 Node 内置。这是个要装到用户本机、还要能离线跑的工具，
 * 多一个包就多一个供应链与升级负担，而需要的能力（GBK 解码、sha256）Node 都有。
 */
export * from './types';
export { decodeBytes } from './decode';
export { parseDelimited } from './csv';
export { PRESETS, findPreset } from './presets';
export { detectHeader, heuristicSlots } from './detect';
export { parseStatement, checkBalanceChain, parseMoney, parseDateCell } from './parse';
export { contentHash, toTransactions } from './adapt';
export type { AdaptOptions } from './adapt';
