// Market sentiment scoring.
//
// The score is deliberately built from *bounded* transforms instead of
// z-scores: the pet is supposed to react within the first few seconds of a
// session, and a z-score would need 20 days of history before it means
// anything. Each factor maps to 0..1 on its own, then the factors are weighted,
// so a missing factor (Hong Kong has no public breadth feed) only shifts the
// weights instead of producing a wrong number.
//
// Everything here is pure and deterministic. The state gate keeps its own
// mutable history and is the only stateful piece.

export const MOOD_BANDS = Object.freeze([
  { min: 85, key: 'euphoria', label: '亢奋', state: 'SUCCESS' },
  { min: 70, key: 'optimistic', label: '乐观', state: 'WORKING' },
  { min: 45, key: 'calm', label: '平静', state: 'IDLE' },
  { min: 30, key: 'cautious', label: '谨慎', state: 'THINKING' },
  { min: 15, key: 'panic', label: '恐慌', state: 'ERROR' },
  { min: 0, key: 'numb', label: '麻木', state: 'IDLE' },
])

// Feelings only. No forecast, no suggestion, no target price: the product rule
// is "emotion feedback, never advice", and these strings are user-visible.
export const MOOD_COPY = Object.freeze({
  euphoria: ['涨得我尾巴都翘起来了', '今天这盘面，鱼都精神了', '红彤彤的，我游得飞快'],
  optimistic: ['今天红盘，心情不错哦', '有点起色，我盯着呢', '还行还行，比昨天强'],
  calm: ['不涨不跌，我先躺会儿', '平平淡淡才是真', '就这样吧，喝口水'],
  cautious: ['有点不对劲，我尾巴收起来了', '这走势我看不懂，先缩一缩', '我往边边上靠一点'],
  panic: ['好多绿的……我有点腿软', '这盘面我不敢看', '别看我，我躲一下'],
  numb: ['算了，就这样吧', '……', '我已经没有表情了'],
})

export const MOOD_LABELS = Object.freeze({
  euphoria: '亢奋',
  optimistic: '乐观',
  calm: '平静',
  cautious: '谨慎',
  panic: '恐慌',
  numb: '麻木',
})

function clamp01(value) {
  if (!Number.isFinite(value)) return null
  if (value <= 0) return 1e-6
  if (value >= 1) return 1 - 1e-6
  return value
}

function logistic(x) {
  return 1 / (1 + Math.exp(-x))
}

/** 0..1, 0.5 at a flat day; ±1.2% moves a third of the way. */
export function pctFactor(pct) {
  if (!Number.isFinite(pct)) return null
  return clamp01(logistic(pct / 1.2))
}

/** 0..1 around a neutral 1.0x volume ratio. */
export function volumeFactor(ratio) {
  if (!Number.isFinite(ratio)) return null
  return clamp01(0.5 + (ratio - 1) * 0.5)
}

/**
 * Amplitude is a *mild* drag, centred on neutral: no range scores 0.5, a 4%
 * range scores 0. An early-session quote often reports high == low simply
 * because nothing has traded yet, and a full "perfectly calm" bonus would then
 * push a flat market into the optimistic band on no evidence.
 */
export function calmFactor(amplitudePct) {
  if (!Number.isFinite(amplitudePct)) return null
  return clamp01(0.5 - amplitudePct / 8)
}

// No volume factor here on purpose. The quote feed reports index volume in
// units that do not match the daily bars (an index quote is ~5.7e5 while its
// k-line volume is ~4e8), so any ratio built from them is noise. Volume is
// still available for single names, where the units do line up.
const BASE_WEIGHTS = Object.freeze({ pct: 0.55, calm: 0.45 })
const BREADTH_WEIGHTS = Object.freeze({ pct: 0.45, breadth: 0.35, calm: 0.20 })

/**
 * Combine the factors into 0..100.
 * `breadth` is `up / (up + down)` in 0..1, or null when the venue has no feed.
 */
export function scoreMarket({ pct, breadth, amplitudePct } = {}) {
  const factors = {
    pct: pctFactor(pct),
    breadth: Number.isFinite(breadth) ? clamp01(breadth) : null,
    calm: calmFactor(amplitudePct),
  }
  const weights = Number.isFinite(factors.breadth) ? BREADTH_WEIGHTS : BASE_WEIGHTS
  let total = 0
  let weightSum = 0
  for (const [key, weight] of Object.entries(weights)) {
    const factor = factors[key]
    if (factor === null || factor === undefined) continue
    total += factor * weight
    weightSum += weight
  }
  if (weightSum === 0) return { score: 50, factors, weights: null }
  return { score: (total / weightSum) * 100, factors, weights: weightSum }
}

