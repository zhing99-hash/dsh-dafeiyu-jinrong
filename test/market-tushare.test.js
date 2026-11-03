import test from 'node:test'
import assert from 'node:assert/strict'

import { createTushareClient, parseTushareResponse, toTsCode } from '../src/market/tushare.js'

test('toTsCode maps A-share codes and rejects everything else', () => {
  assert.equal(toTsCode('sh600519'), '600519.SH')
  assert.equal(toTsCode('sz000001'), '000001.SZ')
  assert.equal(toTsCode('bj430047'), '430047.BJ')
  assert.equal(toTsCode('hk00700'), null)
  assert.equal(toTsCode('usAAPL'), null)
  assert.equal(toTsCode(''), null)
})

test('parseTushareResponse zips fields and items', () => {
  const rows = parseTushareResponse({
    code: 0,
    data: {
      fields: ['trade_date', 'close', 'vol'],
      items: [['20261103', 1705.2, 1234.5], ['20261102', 1690, 2000]],
    },
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].trade_date, '20261103')
  assert.equal(rows[0].vol, 1234.5)
})

test('parseTushareResponse surfaces the API error message', () => {
  assert.throws(() => parseTushareResponse({ code: -2001, msg: 'token invalid' }), /token invalid/)
  assert.throws(() => parseTushareResponse(null), /empty response/)
})

test('a missing token disables the client entirely', () => {
  assert.equal(createTushareClient({ token: '' }), null)
  assert.equal(createTushareClient({ token: '   ' }), null)
})

function clientWith(rows, capture = {}) {
  const fetchImpl = async (url, init) => {
    capture.url = url
    capture.body = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { fields: ['trade_date', 'close', 'vol'], items: rows } }),
    }
  }
  return createTushareClient({ token: 'tok', fetchImpl, logger: { warn() {} }, now: () => Date.parse('2026-11-03T02:00:00Z') })
}

test('the request carries the api name, token and a date window', async () => {
  const capture = {}
  const client = clientWith([], capture)
  await client.daily('600519.SH')
  assert.equal(capture.url, 'https://api.tushare.pro')
  assert.equal(capture.body.api_name, 'daily')
  assert.equal(capture.body.token, 'tok')
  assert.equal(capture.body.params.ts_code, '600519.SH')
  assert.match(capture.body.params.start_date, /^\d{8}$/)
  assert.match(capture.body.params.end_date, /^\d{8}$/)
})

test('averageVolume skips the newest bar and averages the rest', async () => {
  // Newest first, as Tushare returns it. The last row is today's partial tape
  // and must not drag the average down.
  const client = clientWith([
    ['20261103', 1700, 10],
    ['20261102', 1690, 100],
    ['20261101', 1680, 200],
    ['20261031', 1670, 300],
  ])
  const average = await client.averageVolume('600519.SH', 20)
  assert.equal(average, 200)
})

test('averageVolume returns null when the API fails', async () => {
  const client = createTushareClient({
    token: 'tok',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    logger: { warn() {} },
  })
  assert.equal(await client.averageVolume('600519.SH'), null)
})

test('daily responses are cached for the cache window', async () => {
  let calls = 0
  const client = createTushareClient({
    token: 'tok',
    now: () => Date.parse('2026-11-03T02:00:00Z'),
    logger: { warn() {} },
    fetchImpl: async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { fields: ['trade_date', 'vol'], items: [['20261103', 10], ['20261102', 100]] } }),
      }
    },
  })
  await client.averageVolume('600519.SH')
  await client.averageVolume('600519.SH')
  assert.equal(calls, 1)
})
