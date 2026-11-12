import assert from 'node:assert/strict'
import test from 'node:test'
import { createWeatherService, formatWeatherLine, weatherLabel } from '../src/weather.js'

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value }
}

test('weather codes and line formatting are human readable', () => {
  assert.equal(weatherLabel(0), '晴')
  assert.equal(weatherLabel(61), '小雨')
  assert.equal(weatherLabel(999), '多云')
  assert.equal(formatWeatherLine('杭州', '多云', 26.4), '杭州：多云 26°C')
  assert.equal(formatWeatherLine('杭州', '多云', null), '杭州：多云')
})

test('weather service resolves the IP city and publishes the current weather', async () => {
  const calls = []
  const snapshots = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).startsWith('https://ipwho.is/')) {
      return jsonResponse({ success: true, city: '杭州', latitude: 30.27, longitude: 120.15 })
    }
    return jsonResponse({ current: { temperature_2m: 26.4, weather_code: 2 } })
  }
  const service = createWeatherService({ fetchImpl, onChange: (value) => snapshots.push(value), intervalMinutes: 30 })
  service.configure({ weatherEnabled: true, weatherRefreshMinutes: 30 })
  for (let i = 0; i < 20 && snapshots.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  service.stop()
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].line, '杭州：多云 26°C')
  assert.equal(snapshots[0].city, '杭州')
  assert.equal(snapshots[0].condition, '多云')
  assert.equal(snapshots[0].temperature, 26)
  assert.ok(calls.some((url) => url.includes('api.open-meteo.com')))
})

test('a manual city is geocoded and an empty city falls back to the IP', async () => {
  const calls = []
  const snapshots = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('geocoding-api.open-meteo.com')) {
      return jsonResponse({ results: [{ name: '杭州', latitude: 30.27, longitude: 120.15 }] })
    }
    if (String(url).startsWith('https://ipwho.is/')) {
      return jsonResponse({ success: true, city: 'Tokyo', latitude: 35.68, longitude: 139.69 })
    }
    return jsonResponse({ current: { temperature_2m: 18, weather_code: 3 } })
  }
  const service = createWeatherService({ fetchImpl, onChange: (value) => snapshots.push(value), intervalMinutes: 30 })
  service.configure({ weatherEnabled: true, weatherCity: '杭州', weatherRefreshMinutes: 30 })
  for (let i = 0; i < 20 && snapshots.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  service.stop()
  assert.equal(snapshots[0].line, '杭州：阴 18°C')
  assert.ok(calls.some((url) => url.includes('geocoding-api.open-meteo.com')))
  assert.ok(!calls.some((url) => url.startsWith('https://ipwho.is/')))
})

test('weather failure does not throw and reports an empty snapshot', async () => {
  const snapshots = []
  const service = createWeatherService({
    fetchImpl: async () => { throw new Error('offline') },
    onChange: (value) => snapshots.push(value),
    logger: { warn() {} },
  })
  service.configure({ weatherEnabled: true })
  for (let i = 0; i < 20 && snapshots.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  service.stop()
  assert.equal(snapshots.at(-1), null)
})
