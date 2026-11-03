import test from 'node:test'
import assert from 'node:assert/strict'

import {
  averageVolume,
  marketOf,
  normalizeCode,
  parseBreadth,
  parseKline,
  parseTencentQuotes,
  sessionProgress,
  sessionState,
} from '../src/market/feed.js'

// Captured verbatim from qt.gtimg.cn on 2026-11-03. Keeping the real payload
// means an upstream field reorder fails the test instead of silently producing
// a zero price.
const A_SHARE = 'v_sh000001="1~上证指数~000001~3638.03~3638.03~0.00~0~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20261103092000~0.00~0.00~0.00~0.00~3638.03/0/0~0~0~0.00~16.53~~0.00~0.00~0.00~570684.77~635632.36~0.00~-1~-1~0.00~0~0.00~~~~~~0.0000~0.0000~0~ ~ZS~-8.34~-0.28~~~~4258.86~3574.27~-2.61~-5.02~-4.51~4862145801398~~54.26~-11.65~4862145801398~~~-8.51~-0.00~~CNY~0~~0.00~0~";'
const HK_INDEX = 'v_hkHSI="100~恒生指数~HSI~23393.320~23393.320~0.000~100760.0643~0~0~0.000~0~0~0~0~0~0~0~0~0~0.000~0~0~0~0~0~0~0~0~0~0.0~2026/11/03 09:05:30~0.000~0.00~0~0~0.000~100760.0643~100760.064~0~0~~0~0~0.00~0~0~Hang Seng Index~0~28056.100~22518.000~2.18~-10.15~0~0~0~0~0~0.00~0.00~0.00~0~-8.73~1.53~ZS~~~-1.99~-2.69~-8.86~0.00~0.00~0.00~0.000~~-11.92~HKD~1~";'
const US_SHARE = 'v_usAAPL="200~苹果~AAPL.OQ~338.32~344.63~342.67~64757691~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-11-02 16:00:02~-6.31~-1.83~343.80~335.82~USD~64757691~21906619259~0.44~38.80~~45.35~~2.32~49344.34036~49375.02978~Apple Inc.~8.72~351.73~242.76~0~45.92~0.31~49375.02978~24.78~-1.63~GP~148.75~36.08~-1.35~1.63~8.07~14594180000~14585108878~1.41~36.88~1.06~338.29~~~~~";'

test('parseTencentQuotes reads one payload for all three markets', () => {
  const quotes = parseTencentQuotes(`${A_SHARE}${HK_INDEX}${US_SHARE}`)
  assert.equal(quotes.size, 3)

  const a = quotes.get('sh000001')
  assert.equal(a.market, 'a')
  assert.equal(a.name, '上证指数')
  assert.equal(a.price, 3638.03)
  assert.equal(a.previousClose, 3638.03)
  assert.equal(a.pct, 0)

  const hk = quotes.get('hkHSI')
  assert.equal(hk.market, 'hk')
  assert.equal(hk.price, 23393.32)
  // The Hong Kong payload leaves the day range empty; amplitude must stay null
  // so the scorer drops the factor instead of scoring a fake calm day.
  assert.equal(hk.amplitudePct, null)

  const us = quotes.get('usAAPL')
  assert.equal(us.market, 'us')
  assert.equal(us.price, 338.32)
  assert.equal(us.previousClose, 344.63)
  assert.ok(Math.abs(us.pct - -1.83) < 0.005)
  assert.equal(us.high, 343.8)
  assert.equal(us.low, 335.82)
  assert.ok(Math.abs(us.amplitudePct - 2.3155) < 0.01)
})

test('parseTencentQuotes drops entries without a tradable price', () => {
  assert.equal(parseTencentQuotes('v_sh000001="1~上证指数~000001~0.00~3638.03~0.00";').size, 0)
  assert.equal(parseTencentQuotes('').size, 0)
  assert.equal(parseTencentQuotes('v_hkHSI="";').size, 0)
})

test('normalizeCode understands prefixed and bare codes', () => {
  assert.equal(normalizeCode('sh600519'), 'sh600519')
  assert.equal(normalizeCode('600519'), 'sh600519')
  assert.equal(normalizeCode('000001'), 'sz000001')
  assert.equal(normalizeCode('300750'), 'sz300750')
  assert.equal(normalizeCode('00700'), 'hk00700')
  assert.equal(normalizeCode('AAPL'), 'usAAPL')
  assert.equal(normalizeCode('usNVDA'), 'usNVDA')
  assert.equal(normalizeCode(''), null)
  assert.equal(normalizeCode('not a code'), null)
})

