# 银行样例（fixtures）

这里的每一份样例都是**真实导出的账单**，用来证明"别人的文件我们能读"。
合成数据证明不了这件事——合成的文件永远是按我们以为的格式写的。

## 目录约定

```
providers/<id>/
  bill.csv        一份原样的账单（不改字节、不改列名）
  expected.json   期望解析出的流水
  SOURCE.md       出处：仓库 / 路径 / 提交 / 许可 / 是否改动
```

**三个文件缺一不可**，`provider-fixtures.test.ts` 会检查。
缺 `SOURCE.md` 的样例不允许入库——开源项目里最容易被遗忘的就是"这段数据从哪来的、能不能用"。

## 加一家银行

1. 新建 `providers/<id>/`（`id` 用「机构-产品-版本」，如 `ccb-debit`）
2. 放一份真实导出的 `bill.csv`，**不要**手工改列名或删行——要改就在解析器里改
3. 写 `SOURCE.md`，六个字段：上游仓库 / 上游路径 / 上游提交 / 取得日期 / 许可证 / 是否改动
4. 生成 `expected.json`：

   ```bash
   npx ledgerlint ./mybook --export-cases bill.csv --out .tmp.csv
   ```

   然后把它转成 `expected.json`（`{ provider, count, txns: [{ date, direction, amountCents, counterparty, summary }] }`）。
   **生成完必须逐条核对**：从我们自己的输出倒推期望值是循环论证，
   只有对着原始文件看一遍才算数。

5. 跑 `npm test`

## 隐私

样例里不能有真实姓名、账号、手机号。上游样例已经匿名化（`xxxx`、`张三`）；
自己提供样例时，先打码再入库。

## 许可证

目前全部样例来自 `deb-sig/double-entry-generator`（**Apache-2.0**），与本项目
AGPL-3.0-or-later 兼容，保留 `SOURCE.md` 即满足署名要求。每份样例的出处见各自目录。

引入新来源时，先确认许可证允许再分发；**不确定就不要入库**，改成运行时下载或直接不测这一家。
