import test from 'node:test'
import assert from 'node:assert/strict'

import { createAlertEngine, formatAlert, normalizeRules } from '../src/market/alerts.js'

const quote = (price, name = '') => ({ price, name })

test('normalizeRules keeps only rules that can fire', () => {
  const rules = normalizeRules([
    { code: 'sh600519', above: 1700, below: 1500 },
    { code: 'hk00700', above: 0, below: 0 },
    { code: '' },
    null,
  ])
  assert.equal(rules.length, 1)
  assert.equal(rules[0].above, 1700)
  assert.equal(rules[0].below, 1500)
  assert.deepEqual(normalizeRules('nope'), [])
})

test('a threshold fires on a crossing, not on a level', () => {
  let at = 0
  const engine = createAlertEngine({ cooldownMs: 300_000, now: () => at })
  engine.configure([{ code: 'sh600519', alias: '茅台', above: 1700 }])

  // First sample establishes the baseline and must stay silent.
  assert.deepEqual(engine.update(new Map([['sh600519', quote(1690, '贵州茅台')]]), at), [])

  // Still below: no crossing.
  at += 10_000
  assert.deepEqual(engine.update(new Map([['sh600519', quote(1695, '贵州茅台')]]), at), [])

  // Crosses 1700.
  at += 10_000
  const events = engine.update(new Map([['sh600519', quote(1702, '贵州茅台')]]), at)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'above')
  assert.equal(events[0].alias, '茅台')
  assert.equal(events[0].threshold, 1700)

  // Stays above: must not repeat.
  at += 10_000
  assert.deepEqual(engine.update(new Map([['sh600519', quote(1710, '贵州茅台')]]), at), [])
})

test('a downward crossing fires the lower rule', () => {
  let at = 0
  const engine = createAlertEngine({ cooldownMs: 300_000, now: () => at })
  engine.configure([{ code: 'hk00700', alias: '腾讯', below: 400 }])
  engine.update(new Map([['hk00700', quote(410)]]), at)
  at += 5_000
  const events = engine.update(new Map([['hk00700', quote(399)]]), at)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'below')
})

test('the cooldown suppresses a re-cross inside the window', () => {
  let at = 0
  const engine = createAlertEngine({ cooldownMs: 60_000, now: () => at })
  engine.configure([{ code: 'usAAPL', above: 340 }])
  engine.update(new Map([['usAAPL', quote(330)]]), at)
  at += 1_000
  assert.equal(engine.update(new Map([['usAAPL', quote(345)]]), at).length, 1)

  // Fall back below and cross again inside the cooldown.
  at += 10_000
  engine.update(new Map([['usAAPL', quote(330)]]), at)
  at += 10_000
  assert.equal(engine.update(new Map([['usAAPL', quote(345)]]), at).length, 0)

  // After the cooldown the same crossing is allowed again.
  at += 60_000
  engine.update(new Map([['usAAPL', quote(330)]]), at)
  at += 1_000
  assert.equal(engine.update(new Map([['usAAPL', quote(345)]]), at).length, 1)
})

test('removing a code resets its baseline', () => {
  let at = 0
  const engine = createAlertEngine({ cooldownMs: 0, now: () => at })
  engine.configure([{ code: 'sh600519', above: 1700 }])
  engine.update(new Map([['sh600519', quote(1600)]]), at)
  engine.configure([])
  engine.configure([{ code: 'sh600519', above: 1700 }])
  // Re-added while already above: no crossing yet, so nothing fires.
  at += 1_000
  assert.deepEqual(engine.update(new Map([['sh600519', quote(1750)]]), at), [])
})

test('formatAlert collapses a batch into one bubble', () => {
  assert.equal(formatAlert([]), null)

  const single = formatAlert([{ code: 'sh600519', alias: '茅台', kind: 'above', price: 1705, threshold: 1700 }])
  assert.match(single.title, /涨过/)
  assert.equal(single.state, 'SUCCESS')

  const batch = formatAlert([
    { code: 'a', alias: '甲', kind: 'below', price: 9, threshold: 10 },
    { code: 'b', alias: '乙', kind: 'below', price: 8, threshold: 9 },
    { code: 'c', alias: '丙', kind: 'above', price: 21, threshold: 20 },
  ])
  assert.match(batch.title, /2 只跌破下限/)
  assert.match(batch.title, /1 只涨过上限/)
  assert.equal(batch.state, 'ERROR')
})
