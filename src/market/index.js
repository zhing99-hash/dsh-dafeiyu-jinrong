// Market monitor: the piece that turns quotes into pet messages.
//
// Lifecycle is deliberately boring — one timer, one in-flight request, and a
// snapshot that survives failures. Everything network-shaped is injected so
// the module can be exercised in a test without touching a real endpoint.

import { createMessage } from '../protocol.js'
import {
  BREADTH_URL,
  MARKET_DEFS,
  normalizeCode,
  parseBreadth,
  parseTencentQuotes,
  sessionState,
} from './feed.js'
import { createAlertEngine, formatAlert } from './alerts.js'
import { MOOD_LABELS, createMoodTracker, moodLine, scoreMarket, scoreStock } from './mood.js'

const BREADTH_TTL_MS = 30 * 1000
const MAX_BACKOFF_MS = 60_000
// Even when the mood does not change, refresh the bubble line (which carries
// the index level) every so often so the pet feels live without restarting its
// animation on every poll.
const SEND_REFRESH_MS = 30_000

function formatPct(value) {
  if (!Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '—'
  return value >= 1000 ? value.toFixed(2) : value.toFixed(2)
}

/**
 * @param {object} options
 * @param {() => object} options.getConfig live plugin config
 * @param {(message: object) => void} options.send message sink (bridge)
 */
export function createMarketMonitor({
  getConfig,
  send,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const mood = createMoodTracker({ now })
  const alerts = createAlertEngine({ now })
  let breadthCache = null
  let breadthAt = 0
  let timer = null
  let inFlight = false
  let stopped = true
  let backoffMs = 0
  let lineSeed = 0
  let lastSnapshot = null
  let lastSentAt = 0

  function config() {
    const value = typeof getConfig === 'function' ? getConfig() ?? {} : {}
    return {
      enabled: value.marketEnabled === true,
      focus: MARKET_DEFS[value.marketFocus] ? value.marketFocus : 'a',
      watchlist: Array.isArray(value.marketWatchlist) ? value.marketWatchlist : [],
      pollSeconds: clampNumber(value.marketPollSeconds, 3, 60, 5),
      cooldownSeconds: clampNumber(value.marketAlertCooldown, 60, 3600, 300),
      yieldToTask: value.marketYieldToTask !== false,
    }
  }

  function watchedCodes(cfg) {
    const codes = new Set(MARKET_DEFS[cfg.focus].indexCodes)
    for (const entry of cfg.watchlist) {
      const code = normalizeCode(entry?.code)
      if (!code) continue
      // Only names from the focused market feed the mood, but every name keeps
      // its price alerts: a user can watch Hong Kong stocks while the pet
      // follows the A-share mood.
      codes.add(code)
    }
    return [...codes]
  }

  async function getJson(url, headers = {}) {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'dsh-dafeiyu-jinrong/0.1', ...headers },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
    })
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`)
    return response.json()
  }

  async function getText(url, headers = {}) {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'dsh-dafeiyu-jinrong/0.1', ...headers },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
    })
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`)
    const buffer = await response.arrayBuffer()
    // The Tencent feed is GBK. TextDecoder handles it in Node and Electron.
    return new TextDecoder('gbk').decode(buffer)
  }

  async function breadthFor(at) {
    if (breadthCache && at - breadthAt < BREADTH_TTL_MS) return breadthCache
    try {
      const payload = await getJson(BREADTH_URL, { referer: 'https://quote.eastmoney.com/' })
      breadthCache = parseBreadth(payload)
      breadthAt = at
      return breadthCache
    } catch (error) {
      logger.warn?.(`market: breadth unavailable: ${error?.message ?? error}`)
      return breadthCache
    }
  }

  function snapshotText(cfg, quotes, detail) {
    const definition = MARKET_DEFS[cfg.focus]
    const indexCode = definition.indexCodes[0]
    const quote = quotes.get(indexCode)
    const parts = []
    if (quote) parts.push(`${definition.label} ${formatPrice(quote.price)} ${formatPct(quote.pct)}`)
    if (detail) parts.push(detail)
    return parts.join(' · ')
  }

  function stateMessage(moodBand, cfg, quotes, extra = {}) {
    const definition = MARKET_DEFS[cfg.focus]
    lineSeed += 1
    const text = extra.message ?? moodLine(moodBand.key, lineSeed)
    return createMessage('state', {
      state: moodBand.state,
      phase: 'market',
      stage: `${definition.label} · ${MOOD_LABELS[moodBand.key] ?? moodBand.key}`,
      message: text,
      detail: extra.detail ?? snapshotText(cfg, quotes ?? new Map()),
      __market: true,
      ...(extra.alert === true ? { __alert: true } : {}),
    })
  }

  async function tick() {
    if (stopped || inFlight) return
    const cfg = config()
    if (!cfg.enabled) return
    inFlight = true
    const at = now()
    try {
      const codes = watchedCodes(cfg)
      if (codes.length === 0) return
      const text = await getText(MARKET_DEFS[cfg.focus].quoteUrl(codes))
      const quotes = parseTencentQuotes(text)
      if (quotes.size === 0) {
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs === 0 ? 5000 : backoffMs * 2)
        return
      }
      backoffMs = 0

      const definition = MARKET_DEFS[cfg.focus]
      const focusQuote = quotes.get(definition.indexCodes[0]) ?? [...quotes.values()][0]
      // Breadth only exists for the A-share market; passing null lets the
      // scorer fall back to the two-factor weights.
      const breadth = cfg.focus === 'a' ? await breadthFor(at) : null

      const { score } = scoreMarket({
        pct: focusQuote?.pct,
        breadth: breadth?.ratio ?? null,
        amplitudePct: focusQuote?.amplitudePct ?? null,
      })

      const result = mood.update(score, at)
      const breadthText = breadth ? `上涨 ${breadth.up} / 下跌 ${breadth.down}` : ''
      const detail = [snapshotText(cfg, quotes), breadthText].filter(Boolean).join(' · ')

      const events = alerts.update(quotes, at)
      if (events.length > 0) {
        const alert = formatAlert(events)
        if (alert) {
          send(createMessage('state', {
            state: alert.state,
            phase: 'market-alert',
            stage: '价格提醒',
            message: alert.title,
            detail: alert.detail,
            __market: true,
            __alert: true,
          }))
        }
      }

      if (result.changed || at - lastSentAt >= SEND_REFRESH_MS) {
        const band = result.mood
        lastSentAt = at
        lastSnapshot = { at, score: result.score, mood: band.key, quotes, breadth }
        send(stateMessage(band, cfg, quotes, { detail }))
      }
    } catch (error) {
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs === 0 ? 5000 : backoffMs * 2)
      logger.warn?.(`market: tick failed: ${error?.message ?? error}`)
    } finally {
      inFlight = false
      schedule()
    }
  }

  function schedule() {
    if (stopped) return
    if (timer) clearTimer(timer)
    timer = null
    const cfg = config()
    if (!cfg.enabled) return
    const open = sessionState(cfg.focus).trading
    const base = open ? cfg.pollSeconds * 1000 : 60_000
    const wait = Math.max(1000, Math.min(MAX_BACKOFF_MS, base + backoffMs))
    timer = setTimer(() => { void tick() }, wait)
    timer?.unref?.()
  }

  return {
    get snapshot() {
      return lastSnapshot
    },
    configure() {
      alerts.configure(config().watchlist)
    },
    start() {
      if (!stopped) return
      stopped = false
      alerts.configure(config().watchlist)
      schedule()
    },
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
    },
    /** Exposed for tests and for a manual "refresh now" action. */
    tickNow() {
      return tick()
    },
    /** Per-stock sentiment for the watchlist panel. */
    describeWatchlist(quotes) {
      const cfg = config()
      const definition = MARKET_DEFS[cfg.focus]
      const focusQuote = quotes?.get(definition.indexCodes[0])
      return cfg.watchlist.map((entry) => {
        const code = normalizeCode(entry?.code)
        const quote = code ? quotes?.get(code) : null
        if (!quote) return { code, alias: entry?.alias ?? code, missing: true }
        const relativePct = Number.isFinite(quote.pct) && Number.isFinite(focusQuote?.pct)
          ? quote.pct - focusQuote.pct
          : null
        const moodOfStock = scoreStock({ pct: quote.pct, relativePct, volumeRatio: null })
        return {
          code,
          alias: entry?.alias || quote.name,
          price: quote.price,
          pct: quote.pct,
          level: moodOfStock.level,
          above: Number(entry?.above) || null,
          below: Number(entry?.below) || null,
        }
      })
    },
  }
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
