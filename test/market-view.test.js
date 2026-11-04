import test from 'node:test'
import assert from 'node:assert/strict'

import { createMarketMonitor, stockStateMessage, viewList } from '../src/market/index.js'

function quoteLine(code, name, price, previousClose, volume = '1000') {
  const fields = new Array(36).fill('0')
  fields[0] = '1'
  fields[1] = name
  fields[2] = code.slice(2)
  fields[3] = String(price)
  fields[4] = String(previousClose)
  fields[5] = String(previousClose)
  fields[6] = volume
  fields[30] = '20261103103000'
  fields[33] = String(price)
  fields[34] = String(previousClose)
  return `v_${code}="${fields.join('~')}";`
}

function stubFetch(text) {
  return async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { fenbu: [{ '1': 2000 }, { '-1': 2000 }] } }),
    arrayBuffer: async () => new TextEncoder().encode(url.includes('eastmoney') ? '' : text).buffer,
  })
}

const config = {
  marketEnabled: true,
  marketFocus: 'a',
  marketPollSeconds: 5,
  marketAlertCooldown: 300,
  marketYieldToTask: true,
  marketWatchlist: [
    { code: 'sh600519', alias: '茅台', above: 1700, below: 1500 },
    { code: 'hk00700', alias: '腾讯', above: 0, below: 0 },
  ],
}

test('viewList puts the market first, then the watchlist in order', () => {
  const views = viewList(config)
  assert.deepEqual(views.map((view) => view.kind), ['index', 'stock', 'stock'])
  assert.equal(views[1].code, 'sh600519')
  assert.equal(views[1].alias, '茅台')
  assert.equal(views[1].above, 1700)
  assert.equal(views[2].code, 'hk00700')
  // Invalid codes are dropped instead of becoming a dead view. (A bare word
  // like "nope" is still treated as a US ticker on purpose, so use a code that
  // no market can claim.)
  assert.equal(viewList({ watchlist: [{ code: '!!' }, { code: '600519' }] }).length, 2)
  assert.equal(viewList({}).length, 1)
})

test('cycleView walks 总盘 → 自选股 → 总盘 and repaints immediately', async () => {
  const messages = []
  const monitor = createMarketMonitor({
    getConfig: () => ({ ...config }),
    send: (message) => messages.push(message),
    fetchImpl: stubFetch(`${quoteLine('sh600519', '贵州茅台', 1705, 1690)}${quoteLine('sh000001', '上证指数', 3600, 3600)}`),
    now: () => Date.parse('2026-11-03T02:30:00Z'),
    logger: { warn() {} },
  })

  monitor.start()
  await monitor.tickNow()
  messages.length = 0

  const first = monitor.cycleView()
  assert.equal(first.kind, 'stock')
  assert.equal(first.code, 'sh600519')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].phase, 'market-stock')
  assert.match(messages[0].detail, /1705\.00/)

  const second = monitor.cycleView()
  assert.equal(second.code, 'hk00700')

  const third = monitor.cycleView()
  assert.equal(third.kind, 'index')

  // Shift+Tab walks backwards.
  const back = monitor.cycleView({ back: true })
  assert.equal(back.code, 'hk00700')

  monitor.stop()
})

test('selectView jumps by code, ignores unknown codes, and describes the views', async () => {
  const messages = []
  const monitor = createMarketMonitor({
    getConfig: () => ({ ...config }),
    send: (message) => messages.push(message),
    fetchImpl: stubFetch(`${quoteLine('sh600519', '贵州茅台', 1705, 1690)}${quoteLine('sh000001', '上证指数', 3600, 3600)}`),
    now: () => Date.parse('2026-11-03T02:30:00Z'),
    logger: { warn() {} },
  })

  monitor.start()
  await monitor.tickNow()
  messages.length = 0

  const picked = monitor.selectView({ code: 'SH600519' })
  assert.equal(picked.kind, 'stock')
  assert.equal(picked.code, 'sh600519')
  assert.equal(monitor.viewIndex, 1)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].phase, 'market-stock')

  messages.length = 0
  const unknown = monitor.selectView({ code: 'sh999999' })
  assert.equal(unknown.code, 'sh600519')
  assert.equal(monitor.viewIndex, 1)
  assert.equal(messages.length, 0)

  const described = monitor.describeView()
  assert.equal(described.index, 1)
  assert.equal(described.view.code, 'sh600519')
  assert.deepEqual(described.views.map((view) => view.kind), ['index', 'stock', 'stock'])
  assert.equal(described.views[2].code, 'hk00700')

  // The index form is what a future keyboard shortcut or test uses.
  const indexForm = monitor.selectView({ index: 0 })
  assert.equal(indexForm.kind, 'index')
  assert.equal(monitor.viewIndex, 0)

  monitor.stop()
})

test('a missing quote for the viewed stock does not break the cycle', () => {
  const view = { kind: 'stock', code: 'hk00700', alias: '腾讯' }
  assert.equal(stockStateMessage(view, new Map(), null), null)
})

test('the stock bubble shows price, move, volume ratio and threshold state', () => {
  const quotes = new Map([
    ['sh600519', { code: 'sh600519', name: '贵州茅台', price: 1705, pct: 0.89, volume: 1000 }],
  ])
  const message = stockStateMessage(
    { kind: 'stock', code: 'sh600519', alias: '茅台', above: 1700, below: 1500 },
    quotes,
    { pct: 0.1 },
    1,
    1.4,
  )
  assert.equal(message.phase, 'market-stock')
  assert.equal(message.stage, '茅台 · 走强')
  assert.equal(message.state, 'SUCCESS')
  assert.match(message.detail, /1705\.00/)
  assert.match(message.detail, /量比 1\.40/)
  assert.match(message.detail, /上限 1700\.00 已破/)
})

test('a weak name maps to the error state and says so', () => {
  const quotes = new Map([
    ['sh600519', { code: 'sh600519', name: '贵州茅台', price: 1400, pct: -3.2, volume: 1000 }],
  ])
  const message = stockStateMessage({ kind: 'stock', code: 'sh600519', alias: '', above: 0, below: 1500 }, quotes, { pct: 0.2 })
  assert.equal(message.stage, '贵州茅台 · 走弱')
  assert.equal(message.state, 'ERROR')
  assert.match(message.detail, /下限 1500\.00 已破/)
})
