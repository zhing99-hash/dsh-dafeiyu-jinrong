// Tushare (https://tushare.pro) client for the data the free quote feed cannot
// give us: historical daily bars, and therefore a real volume ratio.
//
// Tushare is a token API over HTTP, so there is no Python dependency here — the
// Node side posts JSON to api.tushare.pro. Only A-share codes are mapped: the
// Hong Kong and US endpoints sit behind a different (and much higher) points
// tier, and the Tencent feed already returns names and prices for them.
//
// Everything is injected (fetch, clock) so the request shape and the caching
// can be tested without a token.

export const TUSHARE_URL = 'https://api.tushare.pro'

/** `sh600519` -> `600519.SH`; null for anything that is not an A-share code. */
export function toTsCode(code) {
  const match = /^(sh|sz|bj)(\d{6})$/i.exec(String(code ?? '').trim())
  if (!match) return null
  return `${match[2]}.${match[1].toUpperCase()}`
}

/** Tushare returns `{ fields: [...], items: [[...]] }`; zip it into objects. */
export function parseTushareResponse(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('tushare: empty response')
  if (payload.code !== 0) throw new Error(`tushare: ${payload.msg || `error code ${payload.code}`}`)
  const fields = Array.isArray(payload.data?.fields) ? payload.data.fields : []
  const items = Array.isArray(payload.data?.items) ? payload.data.items : []
  return items.map((item) => {
    const row = {}
    fields.forEach((field, index) => { row[field] = item[index] })
    return row
  })
}

function ymd(date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * @param {object} options
 * @param {string} options.token Tushare API token; without one the client is null
 */
export function createTushareClient({
  token,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => Date.now(),
  cacheMs = 60 * 60 * 1000,
} = {}) {
  const key = String(token ?? '').trim()
  if (!key) return null
  const cache = new Map()

  async function call(apiName, params, fields) {
    const response = await fetchImpl(TUSHARE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_name: apiName, token: key, params, fields }),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(10000) : undefined,
    })
    if (!response?.ok) throw new Error(`tushare: HTTP ${response?.status ?? 'unknown'}`)
    return parseTushareResponse(await response.json())
  }

  async function daily(tsCode) {
    const cached = cache.get(tsCode)
    const at = now()
    if (cached && at - cached.at < cacheMs) return cached.rows
    const end = new Date(at)
    const start = new Date(at - 45 * 24 * 60 * 60 * 1000)
    const rows = await call(
      'daily',
      { ts_code: tsCode, start_date: ymd(start), end_date: ymd(end) },
      'trade_date,close,vol',
    )
    // Tushare returns newest first; sort ascending so "last N" means recent.
    rows.sort((left, right) => String(left.trade_date).localeCompare(String(right.trade_date)))
    cache.set(tsCode, { at, rows })
    return rows
  }

  return {
    get token() {
      return key
    },
    async daily(tsCode) {
      return daily(tsCode)
    },
    /**
     * Mean volume of the most recent completed sessions, excluding the latest
     * bar (which is today's partial tape once the market is open).
     * Returns null when the token lacks permission or the code has no history.
     */
    async averageVolume(tsCode, sessions = 20) {
      try {
        const rows = await daily(tsCode)
        const completed = rows.slice(0, -1).slice(-sessions)
          .map((row) => Number(row.vol))
          .filter((value) => Number.isFinite(value) && value > 0)
        if (completed.length === 0) return null
        return completed.reduce((total, value) => total + value, 0) / completed.length
      } catch (error) {
        logger.warn?.(`tushare: ${tsCode} unavailable: ${error?.message ?? error}`)
        return null
      }
    },
  }
}
