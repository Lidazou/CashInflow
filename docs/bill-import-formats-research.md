# Bill/Statement Import Formats — MY/CN Personal Finance Importer

Findings verified against real export samples and working parser code.

## 1. WeChat Pay CSV (verified real export)

Preamble (col A only, rest empty) — [sample](https://raw.githubusercontent.com/deb-sig/double-entry-generator/master/example/wechat/example-wechat-records.csv):

```
1 微信支付账单明细
2 微信昵称：[..]
3 起始时间：[2019-08-01 00:00:00] 终止时间：[2019-09-30 23:59:59]
4 导出类型：[全部]        5 导出时间：[..]
6 (blank)                7 共43笔记录
8 收入：1笔 0.35元        9 支出：1笔 28.16元
10 中性交易：0笔 0.00元   11 注：
12-14 1./2./3. notes      15 (blank)
16 ----------------------微信支付账单明细列表--------------------
17 交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
```

Real files insert a `常见问题：` block so the header drifts (`skiprows=16` is a hint, not a rule). **Scan for the first row whose cell 0 trims to `交易时间` and which also contains `收/支`.**

- `收/支`: `收入` / `支出` / `不计收支`; older exports use `/` or blank for neutral (summary calls it `中性交易`). Anything not 收入/支出 → transfer/internal, **never** an expense.
- `金额(元)`: `¥28.16`, `¥2000.00`, `¥50.0` (variable decimals), fullwidth `￥`. Strip `[¥￥,\s]` → **integer minor units**.
- Cells carry stray **TABs** and trailing spaces (`"3985734\t"`) → trim every cell.
- `当前状态` (支付成功/已转账/已收钱/已到账/充值完成/提现已到账…) = all settled; don't filter on it.
- `交易类型` mirroring a bank leg → neutralise to avoid double counting: 零钱充值, 零钱提现, 转入零钱通-*, 零钱通转出-*, 信用卡还款, 购买理财通, 财付通还款, 财付通(银联云闪付).
- `交易单号`/`商户单号` = unique IDs → best dedupe key.

**Encoding:** the verified personal bill is **UTF-8**, not GBK — a working parser reads WeChat as UTF-8 and forces `GBK` only for Alipay. GB18030 does occur on older/merchant exports. **Sniff anyway:** `utf-8-sig` → `gb18030` → `big5`.

## 2. Alipay CSV (verified)

**24 preamble lines** (`skiprows=24`, `encoding='GBK'` — [parser](https://raw.githubusercontent.com/zxc7563598/alipay-wechat-finance/main/analysis.py)). Structure: `84×'-'` → `导出信息：`/用户/支付宝账户/起始时间/导出类型/导出时间 → `共66笔记录` → `收入：1笔 28.50元` / `支出：63笔 16.54元` / `不计收支：2笔 16.37元` → blank → `特别提示：` + 9 numbered notes → blank → line 24 `--------支付宝（中国）网络技术有限公司  电子客户回单--------` → line 25 header.

Header (space-padded, trailing comma = 13 fields): `交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注`

- **GBK/GB18030** (confirmed: fetched bytes mojibake as latin1). Trim every cell — names *and* values are space-padded.
- `金额` is **plain decimal, no ¥** (unlike WeChat).
- `交易状态`: 交易成功 / 等待确认收货 / 退款成功 / 交易关闭. **Exclude `交易关闭`** (never settled; refund arrives as a separate `交易分类=退款` row). Route `不计收支` to transfers. Handle 退款成功 as a negative leg against the original — import both or neither, consistently.
- No trailing footer in the sample; guard regardless.

Touch 'n Go: no public spec — PDF-first tooling only ([TNG_Statement_in_CSV](https://github.com/Rexpert/TNG_Statement_in_CSV)).

## 3. Maybank / CIMB

**No first-party machine-readable spec is public** (checked Maybank2u/M2U Biz FAQ, CIMB Clicks guides). Malaysian statements share one layout: `Date | Tambah / Cheque Serial No | Debit | Credit | Balance`, dates `DD/MM/YYYY` (PDFs often `19 Jul 2024`), `DR`/`CR` markers. Exports are typically `Date, Transaction Description, Debit, Credit, Balance`; Malay = `Tarikh, Keterangan, Debit, Kredit, Baki`. Recurring traps: **separate Debit/Credit vs one signed Amount**, and **missing years** (`15/03`). **Alias-match headers** (case-insensitive, strip spaces/underscores/punctuation, EN+MS synonyms) — never positional.

## 4. Generic CSV rules

- Strip BOM / read `utf-8-sig`.
- **Delimiter sniff** (`,` `;` `\t` `|`): count occurrences *outside quotes* over ~20 lines; choose the most **consistent per-line count**, not the highest total.
- Full RFC 4180: quoted fields with embedded `,`, doubled `"`, and **newlines** — never split on `\n`.
- `DD/MM` vs `MM/DD`: infer if any day > 12; else use the region hint; if still ambiguous **ask once and remember** — never guess silently.
- Amounts: separate Debit/Credit **or** signed; `1,234.56` / `1.234,56` / `1 234,56`; parentheses `(123.45)`; `RM`/`¥` symbols; `-`/`--`/`""` = empty.
- Handle CRLF and `------` separator rows; stop at the first row whose date cell won't parse.

## 5. Duplicate detection

- **Firefly III**: content hash (SHA-256 over the prepared payload, `import_hash_v2`) — rules run *after*, so they never change the hash — plus identifier-based dedupe on `external_id`/`internal_reference`/`notes`/`description`. It also checks **deleted** rows. False negatives from float noise (`12.00000001`) and changed bank IDs. ([docs](https://docs.firefly-iii.org/references/data-importer/duplicate-detection/))
- **Actual Budget**: matches same-amount rows; keeps synced > file-imported > earlier date. ([merging](https://actualbudget.org/docs/transactions/merging/))
- **YNAB**: assigns a per-row `import_id`.

### Recommended algorithm

1. **Stable source ID present** (交易单号 / 交易订单号 / bank ref) → `sha256(provider|account_id|source_id)`; exact hit = duplicate. Highest precision; covers nearly all CN wallets.
2. **Else** `sha256(account_id|YYYY-MM-DD|amount_minor|norm(payee)|norm(desc)|occurrence_index)` — `norm()` = NFKC + trim + collapse whitespace + lowercase; **`occurrence_index`** = 0-based counter of batch rows sharing `(account_id, date, amount_minor, norm(payee))`. This lets **same-day same-amount repeats** (two RM4.50 kopi) both survive, while re-importing the same file regenerates identical indices *and* keys.
3. **Two-tier check**: exact-key hit ⇒ skip; else candidates within **±3 days** with equal `amount_minor` — if exactly one and fuzzy score ≥ threshold, **flag for review, never auto-merge**.
4. Persist `import_hash`, `source_id`, `import_batch_id`; compute the hash **once at import** and keep it stable when the user later edits payee/category.

## 6. XLSX in Node/Electron

- **npm `xlsx` is stuck at 0.18.5** — SheetJS calls it a [known registry bug](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/); `cdn.sheetjs.com` is authoritative (0.20.3). Install the pinned tarball or vendor it.
- **SheetJS CE = Apache-2.0** ([license](https://docs.sheetjs.com/docs/miscellany/license/)): commercial use fine, attribution required; streaming is **Pro (paid)**.
- **ExcelJS = MIT**, true streaming (`~6×` lower peak memory), better formatting; no legacy `.xls`/ODS/`.numbers`.
- **node-xlsx = MIT** thin SheetJS wrapper — inherits its memory model *and* the stale-version problem.
- **Recommendation: exceljs alone suffices for read-only XLSX** (cleanest licence for a desktop app, real streaming). Add SheetJS CE *only* for legacy `.xls`/ODS, via the pinned CDN tarball. Wrap ExcelJS reads in try/catch (strict on corrupt files).
- Sniff magic bytes: `PK\x03\x04` = xlsx, `D0CF11E0` = legacy xls, else text/CSV. Many "XLSX" bank exports are really CSV or HTML-in-`.xls`.

## 7. Date/timezone

- **Store date-only as TEXT `'YYYY-MM-DD'`** — the local calendar date as printed on the statement. A first-class SQLite time-value: lexicographic sort/compare, works with `date()`/`strftime('%F')`. ([SQLite](https://www.sqlite.org/lang_datefunc.html))
- **Never store epoch ms for date-only values** — a statement row is a calendar date, not an instant; UTC round-tripping shifts "today" across midnight for MYT/CST (both UTC+8).
- When a time exists (WeChat/Alipay yes, Maybank/CIMB usually no), keep it separately as TEXT `'YYYY-MM-DD HH:MM:SS'`. CN wallet timestamps are **already local (Asia/Shanghai)** — never re-zone.
- "Today" = client local clock → `YYYY-MM-DD`, compared as text. No timezone math at query time.
- Gotcha: SQLite `date('now')` is **UTC**; use `date('now','localtime')`.
