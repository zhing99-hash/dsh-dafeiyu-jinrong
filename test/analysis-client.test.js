import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDsaClient, normalizeBaseUrl, normalizeStock, normalizeTask, toDsaCode,
} from '../src/analysis/client.js'

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

test('DSA codes and base URLs normalize without losing market prefixes', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
  assert.equal(normalizeBaseUrl(''), 'http://127.0.0.1:8000')
  assert.equal(toDsaCode('sh600519'), '600519')
  assert.equal(toDsaCode('hk00700'), 'hk00700')
  assert.equal(toDsaCode('usAAPL'), 'AAPL')
  assert.equal(normalizeStock({ stock_code: '600519', stock_name: '贵州茅台', sentiment_score: 65, operation_advice: '观望', action: 'watch' }).actionLabel, '观望')
  assert.equal(normalizeTask({ task_id: 't1', status: 'running', progress: 30 }).id, 't1')
})

test('the DSA client reads history and keeps analysis requests local-only', async () => {
  const requests = []
  const client = createDsaClient({
    getConfig: () => ({ analysisBaseUrl: 'http://127.0.0.1:8000' }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      if (url.includes('/history/stocks')) {
        return response({ items: [{ id: 7, report_id: 7, stock_code: '600519', stock_name: '贵州茅台', sentiment_score: 65, operation_advice: '观望', action: 'watch', action_label: '观望', last_analysis_time: '2026-11-25T10:00:00' }] })
      }
      if (url.includes('/history?')) return response({ items: [], total: 0 })
      if (url.includes('/analysis/analyze')) return response({ task_id: 'task-1' }, { status: 202 })
      if (url.includes('/analysis/tasks')) return response({ tasks: [{ task_id: 'task-1', stock_code: '600519', status: 'running', progress: 20 }] })
      if (url.includes('/api/health')) return response({ status: 'ok' })
      return response({ ok: false, error: 'unexpected' }, { ok: false, status: 404 })
    },
  })

  const stocks = await client.stocks()
  assert.equal(stocks[0].name, '贵州茅台')
  assert.equal(stocks[0].actionLabel, '观望')
  assert.equal(stocks[0].reportId, 7)

  const history = await client.history({ page: 1, pageSize: 10 })
  assert.deepEqual(history, { items: [], total: 0 })
  const historyUrl = requests.find((row) => row.url.includes('/history?')).url
  assert.match(historyUrl, /page=2/)
  assert.match(historyUrl, /limit=10/)

  const result = await client.analyze(['sh600519', '600519'])
  assert.deepEqual(result.taskIds, ['task-1'])
  const analyzeRequest = requests.find((row) => row.url.includes('/analysis/analyze'))
  const body = JSON.parse(analyzeRequest.init.body)
  assert.deepEqual(body.stock_codes, ['600519'])
  assert.equal(body.async_mode, true)
  assert.equal(body.notify, false)

  const tasks = await client.tasks()
  assert.equal(tasks[0].status, 'running')
  assert.equal(tasks[0].progress, 20)
})

test('DSA API errors surface status and message', async () => {
  const client = createDsaClient({
    getConfig: () => ({ analysisBaseUrl: 'http://127.0.0.1:8000' }),
    fetchImpl: async () => response({ detail: { message: '认证失败' } }, { ok: false, status: 401 }),
  })
  await assert.rejects(() => client.health(), (error) => {
    assert.equal(error.status, 401)
    assert.match(error.message, /认证失败/)
    return true
  })
})
