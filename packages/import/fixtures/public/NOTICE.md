# 第三方样例数据说明（NOTICE）

`packages/import/fixtures/public/` 下的 CSV 来自公开开源仓库，用于验证解析器能处理
**真实导出文件的形状**（表头位置、编码、金额格式），不是我们自己编的数据。

| 本地文件 | 上游路径 |
|---|---|
| `alipay-gbk.csv` | `deb-sig/double-entry-generator` · `example/alipay/example-alipay-records.csv` |
| `icbc-debit-v1.csv` | `.../example/icbc/debit-v1/example-icbc-debit-v1-records.csv` |
| `cmb-debit.csv` | `.../example/cmb/debit/example-cmb-records.csv` |
| `wechat.csv` | `.../example/wechat/example-wechat-records.csv` |

- 来源：<https://github.com/deb-sig/double-entry-generator>（master 分支，2026-11-10 取得）
- 许可：**Apache-2.0**（与本项目 AGPL-3.0-or-later 兼容；保留本说明即满足署名要求）
- 改动：**无**。文件按原样保留，字节未变——这些测试的价值恰恰在于"原样"。
- 数据本身已由上游匿名化（户名/账号为 `xxxx`、`张三` 等示例值）。

## 为什么入库而不是运行时下载

CI 必须离线可跑、结果可复现。运行时下载会让"测试失败"分不清是解析器坏了还是网络坏了。

## 这些样例**不能**证明什么

它们证明的是**格式兼容**，不证明业务判断正确：

- 它们是个人账单，不是企业账套；科目归属、税额拆分、往来对象都无从验证
- 上游匿名化过，字段分布不代表真实业务分布
- 真正的验证仍是 G2 拿到的企业流水（D007：50 条人工标注）
