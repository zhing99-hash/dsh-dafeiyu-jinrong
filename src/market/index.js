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
import { createTushareClient, toTsCode } from './tushare.js'

const BREADTH_TTL_MS = 30 * 1000
const MAX_BACKOFF_MS = 60_000
// Even when the mood does not change, refresh the bubble line (which carries
// the index level) every so often so the pet feels live without restarting its
// animation on every poll.
const SEND_REFRESH_MS = 30_000
// A watchlist view is a single stock: refresh it more often so the price feels
// live, but only when the text actually changed.
const VIEW_REFRESH_MS = 8_000

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
  let tushare = null
  let tushareToken = ''
  let breadthCache = null
  let breadthAt = 0
  let timer = null
  let inFlight = false
  let stopped = true
  let backoffMs = 0
  let lineSeed = 0
  let lastSnapshot = null
  let lastSentAt = 0
  // Tab cycles the bubble between the whole market and each watchlist name.
  // 0 is the market view; 1..N follow the configured watchlist order.
  let viewIndex = 0
  let lastQuotes = new Map()
  let lastBreadth = null
  let lastIndexMessage = null
  let lastViewDetail = ''

  function config() {
    const value = typeof getConfig === 'function' ? getConfig() ?? {} : {}
    return {
      enabled: value.marketEnabled === true,
      focus: MARKET_DEFS[value.marketFocus] ? value.marketFocus : 'a',
      watchlist: Array.isArray(value.marketWatchlist) ? value.marketWatchlist : [],
      pollSeconds: clampNumber(value.marketPollSeconds, 3, 60, 5),
      cooldownSeconds: clampNumber(value.marketAlertCooldown, 60, 3600, 300),
      yieldToTask: value.marketYieldToTask !== false,
      // Optional: without a token everything still works on the free quote feed.
      tushareToken: String(value.marketTushareToken ?? '').trim(),
    }
  }

  /** Rebuild the Tushare client only when the token actually changes. */
  function tushareFor(cfg) {
    if (cfg.tushareToken === tushareToken) return tushare
    tushareToken = cfg.tushareToken
    tushare = cfg.tushareToken ? createTushareClient({ token: cfg.tushareToken, logger }) : null
    return tushare
  }

  async function volumeRatioFor(code, quote, cfg) {
    const tsCode = toTsCode(code)
    const client = tushareFor(cfg)
    if (!tsCode || !client || !Number.isFinite(quote?.volume)) return null
    const average = await client.averageVolume(tsCode)
    if (!average || average <= 0) return null
    return quote.volume / average
  }

  function watchedCodes(cfg) {    const codes = new Set(MARKET_DEFS[cfg.focus].indexCodes)
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
      lastQuotes = quotes
      lastBreadth = breadth
      const breadthText = breadth ? `上涨 ${breadth.up} / 下跌 ${breadth.down}` : ''
      // The bubble's detail row is a single elided line (~30 CJK characters at
      // the default size). With a watchlist configured, the user's own names
      // are the more useful half, so they replace the index level and the
      // breadth counts — the mood score already reflects breadth.
      const watchlistText = summarizeWatchlist(cfg, quotes, focusQuote, 2)
      const detail = watchlistText
        ? [formatPct(focusQuote?.pct), watchlistText].filter(Boolean).join(' · ')
        : [snapshotText(cfg, quotes), breadthText].filter(Boolean).join(' · ')

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

      const views = viewList(cfg)
      if (viewIndex >= views.length) viewIndex = 0
      const view = views[viewIndex]

      if (view.kind === 'stock') {
        // Tushare supplies the 20-day average volume, so the stock bubble can
        // show a real 量比 instead of guessing from a single day.
        const volumeRatio = await volumeRatioFor(view.code, quotes.get(view.code), cfg)
        const message = stockStateMessage(view, quotes, focusQuote, lineSeed, volumeRatio)
        if (message && (message.detail !== lastViewDetail || at - lastSentAt >= VIEW_REFRESH_MS)) {
          lastSentAt = at
          lastViewDetail = message.detail
          lastSnapshot = { at, score: result.score, mood: result.mood.key, quotes, breadth, view: view.code }
          send(message)
        }
      } else if (result.changed || at - lastSentAt >= SEND_REFRESH_MS) {
        const band = result.mood
        lastSentAt = at
        lastViewDetail = detail
        lastSnapshot = { at, score: result.score, mood: band.key, quotes, breadth, watchlist: watchlistSnapshot(cfg, quotes, focusQuote) }
        const message = stateMessage(band, cfg, quotes, { detail })
        lastIndexMessage = message
        send(message)
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
    get view() {
      const views = viewList(config())
      return views[viewIndex] ?? views[0]
    },
    /**
     * Advance the bubble: 总盘 → 自选1 → 自选2 → … → 总盘.
     * Re-renders from the last poll so a key press feels instant instead of
     * waiting up to one poll interval.
     */
    cycleView({ back = false } = {}) {
      const cfg = config()
      const views = viewList(cfg)
      viewIndex = (viewIndex + (back ? -1 : 1) + views.length) % views.length
      const view = views[viewIndex]
      if (lastQuotes.size > 0) {
        const focusQuote = lastQuotes.get(MARKET_DEFS[cfg.focus].indexCodes[0])
        const message = view.kind === 'stock'
          ? stockStateMessage(view, lastQuotes, focusQuote, lineSeed)
          : lastIndexMessage
        if (message) {
          lastViewDetail = message.detail
          lastSentAt = now()
          send(message)
        }
      }
      return view
    },
    /** Per-stock sentiment for the watchlist panel. */
    describeWatchlist(quotes) {
      const cfg = config()
      const definition = MARKET_DEFS[cfg.focus]
      const focusQuote = quotes?.get(definition.indexCodes[0])
      return buildWatchlist(cfg, quotes, focusQuote)
    },
  }
}

