// Local HTTP surface for the optional DSA analysis panel.
//
// The desktop pet's Studio calls these endpoints. DSA itself is remote/local
// FastAPI; this layer enforces DSH's local request fence and turns failures
// into stable JSON errors instead of leaking upstream bodies.

import { isLocalRequest, jsonResponse } from '../local-http.js'

const MAX_BODY = 64 * 1024

function guard(req, res) {
  if (!isLocalRequest(req)) {
    jsonResponse(res, 403, { error: 'local access only' })
    return false
  }
  return true
}

async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
  return value
}

function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function fail(res, error) {
  const status = Number(error?.status)
  jsonResponse(res, status >= 400 && status < 600 ? status : 502, {
    error: error?.message ?? String(error),
    status: Number.isFinite(status) ? status : 0,
  })
}

export function createAnalysisHandlers(service, { logger = console } = {}) {
  void logger
  return {
    async status(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'method not allowed' })
      try { jsonResponse(res, 200, await service.status()) } catch (error) { fail(res, error) }
    },
    async stocks(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'method not allowed' })
      try {
        const payload = await service.stocks()
        jsonResponse(res, 200, { ...payload, nextRunAt: service.nextRunAt() })
      } catch (error) { fail(res, error) }
    },
    async tasks(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'method not allowed' })
      try { jsonResponse(res, 200, { tasks: await service.tasks() }) } catch (error) { fail(res, error) }
    },
    async history(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'method not allowed' })
      try {
        const query = queryOf(req)
        const payload = await service.history({
          page: Number(query.get('page') ?? 0) || 0,
          pageSize: Number(query.get('pageSize') ?? 20) || 20,
          stockCode: query.get('stockCode') ?? '',
          startDate: query.get('startDate') ?? '',
        })
        jsonResponse(res, 200, payload)
      } catch (error) { fail(res, error) }
    },
    async report(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'method not allowed' })
      const id = queryOf(req).get('id')
      if (!id) return jsonResponse(res, 400, { error: 'missing report id' })
      try { jsonResponse(res, 200, await service.report(id)) } catch (error) { fail(res, error) }
    },
    async analyze(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' })
      try {
        const body = await readJson(req)
        const codes = Array.isArray(body.codes)
          ? body.codes.map((code) => String(code))
          : body.codes ? [String(body.codes)] : undefined
        jsonResponse(res, 200, await service.analyze(codes, {
          reportType: body.reportType,
          forceRefresh: body.forceRefresh === true,
          skills: Array.isArray(body.skills) ? body.skills : [],
        }))
      } catch (error) { fail(res, error) }
    },
    async marketReview(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' })
      try { jsonResponse(res, 200, await service.marketReview()) } catch (error) { fail(res, error) }
    },
    async chat(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' })
      try {
        const body = await readJson(req)
        const message = String(body.message ?? '').trim()
        if (!message) return jsonResponse(res, 400, { error: 'message is required' })
        jsonResponse(res, 200, await service.chat(message, String(body.sessionId ?? '')))
      } catch (error) { fail(res, error) }
    },
    async docker(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' })
      try {
        const body = await readJson(req)
        const action = String(body.action ?? 'status')
        if (!['status', 'start', 'stop', 'restart'].includes(action)) {
          return jsonResponse(res, 400, { error: 'unsupported docker action' })
        }
        const result = await service.docker(action)
        jsonResponse(res, 200, result)
      } catch (error) { fail(res, error) }
    },
    async syncWatchlist(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' })
      try { jsonResponse(res, 200, await service.syncWatchlist()) } catch (error) { fail(res, error) }
    },
    async startDsa(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' })
      try { jsonResponse(res, 200, await service.startDsa()) } catch (error) { fail(res, error) }
    },
    async stopDsa(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' })
      try { jsonResponse(res, 200, await service.stopDsa()) } catch (error) { fail(res, error) }
    },
  }
}
