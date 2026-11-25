import assert from 'node:assert/strict'
import test from 'node:test'

import { createAnalysisService } from '../src/analysis/service.js'

function response(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) }
}

function harness(overrides = {}) {
  const config = {
    analysisEnabled: true,
    analysisBaseUrl: 'http://127.0.0.1:8000',
    analysisSchedule: '18:00',
    analysisReportType: 'detailed',
    analysisPetSummary: true,
    marketWatchlist: [{ code: 'sh600519', alias: '茅台' }, { code: 'hk00700', alias: '腾讯' }],
    ...overrides,
  }
  const sent = []
  const requests = []
  const service = createAnalysisService({
    getConfig: () => config,
    sendMessage: (message) => sent.push(message),
    logger: { warn() {}, info() {} },
    now: overrides.now,
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      if (url.includes('/api/health')) return response({ status: 'ok' })
      if (url.includes('/history/stocks')) {
        return response({
          items: [
            { id: 9, report_id: 9, stock_code: '600519', stock_name: '贵州茅台', sentiment_score: 65, operation_advice: '观望', action: 'watch', action_label: '观望', last_analysis_time: '2026-11-25T10:00:00' },
            { id: 10, report_id: 10, stock_code: 'hk00700', stock_name: '腾讯控股', sentiment_score: 78, operation_advice: '买入', action: 'buy', action_label: '买入', last_analysis_time: '2026-11-25T10:00:00' },
          ],
        })
      }
      if (url.includes('/analysis/analyze')) return response({ task_id: 'task-schedule' }, 202)
      if (url.includes('/analysis/tasks')) return response({ tasks: [] })
      return response({ error: 'unexpected' }, 404)
    },
  })
  return { service, config, sent, requests }
}

test('analysis status reports a connected DSA and the watchlist is merged', async () => {
  const { service } = harness()
  const status = await service.status()
  assert.equal(status.connected, true)
  assert.equal(status.enabled, true)
  assert.equal(status.baseUrl, 'http://127.0.0.1:8000')

  const stocks = await service.stocks()
  assert.equal(stocks.connected, true)
  assert.equal(stocks.items.length, 2)
  assert.equal(stocks.items[0].name, '茅台')
  assert.equal(stocks.items[0].actionLabel, '观望')
  assert.equal(stocks.items[0].inWatchlist, true)
  assert.equal(stocks.items[1].name, '腾讯')
  assert.equal(stocks.items[1].actionLabel, '买入')
  service.stop()
})

test('a disabled analysis service returns watchlist placeholders without fetching', async () => {
  const { service } = harness({ analysisEnabled: false })
  let calls = 0
  const stocks = await service.stocks()
  assert.equal(stocks.connected, false)
  assert.equal(stocks.items.length, 2)
  assert.equal(stocks.items[0].actionLabel, '未分析')
  assert.equal(calls, 0)
  service.stop()
})

test('the next run follows the configured weekday schedule', () => {
  const { service } = harness()
  const next = service.nextRunAt()
  assert.ok(next)
  assert.equal(new Date(next).getHours(), 18)
  assert.equal(new Date(next).getMinutes(), 0)
  service.stop()
})

test('the weekday schedule triggers a batch with notify disabled', async () => {
  const { service, requests } = harness({
    now: () => new Date(2026, 10, 25, 18, 0, 0).getTime(),
    analysisSchedule: '18:00',
  })
  await service.checkSchedule()
  const analyze = requests.find((request) => request.url.includes('/analysis/analyze'))
  assert.ok(analyze, 'expected the scheduled analysis request')
  const body = JSON.parse(analyze.init.body)
  assert.equal(body.notify, false)
  assert.equal(body.async_mode, true)
  assert.deepEqual(body.stock_codes, ['600519', 'hk00700'])
  service.stop()
})
