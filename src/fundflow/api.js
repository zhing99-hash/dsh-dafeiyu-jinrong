// Local-only HTTP endpoints for the fund monitor card.

import { isLocalRequest, jsonResponse } from '../local-http.js'

function guard(req, res) {
  if (!isLocalRequest(req)) {
    jsonResponse(res, 403, { error: 'local access only' })
    return false
  }
  return true
}

export function createFundflowHandlers(service) {
  return {
    async series(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'method not allowed' })
      jsonResponse(res, 200, service.get())
    },
    async refresh(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method not allowed' })
      const snapshot = await service.refresh()
      // A refresh failure keeps the old series; the client shows the error but
      // still has a valid chart to render.
      jsonResponse(res, 200, snapshot)
    },
  }
}
