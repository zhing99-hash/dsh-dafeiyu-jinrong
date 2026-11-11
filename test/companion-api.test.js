import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createActionsStore } from '../src/actions/store.js'
import { createBubbleStore } from '../src/bubble/store.js'
import { createCompanionApi } from '../src/companion-api.js'
import { createMemeLibrary } from '../src/memes.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')

test('the studio API round-trips bubble, actions, preview and memes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-api-'))
  const bubbleStore = createBubbleStore({ root, logger: console })
  const actionsStore = createActionsStore({ root, logger: console })
  const memes = createMemeLibrary({ root, logger: console })
  const sent = []
  const api = createCompanionApi({
    bubbleStore,
    actionsStore,
    memes,
    getBridge: () => ({ send: (message) => sent.push(message) }),
    getCatalog: () => ({ clips: ['idle', 'head_pat'], labels: {}, menu: [] }),
    getMemeService: () => undefined,
    requestPreview: async () => ({ rev: 42 }),
    sendConfig: () => {},
    logger: console,
  })
  const routes = {
    '/bubble': api.bubble, '/preview': api.preview, '/actions': api.actions,
    '/actions/play': api.actionsPlay, '/memes': api.memeList,
    '/memes/image': api.memeImage, '/memes/pick': api.memePick,
  }
  const server = http.createServer((req, res) => {
    const handler = routes[new URL(req.url, 'http://127.0.0.1').pathname]
    if (!handler) {
      res.writeHead(404).end()
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => res.writeHead(500).end(String(error)))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const json = async (path, options) => {
    const response = await fetch(base + path, options)
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  try {
    const bubble = await json('/bubble')
    assert.equal(bubble.status, 200)
    assert.equal(bubble.body.spec.version, 1)
    assert.ok(Object.keys(bubble.body.presets).length >= 4)

    const saved = await json('/bubble', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { ...bubble.body.spec, theme: { ...bubble.body.spec.theme, width: 430 } } }),
    })
    assert.equal(saved.body.spec.theme.width, 430)

    const preview = await json('/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: 'status' }),
    })
    assert.deepEqual(preview.body, { ok: true, rev: 42 })

    const actions = await json('/actions')
    assert.equal(actions.body.actions.categories.length >= 2, true)
    const played = await json('/actions/play', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clip: 'idle' }),
    })
    assert.equal(played.status, 200)
    assert.equal(sent.at(-1).kind, 'action')

    const uploaded = await json('/memes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: PNG.toString('base64'), tag: 'happy', caption: '测试' }),
    })
    assert.equal(uploaded.status, 201)
    const id = uploaded.body.item.id
    const list = await json('/memes')
    assert.equal(list.body.items.length, 1)
    const image = await fetch(`${base}/memes/image?id=${id}`)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    const picked = await json('/memes/pick', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag: 'happy' }),
    })
    assert.equal(picked.body.meme.source, 'local')
  } finally {
    server.close()
  }
})
