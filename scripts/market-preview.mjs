// Dev preview: drive the market monitor once against live data and print the
// messages it would hand to the pet. Useful for checking that a market is
// scoring sensibly without installing the plugin.
//
//   node scripts/market-preview.mjs [a|hk|us]

import { createMarketMonitor } from '../src/market/index.js'

const focus = ['a', 'hk', 'us'].includes(process.argv[2]) ? process.argv[2] : 'a'

const config = {
  marketEnabled: true,
  marketFocus: focus,
  marketPollSeconds: 5,
  marketAlertCooldown: 300,
  marketWatchlist: [
    { code: 'sh600519', alias: '茅台', above: 1500, below: 1400 },
    { code: 'hk00700', alias: '腾讯', above: 0, below: 0 },
    { code: 'usAAPL', alias: '苹果', above: 0, below: 0 },
  ],
}

const messages = []
const monitor = createMarketMonitor({
  getConfig: () => config,
  send: (message) => messages.push(message),
  logger: { warn: (line) => console.warn('[warn]', line) },
})

monitor.start()
await monitor.tickNow()
monitor.stop()

for (const message of messages) {
  console.log(JSON.stringify(message, null, 2))
}
if (messages.length === 0) {
  console.log('no message: the market may be closed and the feed returned nothing yet')
}
console.log('--- snapshot ---')
console.log(monitor.snapshot ? {
  at: new Date(monitor.snapshot.at).toISOString(),
  score: Number(monitor.snapshot.score.toFixed(1)),
  mood: monitor.snapshot.mood,
} : null)
