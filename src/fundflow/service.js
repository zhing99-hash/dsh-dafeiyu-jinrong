// Cache and manual refresh for the core-ETF share monitor.
//
// This service is deliberately independent of DSA: the Studio can show the
// last snapshot even when the AI analysis service is disabled or offline.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fetchFundFlow, FUNDFLOW_ETFS, DEFAULT_DAYS } from './source.js'

export function defaultFundflowPath() {
  return join(homedir(), '.dsh', 'dafeiyu', 'fundflow.json')
}

function emptySnapshot() {
  return {
    source: 'Tushare fund_share',
    unit: '亿份',
    updatedAt: '',
    latestDate: '',
    dates: [],
    etfs: FUNDFLOW_ETFS,
    total: [],
    etfsSeries: {},
    normalized: {},
    latest: {},
    latestTotal: null,
    latestTotalDelta: null,
    days: DEFAULT_DAYS,
    warnings: [],
    error: '',
  }
}

export function createFundflowService({
  getConfig,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cachePath = defaultFundflowPath(),
  logger = console,
} = {}) {
  let snapshot = emptySnapshot()
  let refreshing = null

  try {
    if (existsSync(cachePath)) {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (parsed && Array.isArray(parsed.dates)) snapshot = { ...emptySnapshot(), ...parsed, error: '' }
    }
  } catch (error) {
    logger.warn?.(`[dafeiyu] fundflow cache unreadable: ${error?.message ?? error}`)
  }

  function persist(next) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      writeFileSync(cachePath, JSON.stringify(next), 'utf8')
    } catch (error) {
      logger.warn?.(`[dafeiyu] fundflow cache write failed: ${error?.message ?? error}`)
    }
  }

  function get() {
    return snapshot
  }

  async function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const config = getConfig() ?? {}
      const token = String(config.marketTushareToken ?? '').trim()
      try {
        const next = await fetchFundFlow({ token, fetchImpl, now })
        snapshot = { ...next, error: '' }
        persist(snapshot)
        return snapshot
      } catch (error) {
        const message = error?.message ?? String(error)
        // Keep the previous snapshot visible; only attach the refresh error.
        snapshot = { ...snapshot, error: message }
        return snapshot
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  return {
    get,
    refresh,
    get path() { return cachePath },
  }
}