test('marketOf rejects unknown prefixes', () => {
  assert.equal(marketOf('sh000001'), 'a')
  assert.equal(marketOf('hkHSI'), 'hk')
  assert.equal(marketOf('usDJI'), 'us')
  assert.equal(marketOf('jpN225'), null)
})

test('parseKline and averageVolume use the completed bars only', () => {
  const payload = {
    data: {
      sh000001: {
        day: [
          ['2026-10-30', '1', '2', '3', '0.5', '100'],
          ['2026-10-31', '1', '2', '3', '0.5', '300'],
          ['2026-11-02', '1', '2', '3', '0.5', '900'],
        ],
      },
    },
  }
  const bars = parseKline(payload, 'sh000001')
  assert.equal(bars.length, 3)
  assert.equal(bars[2].volume, 900)
  // 20 completed bars requested, but only 2 exist before the current one.
  assert.equal(averageVolume(bars, 20), 200)
  assert.equal(averageVolume([], 20), null)
})

test('parseBreadth reads the market-wide histogram', () => {
  // Real payload shape from getTopicZDFenBu: one bucket per percent move.
  const payload = {
    data: {
      qdate: 20261103,
      fenbu: [
        { '-10': 1 }, { '-2': 1176 }, { '-1': 1646 }, { '0': 268 },
        { '1': 877 }, { '10': 7 }, { '11': 18 },
      ],
    },
  }
  const breadth = parseBreadth(payload)
  assert.equal(breadth.up, 902)
  assert.equal(breadth.down, 2823)
  assert.equal(breadth.flat, 268)
  assert.equal(breadth.ratio, 902 / (902 + 2823))
  assert.equal(parseBreadth({ data: { fenbu: [] } }), null)
})

test('parseBreadth still understands the paged snapshot fallback', () => {
  const payload = { data: { total: 4, diff: [{ f3: 1.2 }, { f3: -0.4 }, { f3: 0 }, { f3: 3.1 }] } }
  const breadth = parseBreadth(payload)
  assert.equal(breadth.up, 2)
  assert.equal(breadth.down, 1)
  assert.equal(breadth.flat, 1)
  assert.equal(breadth.ratio, 2 / 3)
  assert.equal(parseBreadth({ data: { diff: [] } }), null)
})

test('sessionState follows each venue clock', () => {
  // 10:00 in Shanghai.
  assert.equal(sessionState('a', new Date('2026-11-03T02:00:00Z')).trading, true)
  // 12:00 in Shanghai is the lunch break.
  assert.equal(sessionState('a', new Date('2026-11-03T04:00:00Z')).phase, 'lunch')
  // 08:00 in Shanghai, before the opening auction resolves.
  assert.equal(sessionState('a', new Date('2026-11-03T00:00:00Z')).phase, 'pre')
  // 16:30 in Shanghai, after the close.
  assert.equal(sessionState('a', new Date('2026-11-03T08:30:00Z')).phase, 'post')
  // Saturday.
  assert.equal(sessionState('a', new Date('2026-11-07T02:00:00Z')).phase, 'closed')

  // 10:00 in Hong Kong.
  assert.equal(sessionState('hk', new Date('2026-11-03T02:00:00Z')).trading, true)
  // 12:30 in Hong Kong is the lunch break.
  assert.equal(sessionState('hk', new Date('2026-11-03T04:30:00Z')).phase, 'lunch')

  // 10:00 EST (winter) and 10:00 EDT (summer) must both be open.
  assert.equal(sessionState('us', new Date('2026-11-03T15:00:00Z')).trading, true)
  assert.equal(sessionState('us', new Date('2026-06-01T14:00:00Z')).trading, true)
  // 17:00 EST is after the bell.
  assert.equal(sessionState('us', new Date('2026-11-03T22:00:00Z')).phase, 'post')
})

test('sessionProgress turns a morning volume into a full-day comparison', () => {
  // 10:00 Shanghai is 30 of the 240 traded minutes.
  const early = sessionProgress('a', new Date('2026-11-03T02:00:00Z'))
  assert.ok(Math.abs(early - 30 / 240) < 0.001)
  // 14:00 Shanghai: 120 + 60 = 180 of 240.
  const late = sessionProgress('a', new Date('2026-11-03T06:00:00Z'))
  assert.ok(Math.abs(late - 180 / 240) < 0.001)
  // After the close the whole day counts.
  assert.equal(sessionProgress('a', new Date('2026-11-03T09:00:00Z')), 1)
  // Weekends are closed.
  assert.equal(sessionProgress('a', new Date('2026-11-07T02:00:00Z')), 0)
})
