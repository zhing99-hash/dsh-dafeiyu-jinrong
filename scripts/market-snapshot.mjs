// Render one live market bubble to a PNG, without DSH.
//
//   node scripts/market-snapshot.mjs [a|hk|us] [out.png]
//
// Spawns the packaged Qt Helper exactly the way the plugin does, feeds it the
// message the market monitor produced, and lets the Helper save a snapshot.
// Useful for eyeballing the bubble (text length, elision, colour) after a
// change to mood copy.

import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMarketMonitor } from '../src/market/index.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const focus = ['a', 'hk', 'us'].includes(process.argv[2]) ? process.argv[2] : 'a'
const out = resolve(process.argv[3] ?? join(projectRoot, '.build', `market-${focus}.png`))
const executable = join(projectRoot, 'runtime', 'bin', 'win32-x64', 'dsh-dafeiyu-helper.exe')
const timeoutMs = 20_000

const temp = process.env.DSH_DAFEIYU_TMP
  ?? join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.', 'dsh-dafeiyu', 'tmp')
await mkdir(temp, { recursive: true })
await mkdir(dirname(out), { recursive: true })

const messages = []
const monitor = createMarketMonitor({
  getConfig: () => ({
    marketEnabled: true,
    marketFocus: focus,
    marketPollSeconds: 5,
    marketAlertCooldown: 300,
    marketWatchlist: [
      { code: 'sh600519', alias: '茅台', above: 0, below: 0 },
      { code: 'hk00700', alias: '腾讯', above: 0, below: 0 },
      { code: 'usAAPL', alias: '苹果', above: 0, below: 0 },
    ],
  }),
  send: (message) => messages.push(message),
  logger: { warn: (line) => console.warn('[warn]', line) },
})

monitor.start()
await monitor.tickNow()
monitor.stop()

const stateMessage = messages.find((message) => message.__alert !== true) ?? messages[0]
if (!stateMessage) {
  console.error('no market message: feed returned nothing (closed market?)')
  process.exit(1)
}

const child = spawn(executable, ['--snapshot', out], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, TMP: temp, TEMP: temp },
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const deadline = Date.now() + timeoutMs
let ready = false
while (Date.now() < deadline && !ready) {
  if (child.exitCode !== null) throw new Error(`helper exited early (${child.exitCode}): ${stderr}`)
  ready = stdout.split(/\r?\n/).some((line) => line.includes('"ready"'))
  await delay(100)
}
if (!ready) {
  child.kill()
  throw new Error(`helper never became ready: ${stderr}`)
}

// The ready line is printed before Qt's event loop drains stdin; a message
// written in the same tick is occasionally dropped, so give the window a beat.
await delay(3000)

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
// One message only: the Helper arms its diagnostic frame on the first state
// message and grabs 180 ms later, so anything after that is invisible.
send(stateMessage)

let ok = false
while (Date.now() < deadline && !ok) {
  await delay(200)
  try {
    ok = (await stat(out)).size > 1024
  } catch {
    ok = false
  }
}

child.stdin.end(`${JSON.stringify({ protocolVersion: 1, kind: 'shutdown', timestamp: Date.now() })}\n`)
await delay(800)
if (child.exitCode === null) child.kill()

if (!ok) throw new Error(`no snapshot written. stdout=${stdout} stderr=${stderr}`)
console.log(JSON.stringify({ state: stateMessage.state, stage: stateMessage.stage, message: stateMessage.message, detail: stateMessage.detail }, null, 2))
console.log(`snapshot: ${out}`)
