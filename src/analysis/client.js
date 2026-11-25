// Local adapter for the optional daily_stock_analysis (DSA) sidecar.
//
// DSA stays an external Python/FastAPI service. This module owns the HTTP
// contract: URL normalization, auth cookie forwarding, flexible response
// normalization, timeouts, and the hard rule that panel-triggered analyses
// never push to DSA's external notification channels.

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000'
const MAX_BATCH = 50
const DEFAULT_TIMEOUT_MS = 8000

export class DsaError extends Error {
  constructor(message, { status = 0, data = null } = {}) {
    super(message)
    this.name = 'DsaError'
    this.status = status
    this.data = data
  }
}

/** Strip trailing slashes and reject unusable values early. */
export function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim() || DEFAULT_BASE_URL
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('DSA 地址格式不正确')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('DSA 地址必须是 http/https')
  return url.toString().replace(/\/+$/, '')
}

/** Map a dafeiyu quote code to the code format DSA expects. */
export function toDsaCode(code) {
  const raw = String(code ?? '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.startsWith('sh') || lower.startsWith('sz') || lower.startsWith('bj')) return raw.slice(2)
  if (lower.startsWith('hk')) return `hk${raw.slice(2)}`
  if (lower.startsWith('us')) return raw.slice(2).toUpperCase()
  return raw
}

export function isDsaCode(code) {
  const raw = String(code ?? '').trim()
  return /^(?:\d{6}|(?:sh|sz|bj)\d{6}|hk\d{5}|[A-Za-z][A-Za-z0-9.-]{0,9})$/i.test(raw)
}

function itemsOf(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.items)) return payload.items
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.tasks)) return payload.tasks
  if (Array.isArray(payload?.results)) return payload.results
  return []
}

