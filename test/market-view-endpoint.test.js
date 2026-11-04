import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createMarketViewHandler } from '../src/index.js'

function request(handler, { method = 'GET', body = '', address = '127.0.0.1', origin } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [])
  req.method = method
  req.socket = { remoteAddress: address }
  req.headers = { host: '127.0.0.1:2026', ...(origin ? { origin } : {}) }
  let status
  let payload = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk = '') { payload += chunk },
  }
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: payload ? JSON.parse(payload) : null }))
}

function monitorFixture() {
  const views = [
    { kind: 'index', label: '总盘', code: undefined, alias: undefined },
    { kind: 'stock', code: 'sh600519', alias: '茅台' },
  ]
  let index = 0
  return {
    describeView: () => ({
      index,
      view: views[index] ? { kind: views[index].kind, code: views[index].code ?? null, alias: views[index].alias ?? views[index].label ?? null } : null,
      views: views.map((view, position) => ({
        index: position,
        kind: view.kind,
        code: view.code ?? null,
        alias: view.alias ?? view.label ?? null,
      })),
    }),
    selectView: ({ code, index: requested } = {}) => {
      if (code !== undefined) {
        const found = views.findIndex((view) => view.kind === 'stock' && view.code === code.toLowerCase())
        if (found < 0) return views[index]
        index = found
      } else if (Number.isInteger(requested)) {
        index = Math.min(views.length - 1, Math.max(0, requested))
      }
      return views[index]
    },
  }
}

test('market-view GET reports the active view and the ordered list', async () => {
  const monitor = monitorFixture()
  const handler = createMarketViewHandler(() => monitor)
  const result = await request(handler)
  assert.equal(result.status, 200)
  assert.equal(result.body.index, 0)
  assert.equal(result.body.view.kind, 'index')
  assert.deepEqual(result.body.views.map((view) => view.kind), ['index', 'stock'])
})

test('market-view POST selects by code or index', async () => {
  const monitor = monitorFixture()
  const handler = createMarketViewHandler(() => monitor)
  const byCode = await request(handler, { method: 'POST', body: JSON.stringify({ code: 'SH600519' }) })
  assert.equal(byCode.status, 200)
  assert.deepEqual(byCode.body.selected, { kind: 'stock', code: 'sh600519', alias: '茅台' })
  assert.equal(byCode.body.index, 1)

  const byIndex = await request(handler, { method: 'POST', body: JSON.stringify({ index: 0 }) })
  assert.equal(byIndex.status, 200)
  assert.equal(byIndex.body.selected.kind, 'index')

  await request(handler, { method: 'POST', body: JSON.stringify({ code: 'sh600519' }) })
  const unknown = await request(handler, { method: 'POST', body: JSON.stringify({ code: 'sh999999' }) })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.selected.code, 'sh600519')
})

test('market-view rejects malformed navigation and non-local callers', async () => {
  const monitor = monitorFixture()
  const handler = createMarketViewHandler(() => monitor)
  assert.equal((await request(handler, { method: 'POST', body: '{}' })).status, 400)
  assert.equal((await request(handler, { method: 'POST', body: 'not-json' })).status, 400)
  assert.equal((await request(handler, { method: 'PUT' })).status, 405)
  assert.equal((await request(handler, { address: '192.168.1.8' })).status, 403)
  assert.equal((await request(handler, { origin: 'https://example.com' })).status, 403)
})

test('market-view is unavailable while market mode is off', async () => {
  const handler = createMarketViewHandler(() => undefined)
  assert.equal((await request(handler)).status, 503)
})
