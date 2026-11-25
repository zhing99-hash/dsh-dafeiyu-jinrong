import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createFundflowService } from '../src/fundflow/service.js'
import { FUNDFLOW_ETFS } from '../src/fundflow/source.js'

function tushareResponse(code) {
  return {
    ok: true,
    json: async () => ({
      code: 0,
      data: { fields: ['ts_code', 'trade_date', 'fd_share'], items: [[code, '20261123', 1000000]] },
    }),
  }
}

test('fundflow service refreshes once, persists the snapshot, and keeps the old cache on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-fundflow-'))
  const cachePath = join(dir, 'fundflow.json')
  let calls = 0
  const service = createFundflowService({
    cachePath,
    getConfig: () => ({ marketTushareToken: 'token' }),
    fetchImpl: async (url, init) => {
      calls += 1
      return tushareResponse(JSON.parse(init.body).params.ts_code)
    },
    now: () => new Date('2026-11-25T00:00:00+08:00').getTime(),
  })
  const first = await service.refresh()
  assert.equal(first.latestDate, '2026-11-23')
  assert.equal(first.latestTotal.value, 500)
  assert.equal(calls, 5)
  const stored = JSON.parse(await readFile(cachePath, 'utf8'))
  assert.equal(stored.latestTotal.value, 500)
  await service.refresh()
  assert.equal(calls, 10)
  const snapshot = service.get()
  assert.equal(snapshot.error, '')
  assert.equal(snapshot.etfs.length, FUNDFLOW_ETFS.length)

  // A failing refresh must keep the previous chart and only attach the error.
  const failing = createFundflowService({
    cachePath,
    getConfig: () => ({ marketTushareToken: 'token' }),
    fetchImpl: async () => { throw new Error('network down') },
  })
  const result = await failing.refresh()
  assert.equal(result.latestDate, '2026-11-23')
  assert.match(result.error, /network down/)
  await rm(dir, { recursive: true, force: true })
})
