// IP-locked current weather for the idle bubble.
//
// Two key-less public services keep setup at zero:
//   * ipwho.is gives the public-IP city and coordinates;
//   * Open-Meteo gives the current temperature / WMO weather code and also
//     geocodes an optional manual city.
//
// The city is cached with the weather for the refresh interval, so a laptop
// that changes networks keeps a stable label until the next successful lookup.

const IP_URL = 'https://ipwho.is/'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'

const WEATHER_CODES = new Map([
  [0, '晴'],
  [1, '大部晴朗'],
  [2, '多云'],
  [3, '阴'],
  [45, '雾'],
  [48, '雾凇'],
  [51, '毛毛雨'],
  [53, '毛毛雨'],
  [55, '毛毛雨'],
  [56, '冻雨'],
  [57, '冻雨'],
  [61, '小雨'],
  [63, '中雨'],
  [65, '大雨'],
  [66, '冻雨'],
  [67, '冻雨'],
  [71, '小雪'],
  [73, '中雪'],
  [75, '大雪'],
  [77, '雪粒'],
  [80, '阵雨'],
  [81, '阵雨'],
  [82, '强阵雨'],
  [85, '阵雪'],
  [86, '强阵雪'],
  [95, '雷雨'],
  [96, '雷雨冰雹'],
  [99, '强雷雨冰雹'],
])

export function weatherLabel(code) {
  const value = Number(code)
  return WEATHER_CODES.get(value) ?? '多云'
}

function clampMinutes(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 30
  return Math.min(180, Math.max(5, Math.round(parsed)))
}

function formatTemperature(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed)
}

export function formatWeatherLine(city, condition, temperature) {
  const place = String(city ?? '').trim()
  const weather = String(condition ?? '').trim()
  const temp = formatTemperature(temperature)
  if (!place || !weather) return ''
  return temp === null ? `${place}：${weather}` : `${place}：${weather} ${temp}°C`
}

export function createWeatherService({
  fetchImpl = globalThis.fetch,
  logger = console,
  onChange = () => {},
  intervalMinutes = 30,
} = {}) {
  let enabled = false
  let cityOverride = ''
  let refreshMinutes = clampMinutes(intervalMinutes)
  let timer = null
  let controller = null
  let generation = 0
  let busy = false
  let lastSnapshot = null
  let lastLine = ''
  let disposed = false

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer.unref?.()
    }
    timer = null
  }

  const requestJson = async (url, signal) => {
    const response = await fetchImpl(url, { signal, headers: { 'user-agent': 'dsh-dafeiyu-jinrong weather' } })
    if (!response.ok) throw new Error(`weather HTTP ${response.status}`)
    return response.json()
  }

  const locate = async (signal) => {
    if (cityOverride) {
      const query = new URLSearchParams({
        name: cityOverride,
        count: '1',
        language: 'zh',
        format: 'json',
      })
      const result = await requestJson(`${GEOCODE_URL}?${query}`, signal)
      const first = Array.isArray(result?.results) ? result.results[0] : null
      if (!first || !Number.isFinite(Number(first.latitude)) || !Number.isFinite(Number(first.longitude))) {
        throw new Error(`weather city not found: ${cityOverride}`)
      }
      return {
        city: String(first.name || cityOverride),
        latitude: Number(first.latitude),
        longitude: Number(first.longitude),
      }
    }
    const result = await requestJson(IP_URL, signal)
    if (!result || result.success === false) throw new Error('weather IP lookup failed')
    if (!Number.isFinite(Number(result.latitude)) || !Number.isFinite(Number(result.longitude))) {
      throw new Error('weather IP lookup returned no coordinates')
    }
    return {
      city: String(result.city || result.region || result.country || '本地'),
      latitude: Number(result.latitude),
      longitude: Number(result.longitude),
    }
  }

  const publish = (snapshot) => {
    if (disposed || !enabled) return
    lastSnapshot = snapshot
    onChange(snapshot)
  }

  const refresh = async () => {
    if (!enabled || disposed || busy) return
    busy = true
    const token = ++generation
    controller = new AbortController()
    const signal = controller.signal
    try {
      const place = await locate(signal)
      const query = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current: 'temperature_2m,weather_code',
        timezone: 'auto',
      })
      const forecast = await requestJson(`${FORECAST_URL}?${query}`, signal)
      if (token !== generation) return
      const current = forecast?.current ?? {}
      const condition = weatherLabel(current.weather_code)
      const line = formatWeatherLine(place.city, condition, current.temperature_2m)
      if (!line) throw new Error('weather returned no line')
      lastLine = line
      publish({
        line,
        city: place.city,
        condition,
        temperature: formatTemperature(current.temperature_2m),
        updatedAt: Date.now(),
      })
    } catch (error) {
      if (token === generation && !signal.aborted) {
        logger.warn?.(`dafeiyu weather: ${error instanceof Error ? error.message : String(error)}`)
        if (!lastLine) publish(null)
      }
    } finally {
      if (token === generation) {
        busy = false
        controller = null
        if (enabled && !disposed) {
          clearTimer()
          timer = setTimeout(() => void refresh(), refreshMinutes * 60_000)
          timer.unref?.()
        }
      }
    }
  }

  const stop = () => {
    enabled = false
    cleared()
  }

  const cleared = () => {
    generation += 1
    clearTimer()
    controller?.abort()
    controller = null
    busy = false
  }

  return {
    get snapshot() {
      return lastSnapshot
    },
    get line() {
      return lastLine
    },
    configure(next = {}) {
      const nextEnabled = next.weatherEnabled === true
      const nextCity = String(next.weatherCity ?? '').trim()
      const nextMinutes = clampMinutes(next.weatherRefreshMinutes)
      const changed = nextEnabled !== enabled || nextCity !== cityOverride || nextMinutes !== refreshMinutes
      enabled = nextEnabled
      cityOverride = nextCity
      refreshMinutes = nextMinutes
      if (!enabled) {
        cleared()
        onChange(null)
        lastSnapshot = null
        lastLine = ''
        return
      }
      if (!changed && (timer || busy)) return
      cleared()
      lastLine = ''
      void refresh()
    },
    refresh: () => refresh(),
    stop: () => {
      stop()
    },
  }
}
