// Price threshold alerts.
//
// Two rules keep this usable in a real session:
//  * a threshold only fires when the price *crosses* it. Firing on "is above"
//    would re-trigger every poll while the price sits just past the line, and
//    firing on the first sample would greet the user with an alert the moment
//    they open the app.
//  * each (code, kind) pair has an independent cooldown.

export const ALERT_KIND = Object.freeze({ ABOVE: 'above', BELOW: 'below' })

function positive(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Keep only rules that actually ask for an alert. */
export function normalizeRules(list) {
  if (!Array.isArray(list)) return []
  const rules = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const code = String(entry.code ?? '').trim()
    if (!code) continue
    const above = positive(entry.above)
    const below = positive(entry.below)
    if (above === null && below === null) continue
    rules.push({
      code,
      alias: String(entry.alias ?? '').trim(),
      above,
      below,
    })
  }
  return rules
}

export function createAlertEngine({ cooldownMs = 300_000, now = () => Date.now() } = {}) {
  const lastPrices = new Map()
  const lastFired = new Map()
  let rules = []

  const keyOf = (code, kind) => `${code}:${kind}`

  return {
    get rules() {
      return rules
    },
    configure(next) {
      rules = normalizeRules(next)
      // Keep prices for codes that are still watched; drop the rest so a
      // re-added code starts from a clean baseline instead of firing instantly.
      const watched = new Set(rules.map((rule) => rule.code))
      for (const code of [...lastPrices.keys()]) {
        if (!watched.has(code)) lastPrices.delete(code)
      }
    },
    reset() {
      lastPrices.clear()
      lastFired.clear()
    },
    /**
     * @param {Map<string,{price:number}>} quotes
     * @returns {Array<{code:string,alias:string,kind:string,price:number,threshold:number}>}
     */
    update(quotes, at = now()) {
      const events = []
      const byCode = new Map(rules.map((rule) => [rule.code, rule]))
      for (const [code, quote] of quotes ?? []) {
        const rule = byCode.get(code)
        if (!rule) continue
        const price = Number(quote?.price)
        if (!Number.isFinite(price) || price <= 0) continue
        const previous = lastPrices.get(code)
        lastPrices.set(code, price)
        if (previous === undefined || previous === price) continue

        for (const kind of [ALERT_KIND.ABOVE, ALERT_KIND.BELOW]) {
          const threshold = kind === ALERT_KIND.ABOVE ? rule.above : rule.below
          if (threshold === null || threshold === undefined) continue
          const crossed = kind === ALERT_KIND.ABOVE
            ? previous < threshold && price >= threshold
            : previous > threshold && price <= threshold
          if (!crossed) continue
          const firedKey = keyOf(code, kind)
          const firedAt = lastFired.get(firedKey) ?? -Infinity
          if (at - firedAt < cooldownMs) continue
          lastFired.set(firedKey, at)
          events.push({
            code,
            alias: rule.alias || quote?.name || code,
            kind,
            price,
            threshold,
          })
        }
      }
      return events
    },
  }
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1000) return value.toFixed(2)
  if (Math.abs(value) >= 1) return value.toFixed(2)
  return value.toFixed(4)
}

/**
 * Collapse several crossings into one bubble. A batch of watchlist names moving
 * together is one piece of news, not five notifications.
 */
export function formatAlert(events) {
  const list = Array.isArray(events) ? events : []
  if (list.length === 0) return null
  if (list.length === 1) {
    const event = list[0]
    const direction = event.kind === ALERT_KIND.ABOVE ? '涨过' : '跌破'
    return {
      title: `${event.alias} ${direction} ${formatPrice(event.threshold)}`,
      detail: `现价 ${formatPrice(event.price)} · 仅供参考`,
      state: event.kind === ALERT_KIND.ABOVE ? 'SUCCESS' : 'ERROR',
      codes: [event.code],
    }
  }
  const upCount = list.filter((event) => event.kind === ALERT_KIND.ABOVE).length
  const downCount = list.length - upCount
  const parts = []
  if (downCount > 0) parts.push(`${downCount} 只跌破下限`)
  if (upCount > 0) parts.push(`${upCount} 只涨过上限`)
  return {
    title: parts.join('，') || `${list.length} 条提醒`,
    detail: `${list.slice(0, 3).map((event) => `${event.alias} ${formatPrice(event.price)}`).join(' · ')}${list.length > 3 ? ' …' : ''}`,
    state: downCount >= upCount ? 'ERROR' : 'SUCCESS',
    codes: list.map((event) => event.code),
  }
}
