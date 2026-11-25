import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFundFlow, FUNDFLOW_ETFS, fetchFundFlow } from '../src/fundflow/source.js'

const rows = (code) => {
  const values = {
    '510300.SH': [5558718.77, 5518500.0],
    '510050.SH': [2437896.68, 2413400.0],
    '159915.SZ': [5391545.4936, 5317400.0],
    '588000.SH': [10517066.82, 10362900.0],
    '510500.SH': [1251016.86, 1213000.0],
  }[code]
  return [
    { ts_code: code, trade_date: '20261123', fd_share: values[0] },
    { ts_code: code, trade_date: '20261122', fd_share: values[1] },
  ]
}

test('fund_share is converted to 亿份 and the total matches the document', () => {
  const map = new Map(FUNDFLOW_ETFS.map((etf) => [etf.code, rows(etf.code)]))
  const series = buildFundFlow(map, { now: new Date('2026-11-25T00:00:00+08:00').getTime(), days: 90 })
  assert.deepEqual(series.latestDate, '2026-11-23')
  assert.equal(series.latest['510300.SH'].value, 555.8719)
  assert.equal(series.latestTotal.value, 2515.6245)
  assert.equal(series.dates.length, 2)
  assert.equal(series.normalized['510300.SH'].find((point) => point.date === '2026-11-23').value, 100.73)
  assert.equal(series.total.at(-1).coverage, 5)
})

test('fetchFundFlow requests fund_share for each ETF and never exposes the token', async () => {
  const requests = []
  const series = await fetchFundFlow({
    token: 'token-1',
    now: () => new Date('2026-11-25T00:00:00+08:00').getTime(),
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      const code = JSON.parse(init.body).params.ts_code
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: { fields: ['ts_code', 'trade_date', 'fd_share'], items: [[code, '20261123', 1000000]] },
        }),
      }
    },
  })
  assert.equal(requests.length, 5)
  assert.equal(requests[0].url, 'https://api.tushare.pro')
  assert.equal(requests[0].body.api_name, 'fund_share')
  assert.equal(requests[0].body.token, 'token-1')
  assert.equal(series.latestTotal.value, 500)
  assert.equal(JSON.stringify(series).includes('token-1'), false)
})
