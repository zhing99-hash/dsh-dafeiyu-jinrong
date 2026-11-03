import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MOOD_BANDS,
  classify,
  createMoodTracker,
  moodLine,
  scoreMarket,
  scoreStock,
} from '../src/market/mood.js'

test('a flat day lands near the middle of the scale', () => {
  const { score } = scoreMarket({ pct: 0, breadth: 0.5, amplitudePct: 1.2 })
  assert.ok(score > 45 && score < 65, `expected a middling score, got ${score}`)
})

test('a strong rally scores in the upper bands and a selloff in the lower bands', () => {
  const up = scoreMarket({ pct: 2, breadth: 0.8, amplitudePct: 1.5 })
  const down = scoreMarket({ pct: -2, breadth: 0.2, amplitudePct: 3 })
  assert.ok(up.score > 70, `rally scored ${up.score}`)
  assert.ok(down.score < 30, `selloff scored ${down.score}`)
})

test('a quiet 0.3% move lands near neutral instead of the optimistic band', () => {
  // Early in a session the high/low are often equal, which used to earn a full
  // "calm" bonus and push a flat market to 76.
  const { score } = scoreMarket({ pct: 0.33, breadth: null, amplitudePct: 0 })
  assert.ok(score > 45 && score < 60, `expected near neutral, got ${score}`)
})

test('missing breadth falls back to two factors instead of skewing the score', () => {
  const withBreadth = scoreMarket({ pct: 1.2, breadth: 0.5, amplitudePct: 1 })
  const without = scoreMarket({ pct: 1.2, breadth: null, amplitudePct: 1 })
  assert.ok(Math.abs(withBreadth.score - without.score) < 12)
  assert.equal(without.weights, 1)
})

test('classify maps scores onto the six bands', () => {
  assert.equal(classify(100).key, 'euphoria')
  assert.equal(classify(85).key, 'euphoria')
  assert.equal(classify(84.9).key, 'optimistic')
  assert.equal(classify(70).key, 'optimistic')
  assert.equal(classify(45).key, 'calm')
  assert.equal(classify(30).key, 'cautious')
  assert.equal(classify(15).key, 'panic')
  assert.equal(classify(0).key, 'numb')
  assert.equal(classify(Number.NaN), null)
})

test('moodLine is stable for a seed and always returns a line', () => {
  assert.equal(moodLine('calm', 3), moodLine('calm', 3))
  assert.ok(typeof moodLine('unknown-band', 0) === 'string')
})

test('the tracker refuses to flap at a band boundary', () => {
  const clock = { at: 0 }
  const tracker = createMoodTracker({ alpha: 1, hysteresis: 5, minDwellMs: 0, now: () => clock.at })
  // Start calm (band index 2, lower edge 45).
  tracker.update(50, 0)
  assert.equal(tracker.mood.key, 'calm')
  // 50 is inside the optimistic band but not past its edge plus hysteresis.
  const nudged = tracker.update(50, 1000)
  assert.equal(nudged.changed, false)
  assert.equal(nudged.mood.key, 'calm')
  // 76 clears 70 + 5, so it may switch.
  const up = tracker.update(76, 2000)
  assert.equal(up.changed, true)
  assert.equal(up.mood.key, 'optimistic')
})

test('the tracker holds a band for the minimum dwell time', () => {
  const clock = { at: 0 }
  const tracker = createMoodTracker({ alpha: 1, hysteresis: 5, minDwellMs: 30_000, now: () => clock.at })
  tracker.update(50, 0)
  const early = tracker.update(90, 1000)
  assert.equal(early.changed, false)
  const later = tracker.update(90, 31_000)
  assert.equal(later.changed, true)
  assert.equal(later.mood.key, 'euphoria')
})

test('the tracker smooths instead of following every tick', () => {
  const tracker = createMoodTracker({ alpha: 0.2, hysteresis: 0, minDwellMs: 0, now: () => 0 })
  tracker.update(50, 0)
  const { score } = tracker.update(100, 0)
  assert.ok(score > 50 && score < 100, `expected an intermediate value, got ${score}`)
})

test('scoreStock yields three coarse levels', () => {
  assert.equal(scoreStock({ pct: 5, relativePct: 3, volumeRatio: 2 }).level, 'strong')
  assert.equal(scoreStock({ pct: -5, relativePct: -3, volumeRatio: 2 }).level, 'weak')
  assert.equal(scoreStock({ pct: 0, relativePct: 0, volumeRatio: 1 }).level, 'flat')
  assert.ok(MOOD_BANDS.length === 6)
})
