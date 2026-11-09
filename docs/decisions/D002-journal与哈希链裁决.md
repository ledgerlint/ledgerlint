# D002 · Journal 存储与哈希链的裁决

- **状态**：已裁决，待实施
- **日期**：2026-11-09
- **裁决人**：交付总监（代行，属工程判断、可回退）
- **对象**：T03（append-only 存储）/ T04（哈希链）

---

## 一、复核证据（交付总监亲自跑，非工程师测试）

用临时用例独立验证三件事，结果如下：

| 场景 | `verify()` 实测返回 | 判定 |
|---|---|---|
| 改中间一张凭证的 `totalDebitCents` | `ok:false` · `breakAt:"v2"` · `HASH_MISMATCH` · detail 含重算/落盘两个 hash | ✅ 精确，可用 |
| 尾部残片（模拟写入中断） | `ok:true` · `warnings:[TRUNCATED_TAIL]` | ⚠️ 可接受，但调用方易只看 ok |
| **手工删除最后一张凭证** | **`ok:true` · `warnings:[]`** | ❌ **静默通过，必须修** |

第三条的含义：**账少了一张，系统报"一切正常"，连警告都没有**。这与 BP2「27 个绿勾但账是错的」是同一个失败模式。哈希链在结构上无法区分「末尾凭证被删」与「从来没记过」，必须靠**链外锚点**。

---

## 二、裁决

### D2-1 行数预算：按口径澄清，不调预算

`journal/` 实测 539 行（`io.ts` 298 + `chain.ts` 234 + `index.ts` 7），超 380 预算。

**裁定采用口径 (a)**：开发计划 §6.2 预算表的 `core/money+lines+chain+ledger+voucher | 1,100` 一行**明确列了 `chain`**，而 `core/journal/（io + 链接入 + 索引）| 380` 的说明里没有 chain。故：

- `chain.ts` 234 行 → 归「money+lines+chain+ledger+voucher 1,100」栏（当前该栏仅 types.ts，余量充足）
- `journal/` = `io.ts` 298 + `index.ts` 7 = **305 ≤ 380** ✓

**这不是放水，是口径澄清。** 但设一条附加纪律：**今后不得再以「换个栏位」的方式消化超支**；若再次超预算，只能走 §6.3 的裁剪顺序或修订计划文档。核对基线：core 合计 1,011 / 5,620，总量 1,031 / 15,000，均余量充足。

### D2-2 契约追加：允许 `verify()` 带原因（不进哈希，纯加宽）

`JournalPort.verify()` 现返回 `{ ok, breakAt? }`，装不下「为什么断」。批准追加快照字段：

```ts
verify(): Promise<{
  ok: boolean;
  breakAt?: string;
  reason?: ChainBreakReason;              // 追加
  warnings?: readonly JournalWarning[];   // 追加
}>;
```

理由：三个字段均**不进哈希域**，属纯加宽，不影响任何已落盘凭证；且 D 泳道若只能显示「链断了」，等于没查。此项不影响「五方签字」约定（仅追加可选字段）。

### D2-3 `ok` 语义收紧（关键）

| 情形 | `ok` | 要求 |
|---|---|---|
| 链完整、无坏行 | `true` | `warnings` 为空 |
| **中间出现未解析行**（`UNPARSEABLE_LINE`） | **`false`** | 坏行意味着数据丢失或手改，不能给绿 |
| **尾部残片**（`TRUNCATED_TAIL`） | `true`（保持） | 但 `warnings` **必须非空**；交付包必须整段打印 warnings，调用方不得只读 `ok` |
| **链尾锚点不符**（`HEAD_MISMATCH`） | **`false`** | 见 D2-5 |

一句话：**`ok:true` 只允许表示「链完整且没有已知损伤」；任何已知损伤要么拉红，要么必须在 warnings 里显形并被交付包打印。**

### D2-4 拒绝给 `PostedVoucher` 加 `seq`（落账序号）

工程师提出「无落账序号，链序只能推断」。**驳回**，两个理由：

1. **它解决不了问题**。已实测：删掉尾张后 `verify` 全绿；加 `seq` 后依然全绿——因为「末尾少了 seq=3」与「本来就只到 seq=2」在链内同形。
2. **它会改哈希域**。`PostedVoucher` 的字段顺序是规范序列化协议的一部分，加字段等于全部历史 hash 失效，而这正是 D001 要防的事。

替代方案见 D2-5。

### D2-5 新增链外锚点 `journal/.head.json`（本裁决唯一的实现增量）

为堵住「删尾张静默通过」：

- `append` 成功后原子更新 `journal/.head.json`，内容 `{ period, lastHash, count, updatedAt }`（`count` 为全账套凭证总数）
- `verify()` 增一条比对：文件里最后一张的 `hash` ≠ `head.lastHash`，或实际张数 ≠ `head.count` → `ok:false`、`reason:'HEAD_MISMATCH'`、`breakAt` 为**最后一张仍存在的 voucherId**
- `.head.json` 与 journal 同目录，能被同时篡改——**这是已知局限，必须写进 `LIMITATIONS` 并在交付包中显形**：「锚点在本地，可被同时修改；它防的是误删与换机恢复旧备份，不防有意的内部篡改。」

---

## 三、需要工程师补的用例（永久，不要临时文件）

1. **删尾张** → `ok:false`、`reason:'HEAD_MISMATCH'`、`breakAt` 非空（当前实测为 `ok:true`，即本裁决要修的 bug）
2. **中间坏行**（不是尾部残片）→ `ok:false`、`reason:'UNPARSEABLE_LINE'`
3. **尾部残片** → `ok:true` 且 `warnings` 非空（锁住现状，防止将来被"顺手改成 false"）
4. **误删后把 head 一并删掉** → 应能识别为「锚点缺失」并给 `warnings`，不得静默 `ok:true`
5. **正常 1000 张** → `ok:true`、`warnings` 为空、`head.count === 1000`

---

## 四、影响

| 项 | 变化 |
|---|---|
| 行数 | `journal/` 预计 +40~60 行（`io.ts` 涨到约 355），仍在 380 内 |
| 契约 | `types.ts` 仅 `JournalPort.verify` 返回类型追加两个可选字段 |
| 已落盘数据 | 无（尚无真实凭证，锚点从零开始） |
| D001 五方签字约定 | 不触发（纯追加可选字段） |
