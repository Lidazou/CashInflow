/**
 * Apply the remaining v1.4 README edits.
 *
 * Mechanical replacements rather than hand-editing, so the numbers stay consistent
 * with what the test suite actually reports and the file names stay consistent with
 * what the release actually publishes.
 *
 * Usage: node tools/patch-readme-v14.cjs [--dry]
 */
const fs = require('node:fs')
const path = require('node:path')

const target = path.join(__dirname, '..', 'README.md')
const dry = process.argv.includes('--dry')

const EDITS = [
  {
    label: 'test count (zh)',
    find: '**232 个用例，跑真实 SQLite 文件，不用 mock。**',
    replace: '**265 个用例，跑真实 SQLite 文件，不用 mock。**'
  },
  {
    label: 'test count (en)',
    find: '**232 tests** run against a real SQLite file',
    replace: '**265 tests** run against a real SQLite file'
  },
  {
    label: 'download table (setup)',
    find: '| `CashInflow-1.3.2-x64-setup.exe` |',
    replace: '| `CashInflow-1.4.0-x64-setup.exe` |'
  },
  {
    label: 'download table (portable)',
    find: '| `CashInflow-1.3.2-x64-portable.exe` |',
    replace: '| `CashInflow-1.4.0-x64-portable.exe` |'
  },
  {
    label: 'screenshot list gains the K-line',
    find: '## 功能截图\n\n### 统计分析：趋势、构成、日历',
    replace: `## 功能截图

### 资金 K 线：把首页当看盘软件用

纵轴金额、横轴时间。余额涨绿跌红，每日收支在下方单独量程里画柱，鼠标扫过任意一天
都会出方框列出当天的交易，旁边是 MA5/10/20/60/250。

![资金 K 线](docs/images/dashboard-kline.png)

### 统计分析：趋势、构成、日历`
  },
  {
    label: 'test table row for the k-line suite',
    find: '| `multi-currency.test.ts` | 服务层跨币种聚合、周期感知预算、离线汇率回退 |',
    replace: `| \`kline.test.ts\` | **资金 K 线**：自适应粒度阈值、无缺口补桶、均线窗口、跨币种单次舍入、日/桶一致性 |
| \`multi-currency.test.ts\` | 服务层跨币种聚合、周期感知预算、离线汇率回退 |`
  }
]

let text = fs.readFileSync(target, 'utf8')
const before = text

for (const edit of EDITS) {
  if (text.includes(edit.replace)) {
    console.log(`skip ${edit.label}: already applied`)
    continue
  }
  if (!text.includes(edit.find)) {
    console.log(`skip ${edit.label}: anchor not found`)
    continue
  }
  text = text.replace(edit.find, edit.replace)
  console.log(`applied ${edit.label}`)
}

if (text === before) {
  console.log('nothing to do')
  process.exit(0)
}
if (dry) {
  console.log('[dry run] no file written')
  process.exit(0)
}

// Guard against the failure mode that bit tools/shots.cjs: never write a README
// that has lost its major sections.
const REQUIRED = ['## 这是什么', '## 安装使用', '## 开发', '## 测试', '## English overview', '## License']
const missing = REQUIRED.filter((needle) => !text.includes(needle))
if (missing.length > 0) {
  console.error('FAIL: the edited README is missing', missing.join(', '))
  process.exit(1)
}

fs.writeFileSync(target, text, 'utf8')
console.log('written:', path.relative(path.join(__dirname, '..'), target))
