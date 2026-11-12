import test from 'node:test'
import assert from 'node:assert/strict'

import { createMarketMonitor } from '../src/market/index.js'

function quoteLine(code, name, price, previousClose) {
  const fields = new Array(36).fill('0')
  fields[0] = '1'
  fields[1] = name
  fields[2] = code.slice(2)
  fields[3] = String(price)
  fields[4] = String(previousClose)
  fields[30] = '20261103093000'
  fields[33] = String(price)
  fields[34] = String(previousClose)
  return `v_${code}="${fields.join('~')}";`
}

function stubFetch(payloads) {
  let index = 0
  return async (url) => {
    const body = typeof payloads === 'function' ? payloads(url) : payloads[Math.min(index++, payloads.length - 1)]
    return {
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(typeof body === 'string' ? body : '').buffer,
    }
  }
}

const baseConfig = {
  marketEnabled: true,
  marketFocus: 'a',
  marketPollSeconds: 5,
  marketAlertCooldown: 300,
  marketWatchlist: [],
  marketYieldToTask: true,
}

test('a tick turns quotes into one market state message', async () => {
  const messages = []
  const monitor = createMarketMonitor({
    getConfig: () => ({ ...baseConfig }),
    send: (message) => messages.push(message),
    // A 2% drop with a wide range should land in the lower half of the scale.
    fetchImpl: stubFetch((url) => (url.includes('eastmoney')
      ? { data: { fenbu: [{ '-2': 3000 }, { '0': 200 }, { '1': 1200 }] } }
      : [
          quoteLine('sh000001', '上证指数', 3600, 3673),
          quoteLine('sz399001', '深证成指', 11000, 10912),
          quoteLine('sz399006', '创业板指', 2200, 2156),
        ].join(''))),
    now: () => Date.parse('2026-11-03T01:40:00Z'),
    logger: { warn() {} },
  })

  monitor.start()
  await monitor.tickNow()
  monitor.stop()

  assert.equal(messages.length, 1)
  const [message] = messages
  assert.equal(message.kind, 'state')
  assert.equal(message.__market, true)
  assert.equal(message.phase, 'market')
  assert.match(message.detail, /上涨 1200 \/ 下跌 3000/)
  assert.deepEqual(message.indices.map((item) => item.name), ['上证', '深证', '创指'])
  assert.ok(message.indices[0].pct < 0)
  assert.ok(message.indices[1].pct > 0)
  assert.ok(message.indices[2].pct > 0)
  assert.ok(message.stage.startsWith('A股'))
  assert.ok(monitor.snapshot.score < 45, `expected a weak score, got ${monitor.snapshot.score}`)
})

test('a disabled market never sends anything', async () => {
  const messages = []
  const monitor = createMarketMonitor({
    getConfig: () => ({ ...baseConfig, marketEnabled: false }),
    send: (message) => messages.push(message),
    fetchImpl: stubFetch(''),
    now: () => Date.parse('2026-11-03T01:40:00Z'),
    logger: { warn() {} },
  })
  await monitor.tickNow()
  assert.equal(messages.length, 0)
})

test('a price crossing arrives as a separate alert message', async () => {
  const messages = []
  let price = 1690
  const monitor = createMarketMonitor({
    getConfig: () => ({
      ...baseConfig,
      marketWatchlist: [{ code: 'sh600519', alias: '茅台', above: 1700, below: 0 }],
    }),
    send: (message) => messages.push(message),
    fetchImpl: stubFetch((url) => {
      if (url.includes('eastmoney')) return { data: { fenbu: [{ '1': 2000 }, { '-1': 2000 }] } }
      return `${quoteLine('sh600519', '贵州茅台', price, 1690)}${quoteLine('sh000001', '上证指数', 3600, 3600)}`
    }),
    now: () => Date.parse('2026-11-03T01:40:00Z'),
    logger: { warn() {} },
  })

  // Alert rules are installed by start(); a bare tick would have no rules.
  monitor.start()
  await monitor.tickNow()
  assert.equal(messages.filter((message) => message.__alert).length, 0)

  price = 1705
  await monitor.tickNow()
  monitor.stop()
  const alerts = messages.filter((message) => message.__alert === true)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0].detail, /1705/)
  assert.equal(alerts[0].phase, 'market-alert')
})

test('a failing endpoint does not throw out of the monitor', async () => {
  const messages = []
  const monitor = createMarketMonitor({
    getConfig: () => ({ ...baseConfig }),
    send: (message) => messages.push(message),
    fetchImpl: async () => { throw new Error('offline') },
    now: () => Date.parse('2026-11-03T01:40:00Z'),
    logger: { warn() {} },
  })
  monitor.start()
  await monitor.tickNow()
  monitor.stop()
  assert.equal(messages.length, 0)
})
