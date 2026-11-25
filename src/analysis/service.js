// Stateful DSA integration: connection status, watchlist merge, batch
// analysis, task polling, report retrieval and the DSH-owned daily schedule.
//
// The service never starts DSA and never stores its model/data keys. It only
// talks to the configured local FastAPI endpoint and surfaces the result to
// the Studio panel and the desktop pet.

import { createMessage, CompanionMessageKind } from '../protocol.js'
import {
  createDsaClient, normalizeBaseUrl, toDsaCode, DsaError, MAX_BATCH,
} from './client.js'
import { dockerAction, dockerStatus } from './docker.js'
import { createDsaLauncher } from './launcher.js'

const ACTIVE = new Set(['pending', 'queued', 'running', 'in_progress', 'processing'])
const FINISHED = new Set(['completed', 'success', 'succeeded', 'done', 'failed', 'error', 'cancelled', 'canceled', 'timeout'])

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseSchedule(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function actionGroup(stock) {
  const action = String(stock?.action ?? '').toLowerCase()
  const advice = String(stock?.advice ?? '')
  if (['buy', 'add'].includes(action) || /买入|加仓/.test(advice)) return 'buy'
  if (['sell', 'reduce', 'avoid'].includes(action) || /卖出|减仓|回避/.test(advice)) return 'sell'
  if (['watch', 'hold', 'alert'].includes(action) || /观望|持有|警惕/.test(advice)) return 'watch'
  return 'unknown'
}

function watchlistOf(config) {
  const list = Array.isArray(config?.marketWatchlist) ? config.marketWatchlist : []
  return list
    .map((entry) => {
      const raw = String(entry?.code ?? '').trim()
      if (!raw) return null
      return {
        code: raw,
        dsaCode: toDsaCode(raw),
        name: String(entry?.alias ?? '').trim() || raw,
      }
    })
    .filter(Boolean)
}

export function createAnalysisService({
  getConfig,
  sendMessage = () => {},
  logger = console,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  scheduleCheckMs = 30_000,
} = {}) {
  const client = createDsaClient({ fetchImpl, getConfig })
  const launcher = createDsaLauncher({ getConfig, logger })
  let timer = null
  let pollTimer = null
  let stopped = false
  let checking = false
  let lastError = ''
  let lastRunAt = ''
  let lastSummary = null
  let lastScheduleDate = ''
  let stocksCache = []
  let activeTasks = []
  let batchSeq = 0
  let taskFailures = 0

  const enabled = () => getConfig()?.analysisEnabled === true
  const configOf = () => getConfig() ?? {}

  async function status() {
    const config = configOf()
    let connected = false
    let health = null
    if (enabled()) {
      try {
        health = await client.health()
        connected = true
        lastError = ''
      } catch (error) {
        lastError = error?.message ?? String(error)
      }
    }
    const schedule = String(config.analysisSchedule ?? '').trim()
    let baseUrl = String(config.analysisBaseUrl ?? '')
    try { baseUrl = normalizeBaseUrl(baseUrl) } catch { /* keep the raw value for the error UI */ }
    return {
      enabled: enabled(),
      connected,
      baseUrl,
      container: String(config.analysisContainer ?? ''),
      schedule,
      reportType: String(config.analysisReportType ?? 'detailed'),
      petSummary: config.analysisPetSummary !== false,
      health,
      error: lastError,
      lastRunAt,
      lastSummary,
      tasks: activeTasks,
      watchlist: watchlistOf(config),
      launch: {
        mode: String(config.analysisLaunchMode ?? 'auto'),
        ...launcher.status,
      },
    }
  }

  async function stocks() {
    const config = configOf()
    const list = watchlistOf(config)
    if (!enabled()) {
      return {
        connected: false,
        enabled: false,
        error: '',
        items: list.map((entry) => ({ ...entry, name: entry.name, reportId: null, actionLabel: '未分析' })),
      }
    }
    try {
      const remote = await client.stocks(200)
      stocksCache = remote
      lastError = ''
      const byCode = new Map(remote.map((item) => [toDsaCode(item.code), item]))
      const items = list.map((entry) => {
        const hit = byCode.get(entry.dsaCode)
        if (!hit) return { ...entry, reportId: null, actionLabel: '未分析' }
        return { ...entry, ...hit, name: entry.name || hit.name, inWatchlist: true }
      })
      for (const item of remote) {
        if (!items.some((row) => row.dsaCode === toDsaCode(item.code))) {
          items.push({ ...item, inWatchlist: false })
        }
      }
      return { connected: true, enabled: true, error: '', items }
    } catch (error) {
      lastError = error?.message ?? String(error)
      return {
        connected: false,
        enabled: true,
        error: lastError,
        items: list.map((entry) => {
          const hit = stocksCache.find((row) => toDsaCode(row.code) === entry.dsaCode)
          return hit ? { ...entry, ...hit, name: entry.name || hit.name, inWatchlist: true } : { ...entry, reportId: null, actionLabel: '未分析' }
        }),
      }
    }
  }

  async function history(params = {}) {
    if (!enabled()) throw new Error('DSA 分析未启用')
    return client.history(params)
  }

  async function report(id) {
    if (!enabled()) throw new Error('DSA 分析未启用')
    const [detail, markdown, news] = await Promise.all([
      client.detail(id).catch((error) => ({ error: error?.message ?? String(error) })),
      client.markdown(id).catch(() => ''),
      client.news(id).catch(() => []),
    ])
    return { id: String(id), detail, markdown, news }
  }

  function finishPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  function hasActiveTasks(tasks) {
    return Array.isArray(tasks) && tasks.some((task) => {
      const status = String(task?.status ?? '').toLowerCase()
      return !FINISHED.has(status) && (ACTIVE.has(status) || !status)
    })
  }

  async function sendSummary(seq) {
    if (seq !== batchSeq) return
    const config = configOf()
    if (config.analysisPetSummary === false) return
    const snapshot = await stocks()
    const rows = snapshot.items.filter((item) => item.reportId || item.analyzedAt)
    if (rows.length === 0) return
    const counts = { buy: 0, watch: 0, sell: 0, unknown: 0 }
    for (const row of rows) counts[actionGroup(row)] += 1
    const tops = rows
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) => Number(b.score) - Number(a.score))
      .slice(0, 2)
      .map((row) => `${row.name} ${row.score} ${row.actionLabel || row.advice || ''}`.trim())
    lastSummary = {
      total: rows.length,
      counts,
      at: new Date(now()).toISOString(),
      top: tops,
    }
    lastRunAt = lastSummary.at
    sendMessage(createMessage(CompanionMessageKind.STATE, {
      state: 'SUCCESS',
      phase: 'analysis',
      stage: 'AI 分析',
      message: `今日分析 ${rows.length} 只 · 买${counts.buy} 观${counts.watch} 卖${counts.sell}`,
      detail: tops.join(' · '),
      analysis: lastSummary,
      __analysis: true,
    }))
  }

  async function pollTasks(seq = batchSeq) {
    if (stopped || !enabled() || seq !== batchSeq) return
    try {
      const tasks = await client.tasks()
      activeTasks = tasks
      taskFailures = 0
      if (hasActiveTasks(tasks)) {
        finishPolling()
        pollTimer = setTimeout(() => void pollTasks(seq), 4000)
        pollTimer.unref?.()
        return
      }
      finishPolling()
      await sendSummary(seq)
    } catch (error) {
      taskFailures += 1
      lastError = error?.message ?? String(error)
      if (taskFailures < 8) {
        finishPolling()
        pollTimer = setTimeout(() => void pollTasks(seq), 5000)
        pollTimer.unref?.()
      }
    }
  }

  async function analyze(codes, options = {}) {
    if (!enabled()) throw new Error('请先在分析设置里启用 DSA')
    const config = configOf()
    const requested = Array.isArray(codes) && codes.length > 0
      ? codes
      : watchlistOf(config).map((entry) => entry.code)
    const unique = [...new Set(requested.map(toDsaCode).filter(Boolean))]
    if (unique.length === 0) throw new Error('养鱼自选股为空')
    if (unique.length > MAX_BATCH) throw new Error(`单次最多分析 ${MAX_BATCH} 只股票`)
    lastError = ''
    const result = await client.analyze(unique, {
      reportType: options.reportType ?? config.analysisReportType ?? 'detailed',
      forceRefresh: options.forceRefresh === true,
      skills: options.skills ?? [],
    })
    batchSeq += 1
    const seq = batchSeq
    activeTasks = result.tasks?.length
      ? result.tasks
      : result.taskIds.map((id) => ({ id, status: 'queued', progress: 0, message: '' }))
    finishPolling()
    if (activeTasks.length > 0) {
      pollTimer = setTimeout(() => void pollTasks(seq), 1200)
      pollTimer.unref?.()
    } else {
      void pollTasks(seq)
    }
    return { accepted: result.accepted, taskIds: result.taskIds, tasks: activeTasks }
  }

  function nextRunAt() {
    const config = configOf()
    const schedule = parseSchedule(config.analysisSchedule)
    if (!schedule) return null
    const current = new Date(now())
    const next = new Date(current)
    next.setHours(schedule.hour, schedule.minute, 0, 0)
    if (next.getTime() <= current.getTime() || lastScheduleDate === dateKey(current)) {
      next.setDate(next.getDate() + 1)
    }
    return next.toISOString()
  }

  async function checkSchedule() {
    if (stopped || checking || !enabled()) return
    const config = configOf()
    const schedule = parseSchedule(config.analysisSchedule)
    if (!schedule) return
    const current = new Date(now())
    const weekday = current.getDay()
    if (weekday === 0 || weekday === 6) return
    const due = current.getHours() > schedule.hour
      || (current.getHours() === schedule.hour && current.getMinutes() >= schedule.minute)
    if (!due || lastScheduleDate === dateKey(current) || hasActiveTasks(activeTasks)) return
    checking = true
    lastScheduleDate = dateKey(current)
    try {
      await analyze()
      logger.info?.('[dsh-dafeiyu-jinrong] scheduled DSA analysis started')
    } catch (error) {
      lastError = error?.message ?? String(error)
      logger.warn?.(`DSA scheduled analysis failed: ${lastError}`)
    } finally {
      checking = false
    }
  }

  function start() {
    if (timer) return
    stopped = false
    timer = setIntervalImpl(() => { void checkSchedule() }, scheduleCheckMs)
    timer.unref?.()
  }

  function configure() {
    if (!enabled()) {
      finishPolling()
      activeTasks = []
      lastError = ''
    }
  }

  function stop() {
    stopped = true
    if (timer) clearIntervalImpl(timer)
    timer = null
    finishPolling()
    activeTasks = []
    launcher.stop()
  }

  return {
    status,
    stocks,
    history,
    report,
    analyze,
    tasks: async () => {
      if (!enabled()) return []
      return client.tasks()
    },
    marketReview: async () => {
      if (!enabled()) throw new Error('请先启用 DSA')
      return client.marketReview()
    },
    chat: async (message, sessionId) => {
      if (!enabled()) throw new Error('请先启用 DSA')
      return client.chat(message, sessionId)
    },
    docker: async (action) => {
      const container = String(configOf().analysisContainer ?? '').trim()
      if (!container) throw new Error('未配置 DSA 容器名')
      return action === 'status' ? dockerStatus(container) : dockerAction(container, action)
    },
    syncWatchlist: async () => {
      if (!enabled()) throw new Error('请先启用 DSA')
      const codes = watchlistOf(configOf()).map((entry) => entry.code)
      if (codes.length === 0) throw new Error('养鱼自选股为空，无法同步')
      return client.syncStockList(codes)
    },
    startDsa: async () => launcher.start(),
    stopDsa: async () => {
      launcher.stop()
      return { ok: true }
    },
    configure,
    checkSchedule,
    nextRunAt,
    start,
    stop,
    get snapshot() {
      return { lastError, lastRunAt, lastSummary, activeTasks, lastScheduleDate }
    },
    DsaError,
  }
}
