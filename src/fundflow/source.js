// Daily core-ETF share monitor used by the Studio analysis dashboard.
//
// Tushare's fund_share is the primary source because it covers both SSE and
// SZSE ETFs for a date range in one request per fund. Values are reported in
// 10k shares (万份); the UI and this module expose 亿份 (100m shares).

export const FUNDFLOW_ETFS = Object.freeze([
  { code: '510300.SH', display: '510300', name: '沪深300', short: '沪深300' },
  { code: '510050.SH', display: '510050', name: '上证50', short: '上证50' },
  { code: '159915.SZ', display: '159915', name: '创业板', short: '创业板' },
  { code: '588000.SH', display: '588000', name: '科创50', short: '科创50' },
  { code: '510500.SH', display: '510500', name: '中证500', short: '中证500' },
])

const TUSHARE_URL = 'https://api.tushare.pro'
const DEFAULT_DAYS = 90

function ymd(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function isoFromYmd(value) {
  const text = String(value ?? '')
  if (!/^\d{8}$/.test(text)) return ''
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
}

function number(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

async function tushare(token, apiName, params, fields, fetchImpl) {
  const response = await fetchImpl(TUSHARE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token, params, fields }),
    signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(20000) : undefined,
  })
  if (!response.ok) throw new Error(`Tushare HTTP ${response.status}`)
  const payload = await response.json()
  if (payload?.code !== 0) throw new Error(payload?.msg || `Tushare code ${payload?.code}`)
  const fieldsList = payload?.data?.fields ?? []
  const items = payload?.data?.items ?? []
  return items.map((row) => Object.fromEntries(fieldsList.map((key, index) => [key, row[index]])))
}

export async function fetchFundFlow({
  token,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  days = DEFAULT_DAYS,
} = {}) {
  if (!String(token ?? '').trim()) throw new Error('未配置 Tushare Token')
  if (typeof fetchImpl !== 'function') throw new Error('缺少 fetch 实现')
  const current = new Date(now())
  const start = new Date(current)
  // Query a little more than the visible window so the first normalized point
  // is available even around holidays.
  start.setDate(start.getDate() - Math.max(1, days) - 15)
  const startDate = ymd(start)
  const endDate = ymd(current)
  const rowsByCode = new Map()
  const errors = []
  for (const etf of FUNDFLOW_ETFS) {
    try {
      const rows = await tushare(token, 'fund_share', {
        ts_code: etf.code,
        start_date: startDate,
        end_date: endDate,
      }, 'ts_code,trade_date,fd_share', fetchImpl)
      rowsByCode.set(etf.code, rows)
    } catch (error) {
      errors.push(`${etf.name}: ${error?.message ?? error}`)
    }
  }
  const series = buildFundFlow(rowsByCode, { now: now(), days })
  if (errors.length > 0) series.warnings = errors
  if (series.dates.length === 0) {
    throw new Error(errors.length ? `ETF 份额获取失败：${errors.join('；')}` : 'ETF 份额为空')
  }
  return series
}

/**
 * Turn Tushare rows into a date-aligned, 亿份-normalized series.
 * Kept pure so tests can use a fixed clock and fixed rows.
 */
export function buildFundFlow(rowsByCode, { now = Date.now(), days = DEFAULT_DAYS } = {}) {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - Math.max(1, days))
  const cutoffIso = isoFromYmd(ymd(cutoff))
  const byDate = new Map()
  const rows = new Map()
  for (const etf of FUNDFLOW_ETFS) {
    const list = Array.isArray(rowsByCode?.get?.(etf.code)) ? rowsByCode.get(etf.code) : []
    const points = []
    for (const row of list) {
      const date = isoFromYmd(row?.trade_date)
      if (!date || date < cutoffIso) continue
      const value = number(row?.fd_share)
      if (value === null) continue
      points.push({ date, value: Number((value / 10000).toFixed(4)) })
    }
    points.sort((a, b) => a.date.localeCompare(b.date))
    rows.set(etf.code, points)
    for (const point of points) {
      if (!byDate.has(point.date)) byDate.set(point.date, {})
      byDate.get(point.date)[etf.code] = point.value
    }
  }
  const dates = [...byDate.keys()].sort()
  const total = dates.map((date) => {
    const row = byDate.get(date)
    const values = FUNDFLOW_ETFS.map((etf) => row[etf.code]).filter((value) => Number.isFinite(value))
    return {
      date,
      value: values.length === FUNDFLOW_ETFS.length
        ? Number(values.reduce((sum, value) => sum + value, 0).toFixed(4))
        : null,
      coverage: values.length,
    }
  })
  const etfSeries = {}
  const normalized = {}
  const latest = {}
  for (const etf of FUNDFLOW_ETFS) {
    const points = rows.get(etf.code) ?? []
    etfSeries[etf.code] = dates.map((date) => {
      const value = byDate.get(date)?.[etf.code]
      return { date, value: Number.isFinite(value) ? value : null }
    })
    const first = points.find((point) => Number.isFinite(point.value))
    normalized[etf.code] = etfSeries[etf.code].map((point) => ({
      date: point.date,
      value: first && Number.isFinite(point.value) ? Number(((point.value / first.value) * 100).toFixed(2)) : null,
    }))
    const last = points[points.length - 1]
    const previous = points[points.length - 2]
    latest[etf.code] = last ? {
      date: last.date,
      value: last.value,
      previous: previous?.value ?? null,
      delta: previous ? Number((last.value - previous.value).toFixed(4)) : null,
      normalized: first ? Number(((last.value / first.value) * 100).toFixed(2)) : null,
    } : null
  }
  const latestDate = dates[dates.length - 1] ?? ''
  const latestTotal = total[total.length - 1] ?? null
  const previousTotal = total[total.length - 2] ?? null
  return {
    source: 'Tushare fund_share',
    unit: '亿份',
    updatedAt: new Date(now).toISOString(),
    latestDate,
    dates,
    etfs: FUNDFLOW_ETFS,
    total,
    etfsSeries: etfSeries,
    normalized,
    latest,
    latestTotal,
    latestTotalDelta: latestTotal && previousTotal && Number.isFinite(previousTotal.value)
      ? Number((latestTotal.value - previousTotal.value).toFixed(4))
      : null,
    days,
  }
}

export { DEFAULT_DAYS, TUSHARE_URL }