/** Band for a raw score. Index 0 is the most excited band. */
export function classify(score) {
  if (!Number.isFinite(score)) return null
  for (let index = 0; index < MOOD_BANDS.length; index += 1) {
    if (score >= MOOD_BANDS[index].min) {
      return { ...MOOD_BANDS[index], index }
    }
  }
  return { ...MOOD_BANDS[MOOD_BANDS.length - 1], index: MOOD_BANDS.length - 1 }
}

/** Pick a stable line for a mood; `seed` keeps it from changing every tick. */
export function moodLine(moodKey, seed = 0) {
  const lines = MOOD_COPY[moodKey] ?? MOOD_COPY.calm
  const index = Math.abs(Math.trunc(Number(seed) || 0)) % lines.length
  return lines[index]
}

/**
 * Turn raw scores into a stable mood.
 *
 * Without the three guards a pet driven by a live index twitches constantly:
 * EMA removes tick noise, hysteresis stops boundary flapping, and the minimum
 * dwell keeps a band on screen long enough to be read.
 */
export function createMoodTracker({
  alpha = 0.2,
  hysteresis = 5,
  minDwellMs = 30_000,
  initialBand = 2,
  now = () => Date.now(),
} = {}) {
  let smoothed = null
  let band = classify(MOOD_BANDS[initialBand].min)
  // No dwell window before the first reading: a cold start must be able to
  // show the real mood immediately instead of holding "calm" for 30 seconds.
  let changedAt = Number.NEGATIVE_INFINITY

  return {
    get value() {
      return smoothed
    },
    get mood() {
      return band
    },
    reset(at = now()) {
      smoothed = null
      band = classify(MOOD_BANDS[initialBand].min)
      changedAt = at
    },    /**
     * @returns {{score:number, mood:object, changed:boolean, suppressed:boolean}}
     */
    update(score, at = now()) {
      if (!Number.isFinite(score)) {
        return { score: smoothed ?? 50, mood: band, changed: false, suppressed: true }
      }
      if (smoothed === null) {
        // First reading: trust it. A cold start must show the real mood at once
        // instead of holding "calm" for a whole dwell window.
        const first = classify(score)
        const changed = first.index !== band.index
        smoothed = score
        band = first
        changedAt = at
        return { score: smoothed, mood: band, changed, suppressed: false }
      }
      smoothed = alpha * score + (1 - alpha) * smoothed
      const candidate = classify(smoothed)
      if (candidate.index === band.index) {
        return { score: smoothed, mood: band, changed: false, suppressed: false }
      }
      const boundary = Math.max(MOOD_BANDS[band.index].min, MOOD_BANDS[candidate.index].min)
      const farEnough = candidate.index < band.index
        ? smoothed >= boundary + hysteresis
        : smoothed <= boundary - hysteresis
      if (!farEnough || at - changedAt < minDwellMs) {
        return { score: smoothed, mood: band, changed: false, suppressed: true }
      }
      band = candidate
      changedAt = at
      return { score: smoothed, mood: band, changed: true, suppressed: false }
    },
  }
}

/**
 * Per-stock sentiment: three bands only, because a single name is far noisier
 * than an index and six bands would flicker by design.
 */
export function scoreStock({ pct, relativePct, volumeRatio } = {}) {
  const factors = {
    pct: pctFactor(pct),
    relative: Number.isFinite(relativePct) ? clamp01(logistic(relativePct / 1.5)) : null,
    volume: volumeFactor(volumeRatio),
  }
  const weights = { pct: 0.5, relative: 0.3, volume: 0.2 }
  let total = 0
  let weightSum = 0
  for (const [key, weight] of Object.entries(weights)) {
    const factor = factors[key]
    if (factor === null || factor === undefined) continue
    total += factor * weight
    weightSum += weight
  }
  const score = weightSum === 0 ? 50 : (total / weightSum) * 100
  const level = score >= 65 ? 'strong' : score <= 35 ? 'weak' : 'flat'
  return { score, level, factors }
}