function textOf(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function actionLabel(action, advice) {
  const map = {
    buy: '买入', add: '加仓', hold: '持有', reduce: '减仓',
    sell: '卖出', watch: '观望', avoid: '回避', alert: '警惕',
  }
  return map[String(action ?? '').toLowerCase()] ?? textOf(advice) ?? ''
}

export function normalizeStock(item = {}) {
  const code = textOf(item.stock_code, item.code, item.display_code)
  return {
    id: item.id ?? item.record_id ?? null,
    reportId: item.report_id ?? item.record_id ?? item.id ?? null,
    code,
    dsaCode: toDsaCode(code),
    name: textOf(item.stock_name, item.name, item.alias, code),
    reportType: textOf(item.report_type) || 'detailed',
    score: numberOrNull(item.sentiment_score ?? item.score),
    advice: textOf(item.operation_advice, item.advice),
    action: textOf(item.action).toLowerCase(),
    actionLabel: textOf(item.action_label) || actionLabel(item.action, item.operation_advice ?? item.advice),
    trend: textOf(item.trend_prediction, item.trend),
    summary: textOf(item.analysis_summary, item.summary),
    analyzedAt: textOf(item.last_analysis_time, item.created_at, item.analyzed_at),
    model: textOf(item.model_used, item.model),
    marketPhase: textOf(item.market_phase_summary),
    analysisCount: numberOrNull(item.analysis_count),
  }
}

export function normalizeTask(item = {}) {
  const status = textOf(item.status, item.state).toLowerCase()
  return {
    id: textOf(item.task_id, item.id, item.query_id),
    code: textOf(item.stock_code, item.code),
    status,
    progress: numberOrNull(item.progress),
    message: textOf(item.message, item.detail),
    createdAt: textOf(item.created_at),
  }
}

function taskIdsOf(payload) {
  const tasks = itemsOf(payload)
  const ids = []
  for (const task of tasks) {
    const id = textOf(task?.task_id, task?.id)
    if (id) ids.push(id)
  }
  const single = textOf(payload?.task_id)
  if (single) ids.push(single)
  for (const id of Array.isArray(payload?.task_ids) ? payload.task_ids : []) {
    if (id) ids.push(String(id))
  }
  return [...new Set(ids)]
}

export function createDsaClient({ fetchImpl = globalThis.fetch, getConfig = () => ({}) } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('DSA client needs fetch')

  const baseUrl = () => normalizeBaseUrl(getConfig().analysisBaseUrl)
  const cookie = () => String(getConfig().analysisAuthCookie ?? '').trim()

  async function request(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const cookieValue = cookie()
    if (cookieValue) headers.cookie = cookieValue
    let response
    try {
      response = await fetchImpl(`${baseUrl()}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeout) : undefined,
      })
    } catch (error) {
      throw new DsaError(`DSA 不可达：${error?.message ?? error}`)
    }
    const raw = await response.text().catch(() => '')
    let data = null
    if (raw) {
      try { data = JSON.parse(raw) } catch { data = raw }
    }
    if (!response.ok) {
      const message = textOf(data?.detail?.message, data?.detail, data?.error, data?.message, raw)
      throw new DsaError(message || `DSA HTTP ${response.status}`, { status: response.status, data })
    }
    return data
  }

  return {
    baseUrl,
    async health() {
      return request('/api/health')
    },
    async stocks(limit = 200) {
      const payload = await request(`/api/v1/history/stocks?limit=${Math.max(1, Math.min(500, Number(limit) || 200))}`)
      return itemsOf(payload).map(normalizeStock)
    },
    async history({ page = 0, pageSize = 20, stockCode = '', startDate = '' } = {}) {
      const query = new URLSearchParams()
      query.set('page', String(Math.max(1, (Number(page) || 0) + 1)))
      query.set('limit', String(Math.max(1, Math.min(100, Number(pageSize) || 20))))
      if (stockCode) query.set('stock_code', toDsaCode(stockCode))
      if (startDate) query.set('start_date', startDate)
      const payload = await request(`/api/v1/history?${query}`)
      return { items: itemsOf(payload).map(normalizeStock), total: numberOrNull(payload?.total) }
    },
    async detail(id) {
      return request(`/api/v1/history/${encodeURIComponent(String(id))}`)
    },
    async markdown(id) {
      const payload = await request(`/api/v1/history/${encodeURIComponent(String(id))}/markdown`)
      return typeof payload === 'string' ? payload : textOf(payload?.markdown, payload?.content, payload?.text)
    },
    async news(id) {
      const payload = await request(`/api/v1/history/${encodeURIComponent(String(id))}/news`)
      return itemsOf(payload)
    },
    async analyze(codes, { reportType = 'detailed', forceRefresh = false, skills = [] } = {}) {
      const normalized = [...new Set((Array.isArray(codes) ? codes : [codes]).map(toDsaCode).filter(Boolean))]
      if (normalized.length === 0) throw new Error('没有可分析的股票代码')
      if (normalized.length > MAX_BATCH) throw new Error(`单次最多分析 ${MAX_BATCH} 只股票`)
      const body = {
        stock_codes: normalized,
        report_type: ['simple', 'detailed', 'brief'].includes(reportType) ? reportType : 'detailed',
        force_refresh: forceRefresh === true,
        async_mode: true,
        // Never let a panel click push to WeCom/Feishu/Telegram/etc.
        notify: false,
      }
      if (Array.isArray(skills) && skills.length > 0) body.skills = skills
      const payload = await request('/api/v1/analysis/analyze', { method: 'POST', body })
      return {
        accepted: Boolean(payload),
        taskIds: taskIdsOf(payload),
        tasks: itemsOf(payload).map(normalizeTask),
        raw: payload,
      }
    },
    async tasks() {
      const payload = await request('/api/v1/analysis/tasks')
      return itemsOf(payload).map(normalizeTask)
    },
    async marketReview() {
      const payload = await request('/api/v1/analysis/market-review', { method: 'POST', body: { notify: false } })
      return { taskIds: taskIdsOf(payload), raw: payload }
    },
    async systemConfig() {
      return request('/api/v1/system/config')
    },
    async syncStockList(codes) {
      const normalized = [...new Set((Array.isArray(codes) ? codes : [codes]).map(toDsaCode).filter(Boolean))]
      if (normalized.length === 0) throw new Error('养鱼自选股为空，无法同步到 DSA')
      const config = await this.systemConfig()
      const version = textOf(config?.config_version)
      if (!version) throw new Error('DSA 配置缺少 config_version，无法同步自选股')
      return request('/api/v1/system/config', {
        method: 'PUT',
        body: {
          config_version: version,
          mask_token: textOf(config?.mask_token) || '******',
          reload_now: true,
          items: [{ key: 'STOCK_LIST', value: normalized.join(',') }],
        },
      })
    },
    async chat(message, sessionId = '') {
      const body = { message: String(message ?? '') }
      if (sessionId) body.session_id = sessionId
      return request('/api/v1/agent/chat', { method: 'POST', body, timeout: 120000 })
    },
  }
}

export { DEFAULT_BASE_URL, MAX_BATCH }