function buildWatchlist(cfg, quotes, focusQuote) {
  return cfg.watchlist.map((entry) => {
    const code = normalizeCode(entry?.code)
    const quote = code ? quotes?.get(code) : null
    if (!quote) return { code, alias: String(entry?.alias ?? code ?? '').trim() || '—', missing: true }
    const relativePct = Number.isFinite(quote.pct) && Number.isFinite(focusQuote?.pct)
      ? quote.pct - focusQuote.pct
      : null
    const stockMood = scoreStock({ pct: quote.pct, relativePct, volumeRatio: null })
    return {
      code,
      alias: String(entry?.alias ?? '').trim() || quote.name,
      price: quote.price,
      pct: quote.pct,
      level: stockMood.level,
      above: Number(entry?.above) || null,
      below: Number(entry?.below) || null,
    }
  })
}

function arrowFor(level) {
  if (level === 'strong') return '↑'
  if (level === 'weak') return '↓'
  // A dot would collide with the " · " separator between names.
  return ''
}

/**
 * One-line watchlist summary for the bubble's detail row ("茅台 +1.2%↑").
 * The card is a two-line bubble owned by the Helper, so a compact line is the
 * only shape that fits without patching the Qt side.
 */
function summarizeWatchlist(cfg, quotes, focusQuote, limit = 3) {
  const rows = buildWatchlist(cfg, quotes, focusQuote).filter((row) => !row.missing)
  if (rows.length === 0) return ''
  const shown = rows
    .slice(0, limit)
    .map((row) => `${row.alias} ${formatPct(row.pct)}${arrowFor(row.level)}`)
  // No "+N more" tail: the detail row is already elided, and a dangling count
  // reads like a price.
  return shown.join(' · ')
}

function watchlistSnapshot(cfg, quotes, focusQuote) {
  return buildWatchlist(cfg, quotes, focusQuote)
}

/**
 * Ordered bubble views: the market first, then each watchlist name.
 * Tab walks this list, so the order has to match what the user configured.
 */
export function viewList(cfg) {
  const views = [{ kind: 'index', label: '总盘' }]
  // Accept both the plugin config (`marketWatchlist`) and the normalised
  // monitor config (`watchlist`) so this stays usable from either side.
  const entries = Array.isArray(cfg?.watchlist)
    ? cfg.watchlist
    : (Array.isArray(cfg?.marketWatchlist) ? cfg.marketWatchlist : [])
  for (const entry of entries) {
    const code = normalizeCode(entry?.code)
    if (!code) continue
    views.push({
      kind: 'stock',
      code,
      alias: String(entry?.alias ?? '').trim(),
      above: Number(entry?.above) || null,
      below: Number(entry?.below) || null,
    })
  }
  return views
}

const STOCK_LEVEL_STATE = Object.freeze({ strong: 'SUCCESS', flat: 'IDLE', weak: 'ERROR' })
const STOCK_LEVEL_LABEL = Object.freeze({ strong: '走强', flat: '平稳', weak: '走弱' })
const STOCK_LEVEL_LINE = Object.freeze({
  strong: ['这只今天挺精神', '有点起色，我盯着呢', '比大盘强，不错哦'],
  flat: ['不温不火，看着呢', '就这样吧，喝口水', '没太大动静'],
  weak: ['这只有点蔫', '不太对劲，我缩一下', '绿了，别看我'],
})

function stockLine(level, seed = 0) {
  const lines = STOCK_LEVEL_LINE[level] ?? STOCK_LEVEL_LINE.flat
  return lines[Math.abs(Math.trunc(Number(seed) || 0)) % lines.length]
}

/** Bubble for one watchlist name: price, move, volume ratio, and the thresholds. */
export function stockStateMessage(view, quotes, focusQuote, seed = 0, volumeRatio = null) {
  const quote = quotes?.get?.(view.code)
  if (!quote) return null
  const relativePct = Number.isFinite(quote.pct) && Number.isFinite(focusQuote?.pct)
    ? quote.pct - focusQuote.pct
    : null
  const stock = scoreStock({ pct: quote.pct, relativePct, volumeRatio })
  const detail = [`${formatPrice(quote.price)} ${formatPct(quote.pct)}`]
  if (Number.isFinite(volumeRatio)) detail.push(`量比 ${volumeRatio.toFixed(2)}`)
  if (view.above) detail.push(`上限 ${formatPrice(view.above)}${quote.price >= view.above ? ' 已破' : ''}`)
  if (view.below) detail.push(`下限 ${formatPrice(view.below)}${quote.price <= view.below ? ' 已破' : ''}`)
  return createMessage('state', {
    state: STOCK_LEVEL_STATE[stock.level] ?? 'IDLE',
    phase: 'market-stock',
    stage: `${view.alias || quote.name} · ${STOCK_LEVEL_LABEL[stock.level] ?? '平稳'}`,
    message: stockLine(stock.level, seed),
    detail: detail.join(' · '),
    __market: true,
  })
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
