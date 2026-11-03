// Market data adapters for the A-share / Hong Kong / US sessions.
//
// Everything in this module is pure: the network is injected, the clock is a
// parameter, and no timer lives here. That keeps the parsing rules (which are
// the part that actually breaks when an upstream changes a field) testable
// without a market being open.
//
// Field layout of the Tencent quote endpoint differs per market. Only fields
// 3 (price) and 4 (previous close) are stable across all three, so the change
// percentage is always computed here instead of read from the payload.

export const MARKET_DEFS = Object.freeze({
  a: Object.freeze({
    id: 'a',
    label: 'A股',
    timeZone: 'Asia/Shanghai',
    // 09:15-09:25 is the opening auction; it is reported as `pre` so the pet
    // does not animate a market that has not traded yet.
    sessions: [
      { start: 9 * 60 + 30, end: 11 * 60 + 30 },
      { start: 13 * 60, end: 15 * 60 },
    ],
    indexCodes: ['sh000001', 'sz399001', 'sz399006'],
    quoteUrl: (codes) => `http://qt.gtimg.cn/q=${codes.join(',')}`,
    klineUrl: (code) =>
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,20,qfq`,
  }),
  hk: Object.freeze({
    id: 'hk',
    label: '港股',
    timeZone: 'Asia/Hong_Kong',
    sessions: [
      { start: 9 * 60 + 30, end: 12 * 60 },
      { start: 13 * 60, end: 16 * 60 },
    ],
    indexCodes: ['hkHSI', 'hkHSTECH'],
    quoteUrl: (codes) => `http://qt.gtimg.cn/q=${codes.join(',')}`,
    klineUrl: (code) =>
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,20,qfq`,
  }),
  us: Object.freeze({
    id: 'us',
    label: '美股',
    timeZone: 'America/New_York',
    sessions: [{ start: 9 * 60 + 30, end: 16 * 60 }],
    indexCodes: ['usDJI', 'usIXIC'],
    quoteUrl: (codes) => `http://qt.gtimg.cn/q=${codes.join(',')}`,
    klineUrl: (code) =>
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,20,qfq`,
  }),
})

export const MARKET_IDS = Object.freeze(Object.keys(MARKET_DEFS))

/** Market id for a quote code, or null when the prefix is unknown. */
export function marketOf(code) {
  const value = String(code ?? '').trim().toLowerCase()
  if (/^(sh|sz|bj)\d{6}$/.test(value)) return 'a'
  if (/^hk[0-9a-z]{1,8}$/.test(value)) return 'hk'
  if (/^us[0-9a-z.]{1,12}$/.test(value)) return 'us'
  return null
}

/**
 * Canonical form used everywhere else (`sh600519`, `hk00700`, `usAAPL`).
 * Returns null for anything that is not a recognisable quote code so a typo in
 * the watchlist never turns into a silent empty panel.
 */
export function normalizeCode(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const lowered = raw.toLowerCase().replace(/\s+/g, '')
  const prefix = marketOf(lowered)
  // US tickers are case-sensitive in the upstream feed, so keep them upper-case.
  if (prefix === 'us') return `us${lowered.slice(2).toUpperCase()}`
  if (prefix === 'hk' || prefix === 'a') return lowered
  // Bare 6-digit codes are A-share: 6/9 -> Shanghai, 0/2/3 -> Shenzhen.
  if (/^\d{6}$/.test(lowered)) {
    if (/^[69]/.test(lowered)) return `sh${lowered}`
    if (/^[023]/.test(lowered)) return `sz${lowered}`
    if (/^[48]/.test(lowered)) return `bj${lowered}`
    return null
  }
  // Bare 5-digit codes are Hong Kong.
  if (/^\d{5}$/.test(lowered)) return `hk${lowered}`
  // Bare tickers are US. Keep this tight: a loose rule would turn every word
  // in a typo like "not a code" into a ticker.
  if (/^[a-z]{1,5}([.-][a-z]{1,2})?$/.test(lowered)) return `us${lowered.toUpperCase()}`
  return null
}

function number(value) {
  const parsed = Number.parseFloat(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Parse a `qt.gtimg.cn` batch response (GBK-decoded) into quotes keyed by code.
 * Entries without a positive price are dropped: before the open the endpoint
 * returns an empty body, and a 0 price would otherwise look like a -100% move.
 */
export function parseTencentQuotes(text) {
  const quotes = new Map()
  for (const line of String(text ?? '').split(';')) {
    const match = /v_([A-Za-z0-9_.]+)\s*=\s*"([^"]*)"/.exec(line)
    if (!match) continue
    const code = match[1]
    const fields = match[2].split('~')
    if (fields.length < 6) continue
    const price = number(fields[3])
    const previousClose = number(fields[4])
    if (price === null || price <= 0) continue
    const market = marketOf(code)
    const pct = previousClose && previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : null
    // The payload pads a different number of empty slots per venue, so the
    // day range is located by anchoring on the timestamp instead of trusting a
    // fixed index. Every market places change/pct/high/low right after it.
    const timeIndex = fields.findIndex((field) =>
      /^\d{8}\d{6}$/.test(field) || /^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(field))
    const high = timeIndex > 0 ? number(fields[timeIndex + 3]) : null
    const low = timeIndex > 0 ? number(fields[timeIndex + 4]) : null
    quotes.set(code, {
      code,
      market,
      name: String(fields[1] ?? '').trim() || code,
      price,
      previousClose,
      pct,
      change: pct === null ? null : price - previousClose,
      high,
      low,
      // Amplitude is only meaningful when the venue publishes a day range.
      // The Hong Kong payload leaves 33/34 empty, so this stays null there.
      amplitudePct: high !== null && low !== null && high > 0 && low > 0 && previousClose
        ? ((high - low) / previousClose) * 100
        : null,
      volume: number(fields[6]),
      amount: number(fields[37]),
      quotedAt: timeIndex > 0 ? String(fields[timeIndex]) : '',
    })
  }
  return quotes
}

/** Daily bars from the Tencent k-line payload: `[date, open, close, high, low, volume]`. */
export function parseKline(payload, code) {
  const entry = payload?.data?.[code]
  if (!entry) return []
  const bars = entry.qfqday ?? entry.day ?? []
  const out = []
  for (const bar of Array.isArray(bars) ? bars : []) {
    if (!Array.isArray(bar) || bar.length < 6) continue
    out.push({
      date: String(bar[0]),
      open: number(bar[1]),
      close: number(bar[2]),
      high: number(bar[3]),
      low: number(bar[4]),
      volume: number(bar[5]),
    })
  }
  return out
}

/** Mean volume of the last `count` completed bars, ignoring the current day. */
export function averageVolume(bars, count = 20) {
  const usable = (Array.isArray(bars) ? bars : [])
    .slice(-(count + 1), -1)
    .filter((bar) => Number.isFinite(bar.volume) && bar.volume > 0)
  if (usable.length === 0) return null
  return usable.reduce((total, bar) => total + bar.volume, 0) / usable.length
}

/**
 * A-share breadth.
 *
 * East Money's `getTopicZDFenBu` returns a market-wide histogram keyed by
 * percent move ({"-10":1}, {"-1":1646}, {"0":268}, ...), which is one request
 * for the whole market. The `clist` fallback is kept for the day the histogram
 * endpoint changes shape, but it is capped at 100 rows per page, so it can only
 * ever describe a slice; the histogram is the one used in production.
 */
export function parseBreadth(payload) {
  const buckets = payload?.data?.fenbu
  if (Array.isArray(buckets)) {
    let up = 0
    let down = 0
    let flat = 0
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue
      for (const [key, value] of Object.entries(bucket)) {
        const pct = number(key)
        const count = number(value)
        if (pct === null || count === null || count <= 0) continue
        if (pct > 0) up += count
        else if (pct < 0) down += count
        else flat += count
      }
    }
    const total = up + down + flat
    if (total === 0) return null
    const traded = up + down
    return {
      up: Math.round(up),
      down: Math.round(down),
      flat: Math.round(flat),
      total: Math.round(total),
      ratio: traded === 0 ? 0.5 : up / traded,
    }
  }
  const diff = payload?.data?.diff
  const rows = Array.isArray(diff) ? diff : Object.values(diff ?? {})
  let up = 0
  let down = 0
  let flat = 0
  for (const row of rows) {
    const pct = number(row?.f3)
    if (pct === null) {
      flat += 1
      continue
    }
    if (pct > 0) up += 1
    else if (pct < 0) down += 1
    else flat += 1
  }
  const total = up + down + flat
  if (total === 0) return null
  const traded = up + down
  return {
    up,
    down,
    flat,
    total,
    ratio: traded === 0 ? 0.5 : up / traded,
  }
}

export const BREADTH_URL =
  'https://push2ex.eastmoney.com/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt'

const WEEKEND = new Set(['Sat', 'Sun'])

function localParts(timeZone, date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const parts = {}
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value
  return {
    hour: Number.parseInt(parts.hour ?? '0', 10),
    minute: Number.parseInt(parts.minute ?? '0', 10),
    weekday: parts.weekday ?? '',
    date: `${parts.year}-${parts.month}-${parts.day}`,
  }
}

/**
 * Where the venue is in its trading day.
 * `phase` is one of closed | pre | open | lunch | post.
 * Public holidays are intentionally not modelled here: a closed holiday is
 * reported as `open` but the quote feed simply returns yesterday's snapshot,
 * which the scorer treats as a flat day.
 */
export function sessionState(market, date = new Date()) {
  const definition = MARKET_DEFS[market]
  if (!definition) return { market, phase: 'closed', trading: false, date: null, minutes: null }
  const local = localParts(definition.timeZone, date)
  const minutes = local.hour * 60 + local.minute
  if (WEEKEND.has(local.weekday)) {
    return { market, phase: 'closed', trading: false, date: local.date, minutes, localTime: formatMinutes(minutes) }
  }
  const inside = definition.sessions.some((span) => minutes >= span.start && minutes < span.end)
  if (inside) {
    return { market, phase: 'open', trading: true, date: local.date, minutes, localTime: formatMinutes(minutes) }
  }
  const first = definition.sessions[0]
  const last = definition.sessions[definition.sessions.length - 1]
  let phase = 'closed'
  if (minutes < first.start) phase = 'pre'
  else if (minutes >= last.end) phase = 'post'
  else phase = 'lunch'
  return { market, phase, trading: false, date: local.date, minutes, localTime: formatMinutes(minutes) }
}

function formatMinutes(total) {
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** True when any of the configured markets is currently trading. */
export function anyMarketOpen(markets, date = new Date()) {
  return markets.some((market) => sessionState(market, date).trading)
}

/**
 * Fraction of the trading day that has elapsed (0..1).
 *
 * Comparing a morning's volume against a full-day average makes every open
 * look like a dead market, so the volume ratio divides by this instead.
 * After the close it returns 1: the whole day is on the tape.
 */
export function sessionProgress(market, date = new Date()) {
  const definition = MARKET_DEFS[market]
  if (!definition) return 0
  const local = localParts(definition.timeZone, date)
  const minutes = local.hour * 60 + local.minute
  if (WEEKEND.has(local.weekday)) return 0
  const total = definition.sessions.reduce((sum, span) => sum + (span.end - span.start), 0)
  if (total <= 0) return 0
  let elapsed = 0
  for (const span of definition.sessions) {
    elapsed += Math.min(Math.max(minutes - span.start, 0), span.end - span.start)
  }
  return Math.min(1, Math.max(0, elapsed / total))
}
