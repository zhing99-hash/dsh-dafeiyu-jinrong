import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createConfigHandler } from '../src/index.js'

function settingsFixture() {
  let value = { enabled: true, scale: 1, bubbleScale: 1, activityLevel: 'normal', reducedMotion: false, soundEnabled: true, includeSubagents: false }
  return {
    get: () => ({ ...value }),
    update: async (patch) => { value = { ...value, ...patch } },
  }
}

async function request(handler, { method = 'GET', body = '', address = '127.0.0.1', origin } = {}) {
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
  await handler(req, res)
  return { status, body: JSON.parse(payload) }
}

test('local config endpoint reads and persists an allowed patch', async () => {
  const settings = settingsFixture()
  const handler = createConfigHandler(settings)
  const initial = await request(handler)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.enabled, true)

  const changed = await request(handler, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false, scale: 0.8, bubbleScale: 0.8, soundEnabled: false }),
    origin: 'http://127.0.0.1:2026',
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.enabled, false)
  assert.equal(changed.body.scale, 0.8)
  assert.equal(changed.body.bubbleScale, 0.8)
  assert.equal(changed.body.soundEnabled, false)
})

test('config endpoint persists per-event sound choices and drops unknown states', async () => {
  const handler = createConfigHandler(settingsFixture())
  const changed = await request(handler, {
    method: 'PATCH',
    body: JSON.stringify({ soundStates: ['ERROR', 'WAITING'] }),
    origin: 'http://127.0.0.1:2026',
  })
  assert.equal(changed.status, 200)
  assert.deepEqual(changed.body.soundStates, ['ERROR'])
  const invalid = await request(handler, { method: 'PATCH', body: '{"soundStates":"ERROR"}', origin: 'http://127.0.0.1:2026' })
  assert.equal(invalid.status, 400)
})

test('sound states default to every event and drop unknown entries', async () => {
  const { normalizeSoundStates } = await import('../src/plugin.js')
  assert.deepEqual(normalizeSoundStates(undefined), ['SUCCESS', 'ERROR'])
  assert.deepEqual(normalizeSoundStates(['APPROVAL']), ['APPROVAL'])
  assert.deepEqual(normalizeSoundStates([]), [])
  assert.deepEqual(normalizeSoundStates(['ERROR', 'ERROR', 'IDLE']), ['ERROR'])
})

test('local config endpoint rejects remote, cross-origin, and unknown writes', async () => {
  const handler = createConfigHandler(settingsFixture())
  assert.equal((await request(handler, { address: '192.168.1.8' })).status, 403)
  assert.equal((await request(handler, { origin: 'https://example.com' })).status, 403)
  assert.equal((await request(handler, { method: 'PATCH', body: '{"surprise":true}' })).status, 400)
})

test('settings client debounces each slider independently', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /sliderTimers = useRef\(new Map\(\)\)/u)
  assert.match(source, /sliderTimers\.current\.get\(field\)/u)
  assert.match(source, /sliderTimers\.current\.set\(field, timer\)/u)
  assert.match(source, /CompanionSettings/u)
  assert.match(source, /'settings', '设置'/u)
})

test('the 养鱼 settings survive the local config endpoint', async () => {
  const settings = settingsFixture()
  const handler = createConfigHandler(settings)
  const patch = {
    marketEnabled: true,
    marketFocus: 'hk',
    marketWatchlist: [
      { code: 'sh600519', alias: '茅台', above: 1700, below: 1500 },
      { code: '00700', alias: '腾讯', above: 0, below: 400 },
    ],
    marketPollSeconds: 10,
    marketAlertCooldown: 120,
    marketTushareToken: 'tok-123',
  }
  const changed = await request(handler, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    origin: 'http://127.0.0.1:2026',
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.marketEnabled, true)
  assert.equal(changed.body.marketFocus, 'hk')
  assert.equal(changed.body.marketWatchlist.length, 2)
  assert.equal(changed.body.marketWatchlist[0].above, 1700)
  assert.equal(changed.body.marketTushareToken, 'tok-123')

  // A key the schema does not know must still be rejected, otherwise a typo in
  // the watchlist editor would silently create a dead setting.
  const unknown = await request(handler, {
    method: 'PATCH',
    body: '{"marketNope":true}',
    origin: 'http://127.0.0.1:2026',
  })
  assert.equal(unknown.status, 400)
})

test('the settings page keeps the 养鱼 block and its writable fields', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /'养鱼'/u)
  assert.match(source, /自选股与价格提醒/u)
  assert.match(source, /'Tushare Token'/u)
  assert.match(source, /write\('marketWatchlist'/u)
  assert.match(source, /write\('marketTushareToken'/u)
  assert.match(source, /writeSlider\('marketAlertCooldown'/u)
  // The token input must not be a plain text box.
  assert.match(source, /type: 'password'/u)
})
