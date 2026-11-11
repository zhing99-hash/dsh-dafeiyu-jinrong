// Local HTTP surface for the 大肥鱼工坊 editor and the meme library.
//
// Everything here is local-only and small: specs are JSON, memes are capped at
// 8 MB, and the preview response is a PNG the helper rendered offscreen with
// the exact same BubbleRenderer the desktop pet uses.

import { readFileSync } from 'node:fs'
import { isLocalRequest, jsonResponse } from './local-http.js'
import { normalizeSpec } from './bubble/spec.js'
import { CompanionMessageKind, createMessage } from './protocol.js'

async function readBody(req, limit) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit = 65536) {
  const buffer = await readBody(req, limit)
  if (buffer.length === 0) return {}
  const value = JSON.parse(buffer.toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
  return value
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, { error: 'method not allowed' })
}

function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function serveImage(res, path, mime) {
  let bytes
  try {
    bytes = readFileSync(path)
  } catch {
    jsonResponse(res, 404, { error: 'image not found' })
    return
  }
  res.writeHead(200, {
    'content-type': mime,
    'cache-control': 'no-store',
    'content-length': bytes.length,
  })
  res.end(bytes)
}

export function createCompanionApi({
  bubbleStore,
  actionsStore,
  memes,
  getBridge,
  getCatalog,
  getMemeService,
  requestPreview,
  sendConfig,
  logger = console,
}) {
  const guard = (req, res) => {
    if (!isLocalRequest(req)) {
      jsonResponse(res, 403, { error: 'local access only' })
      return false
    }
    return true
  }

  const bubble = async (req, res) => {
    if (!guard(req, res)) return
    try {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { spec: bubbleStore.get(), presets: bubbleStore.presets(), base: bubbleStore.base() })
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req, 256 * 1024)
        const spec = bubbleStore.save(body.spec ?? body)
        sendConfig()
        jsonResponse(res, 200, { ok: true, spec })
        return
      }
      if (req.method === 'POST') {
        const spec = bubbleStore.reset()
        sendConfig()
        jsonResponse(res, 200, { ok: true, spec })
        return
      }
      methodNotAllowed(res)
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const preview = async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') return methodNotAllowed(res)
    try {
      const body = await readJson(req, 256 * 1024)
      const spec = body.spec ? normalizeSpec(body.spec, bubbleStore.base()) : bubbleStore.get()
      const result = await requestPreview(spec, body.scene, body.data)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (error) {
      jsonResponse(res, 502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const previewImage = (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'GET') return methodNotAllowed(res)
    serveImage(res, bubbleStore.previewPath, 'image/png')
  }

  const actions = async (req, res) => {
    if (!guard(req, res)) return
    try {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { actions: actionsStore.get(), catalog: getCatalog() })
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req, 256 * 1024)
        const next = actionsStore.save(body.actions ?? body)
        sendConfig()
        jsonResponse(res, 200, { ok: true, actions: next })
        return
      }
      if (req.method === 'POST') {
        const next = actionsStore.reset()
        sendConfig()
        jsonResponse(res, 200, { ok: true, actions: next })
        return
      }
      methodNotAllowed(res)
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const actionsPlay = async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') return methodNotAllowed(res)
    try {
      const body = await readJson(req, 4096)
      const clip = String(body.clip ?? '')
      const catalog = getCatalog()
      if (!catalog.clips.includes(clip)) {
        jsonResponse(res, 400, { error: `unknown clip: ${clip || '(empty)'}` })
        return
      }
      const bridge = getBridge()
      if (!bridge) {
        jsonResponse(res, 503, { error: '桌宠尚未连接' })
        return
      }
      bridge.send(createMessage(CompanionMessageKind.ACTION, { clip }))
      jsonResponse(res, 200, { ok: true, clip })
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const memeList = async (req, res) => {
    if (!guard(req, res)) return
    try {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { items: memes.list(), service: Boolean(getMemeService()), local: memes.hasLocal() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJson(req, 12 * 1024 * 1024)
        const item = memes.add({ data: body.data, tag: body.tag, caption: body.caption, name: body.name })
        jsonResponse(res, 201, { ok: true, item })
        return
      }
      if (req.method === 'DELETE') {
        const id = queryOf(req).get('id') ?? ''
        jsonResponse(res, 200, { ok: memes.remove(id) })
        return
      }
      methodNotAllowed(res)
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const memeImage = (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'GET') return methodNotAllowed(res)
    const id = queryOf(req).get('id') ?? ''
    const found = memes.pathFor(id)
    if (!found) {
      jsonResponse(res, 404, { error: 'meme not found' })
      return
    }
    serveImage(res, found.path, found.mime)
  }

  const memePick = async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') return methodNotAllowed(res)
    try {
      const body = await readJson(req, 4096)
      const meme = memes.pick({ tag: body.tag, query: body.query })
      if (!meme) {
        jsonResponse(res, 404, { error: '没有可用的表情包' })
        return
      }
      jsonResponse(res, 200, { ok: true, meme })
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const diagnostics = (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'GET') return methodNotAllowed(res)
    try {
      jsonResponse(res, 200, {
        ok: true,
        bubblePath: bubbleStore.path,
        actionsPath: actionsStore.path,
        memesPath: memes.dir,
        memeService: Boolean(getMemeService()),
        localMemes: memes.list().length,
      })
    } catch (error) {
      logger.warn?.(`dafeiyu: companion diagnostics failed: ${error?.message ?? error}`)
      jsonResponse(res, 500, { error: 'diagnostics failed' })
    }
  }

  return { bubble, preview, previewImage, actions, actionsPlay, memeList, memeImage, memePick, diagnostics }
}
