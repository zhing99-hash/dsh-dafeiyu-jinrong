import { createRequire } from 'node:module'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { CompanionReducer } from './companion-reducer.js'
import { HelperProcess } from './helper-process.js'
import { createSettingsScope } from './settings-scope.js'
import { createHelperLog, defaultHelperLogPath } from './helper-log.js'
import { createUserSettingsStore, defaultUserSettingsPath } from './user-settings.js'
import { resolveClientTarget } from './client-target.js'
import { isLocalRequest, jsonResponse } from './local-http.js'
import { BALANCE_ENDPOINT, createBalanceQuery, createBalanceMonitor, createBalanceHandler, balanceProviderNamespace } from './balance.js'
import { createMarketMonitor } from './market/index.js'
import { createBubbleStore } from './bubble/store.js'
import { createActionsStore, loadClipCatalog } from './actions/store.js'
import { createMemeLibrary } from './memes.js'
import { createCompanionApi } from './companion-api.js'
import { createWeatherService } from './weather.js'
import {
  CompanionMessageKind,
  CompanionState,
  createMessage,
} from './protocol.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

export const name = 'dsh-dafeiyu-jinrong'
// The plugin's feature is built on session events, and mounting requires the
// settings service (used to read live config). Keep the declared inject in
// sync with those real hard dependencies instead of listing a service that
// is never consumed directly.
export const inject = ['sessions', 'settings']
export const CONFIG_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/config'
export const EVENTS_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/events'
export const MARKET_VIEW_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/market-view'
export const BUBBLE_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/bubble'
export const BUBBLE_PREVIEW_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/bubble-preview.png'
export const PREVIEW_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/preview'
export const ACTIONS_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/actions'
export const ACTIONS_PLAY_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/actions/play'
export const MEMES_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/memes'
export const MEME_IMAGE_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/memes/image'
export const MEMES_PICK_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/memes/pick'
export const COMPANION_DIAGNOSTICS_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/companion/diagnostics'
export const MANIFEST_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/manifest'
export const FRAME_ENDPOINT = '/plugins/dsh-dafeiyu-jinrong/frame'
export { BALANCE_ENDPOINT }

const here = dirname(fileURLToPath(import.meta.url))
const assetsRoot = resolve(here, '..', 'assets')
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用桌面大肥鱼'),
  scale: Schema.number().min(0.55).max(1.4).step(0.05).default(1).role('slider').description('角色大小'),
  bubbleScale: Schema.number().min(0.8).max(1.2).step(0.05).default(1).role('slider').description('气泡大小'),
  activityLevel: Schema.union([
    Schema.const('quiet').description('安静'),
    Schema.const('normal').description('标准'),
    Schema.const('lively').description('活泼'),
  ]).default('normal').description('空闲微动作频率'),
  reducedMotion: Schema.boolean().default(false).description('减少走动、循环帧和程序化晃动'),
  soundEnabled: Schema.boolean().default(true).description('任务完成或出错时播放提示音'),
  soundStates: Schema.array(Schema.union([
    Schema.const('SUCCESS').description('对话完成'),
    Schema.const('ERROR').description('工具出错'),
    Schema.const('APPROVAL').description('等待审批'),
  ])).role('checkbox').default(['SUCCESS', 'ERROR']).description('播放提示音与系统通知的场景'),
  bubbleMode: Schema.union([
    Schema.const('always').description('常驻显示'),
    Schema.const('hidden').description('完全隐藏'),
    Schema.const('custom').description('自定义显示状态'),
  ]).default('always').description('气泡显示模式'),
  bubbleStates: Schema.array(Schema.string()).default(['SUCCESS', 'ERROR', 'WAITING']).description('自定义模式下显示气泡的状态'),
  includeSubagents: Schema.boolean().default(false).description('允许子 Agent 抢占宠物状态'),
  memeBattle: Schema.boolean().default(true).description('聊天里出现表情包时，桌宠也回一张（只读，不往聊天里发消息）'),
  webOverlay: Schema.boolean().default(false).description('在 DSH 页面右下角显示轻量桌宠（可与桌面窗口同时开启）'),
  clientTarget: Schema.union(['auto', 'web', 'desktop']).default('auto').description('打开 DSH 的目标客户端（自动识别 WebUI／桌面端）'),
  balanceEnabled: Schema.boolean().default(true).description('在状态气泡和设置页显示 DeepSeek 余额'),
  balanceSource: Schema.union(['auto', 'api-key', 'account']).default('auto').description('余额来源：自动优先 API Key，也可选择已登录账户'),
  marketEnabled: Schema.boolean().default(false).description('启用行情情绪：关闭时桌宠只跟随 DSH 任务'),
  marketFocus: Schema.union([
    Schema.const('a').description('A股（含涨跌家数）'),
    Schema.const('hk').description('港股'),
    Schema.const('us').description('美股'),
  ]).default('a').description('驱动桌宠情绪的主市场'),
  marketWatchlist: Schema.array(Schema.object({
    code: Schema.string().description('代码：sh600519 / hk00700 / usAAPL'),
    alias: Schema.string().description('显示名（留空用行情里的名称）'),
    above: Schema.number().description('高于此价提醒（0 或不填表示不提醒）'),
    below: Schema.number().description('低于此价提醒（0 或不填表示不提醒）'),
  })).default([]).description('自选股与价格提醒'),
  marketPollSeconds: Schema.number().min(3).max(60).step(1).default(5).description('盘中轮询间隔（秒）'),
  marketAlertCooldown: Schema.number().min(60).max(3600).step(30).default(300).description('同一价格提醒的冷却时间（秒）'),
  marketYieldToTask: Schema.boolean().default(true).description('有 DSH 任务进行时让位于任务状态'),
  marketTushareToken: Schema.string().default('').description('Tushare token（可选）：补齐自选股的历史成交量，用来算量比'),
  weatherEnabled: Schema.boolean().default(true).description('空闲气泡显示按 IP 定位的天气'),
  weatherCity: Schema.string().default('').description('天气城市覆盖（留空按 IP 定位）'),
  weatherRefreshMinutes: Schema.number().min(5).max(180).step(5).default(30).description('天气刷新间隔（分钟）'),
  idleTargets: Schema.string().default('09:30 开盘, 15:30 收盘').description('每日倒计时目标，格式：HH:MM 标签，逗号分隔；留空关闭'),
}).description('由 DeepSeek Harness 状态驱动的桌面大肥鱼伴侣')

// Mark fields, rather than the root object: current DSH passes each volatile
// field as a live reference, while the config object remains an object.
for (const [key, field] of Object.entries(Config.dict)) Config.dict[key] = field.volatile()

const defaults = Object.freeze({
  enabled: true,
  scale: 1,
  bubbleScale: 1,
  activityLevel: 'normal',
  reducedMotion: false,
  soundEnabled: true,
  soundStates: ['SUCCESS', 'ERROR'],
  bubbleMode: 'always',
  bubbleStates: ['SUCCESS', 'ERROR', 'WAITING'],
  includeSubagents: false,
  memeBattle: true,
  webOverlay: false,
  clientTarget: 'auto',
  balanceEnabled: true,
  balanceSource: 'auto',
  marketEnabled: false,
  marketFocus: 'a',
  marketWatchlist: [],
  marketPollSeconds: 5,
  marketAlertCooldown: 300,
  marketYieldToTask: true,
  marketTushareToken: '',
  weatherEnabled: true,
  weatherCity: '',
  weatherRefreshMinutes: 30,
  idleTargets: '09:30 开盘, 15:30 收盘',
})

const SOUND_STATES = new Set(['SUCCESS', 'ERROR', 'APPROVAL'])

export function normalizeSoundStates(value) {
  if (!Array.isArray(value)) return [...defaults.soundStates]
  return [...new Set(value.filter((state) => SOUND_STATES.has(state)))]
}

function publicConfig(config = {}) {
  return {
    enabled: config.enabled ?? defaults.enabled,
    scale: config.scale ?? defaults.scale,
    bubbleScale: config.bubbleScale ?? defaults.bubbleScale,
    activityLevel: config.activityLevel ?? defaults.activityLevel,
    reducedMotion: config.reducedMotion ?? defaults.reducedMotion,
    soundEnabled: config.soundEnabled ?? defaults.soundEnabled,
    soundStates: normalizeSoundStates(config.soundStates),
    bubbleMode: config.bubbleMode ?? defaults.bubbleMode,
    bubbleStates: Array.isArray(config.bubbleStates) ? config.bubbleStates : defaults.bubbleStates,
    includeSubagents: config.includeSubagents ?? defaults.includeSubagents,
    memeBattle: config.memeBattle !== false,
    webOverlay: config.webOverlay === true,
    clientTarget: config.clientTarget ?? defaults.clientTarget,
    balanceEnabled: config.balanceEnabled !== false,
    balanceSource: config.balanceSource ?? defaults.balanceSource,
    marketEnabled: config.marketEnabled === true,
    marketFocus: config.marketFocus ?? defaults.marketFocus,
    marketWatchlist: Array.isArray(config.marketWatchlist) ? config.marketWatchlist : defaults.marketWatchlist,
    marketPollSeconds: config.marketPollSeconds ?? defaults.marketPollSeconds,
    marketAlertCooldown: config.marketAlertCooldown ?? defaults.marketAlertCooldown,
    marketYieldToTask: config.marketYieldToTask !== false,
    marketTushareToken: String(config.marketTushareToken ?? defaults.marketTushareToken),
    weatherEnabled: config.weatherEnabled !== false,
    weatherCity: String(config.weatherCity ?? defaults.weatherCity),
    weatherRefreshMinutes: config.weatherRefreshMinutes ?? defaults.weatherRefreshMinutes,
    idleTargets: String(config.idleTargets ?? defaults.idleTargets),
  }
}

async function readPatch(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 8192) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('patch must be an object')
  const allowed = new Set(Object.keys(defaults))
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('patch contains an unknown setting')
  if ('soundStates' in value) {
    if (!Array.isArray(value.soundStates)) throw new Error('soundStates must be an array')
    value.soundStates = normalizeSoundStates(value.soundStates)
  }
  return value
}

export function createConfigHandler(settings) {
  return async (req, res) => {
    if (!isLocalRequest(req)) {
      jsonResponse(res, 403, { error: 'local access only' })
      return
    }
    if (req.method === 'GET') {
      jsonResponse(res, 200, settings.get())
      return
    }
    if (req.method !== 'PATCH') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    if (typeof settings.update !== 'function') {
      jsonResponse(res, 503, { error: 'settings are read-only; restart DSH or use a supported host version' })
      return
    }
    try {
      await settings.update(await readPatch(req))
      jsonResponse(res, 200, settings.get())
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

// Server-sent events channel mirroring the companion protocol for in-page
// consumers (the future web overlay). Snapshot kinds are remembered so a client
// that connects late still renders the current state immediately.
export function createEventStream() {
  const clients = new Set()
  const snapshot = new Map()
  return {
    get clientCount() {
      return clients.size
    },
    broadcast(message) {
      if (message?.kind === 'hello' || message?.kind === 'state' || message?.kind === 'task'
        || message?.kind === 'tasks' || message?.kind === 'config' || message?.kind === 'balance') {
        snapshot.set(message.kind, message)
      }
      const payload = `data: ${JSON.stringify(message)}\n\n`
      for (const res of clients) {
        try {
          res.write(payload)
        } catch {
          clients.delete(res)
        }
      }
    },
    add(res) {
      clients.add(res)
      for (const message of snapshot.values()) {
        res.write(`data: ${JSON.stringify(message)}\n\n`)
      }
      return () => clients.delete(res)
    },
  }
}

export function createEventsHandler(stream) {
  return (req, res) => {
    if (!isLocalRequest(req)) {
      jsonResponse(res, 403, { error: 'local access only' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    const remove = stream.add(res)
    req.on('close', remove)
  }
}

async function readJsonObject(req, limit = 4096) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('body must be an object')
  }
  return value
}

/**
 * One navigation channel for companion panels.
 *
 * GET returns the ordered views and the active index. POST accepts either
 * `{ code }` (preferred — reordering the watchlist cannot point at the wrong
 * stock) or `{ index }`, then repaints the bubble immediately. The endpoint is
 * local-only because it drives the desktop pet.
 */
export function createMarketViewHandler(getMonitor) {
  return async (req, res) => {
    if (!isLocalRequest(req)) {
      jsonResponse(res, 403, { error: 'local access only' })
      return
    }
    const monitor = typeof getMonitor === 'function' ? getMonitor() : undefined
    if (!monitor) {
      jsonResponse(res, 503, { error: 'market view is not running; enable 行情情绪 first' })
      return
    }
    if (req.method === 'GET') {
      jsonResponse(res, 200, monitor.describeView())
      return
    }
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    let body
    try {
      body = await readJsonObject(req)
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const code = typeof body.code === 'string' ? body.code : undefined
    const index = Number.isInteger(body.index) ? body.index : undefined
    if (code === undefined && index === undefined) {
      jsonResponse(res, 400, { error: 'provide { code } or { index }' })
      return
    }
    const view = monitor.selectView({ code, index })
    jsonResponse(res, 200, {
      ...monitor.describeView(),
      selected: view ? { kind: view.kind, code: view.code ?? null, alias: view.alias ?? view.label ?? null } : null,
    })
  }
}

// Frame bytes are served only for paths the manifest declares, so the query
// parameter can never steer the reader outside assets/pet. Returns null when
// the manifest cannot be read; the overlay routes then stay unregistered.
export function createAssetRoutes() {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(assetsRoot, 'pet-manifest.json'), 'utf8'))
  } catch {
    return null
  }
  const frames = new Set()
  for (const clip of Object.values(manifest.clips ?? {})) {
    for (const frame of clip.frames ?? []) frames.add(frame)
  }
  return {
    manifestHandler(req, res) {
      if (!isLocalRequest(req)) {
        jsonResponse(res, 403, { error: 'local access only' })
        return
      }
      jsonResponse(res, 200, manifest)
    },
    frameHandler(req, res) {
      if (!isLocalRequest(req)) {
        jsonResponse(res, 403, { error: 'local access only' })
        return
      }
      let frame
      try {
        frame = new URL(req.url ?? '', 'http://dsh.local').searchParams.get('frame')
      } catch {
        frame = null
      }
      if (!frame || !frames.has(frame)) {
        jsonResponse(res, 404, { error: 'unknown frame' })
        return
      }
      let bytes
      try {
        bytes = readFileSync(join(assetsRoot, 'pet', frame))
      } catch {
        jsonResponse(res, 404, { error: 'frame unavailable' })
        return
      }
      res.writeHead(200, {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=86400',
        'content-length': bytes.length,
      })
      res.end(bytes)
    },
  }
}

function mount(ctx, config = {}, eventCtx = ctx) {
  const logger = ctx.logger ?? console
  try {
    mountCompanion(ctx, config, eventCtx, logger)
  } catch (error) {
    // DSH treats a failing plugin activation as fatal for the whole boot
    // (dsh-app-boot rethrows init rejections). A host-side API change must
    // cost the pet its session, never the host its startup.
    logger.error?.(`dsh-dafeiyu-jinrong failed to activate and stays disabled for this session: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// The host's settings layer is authoritative while it works. The override
// store only fills in fields whose settings.update() write failed, so a
// native menu choice survives a Helper restart on hosts that cannot expose the
// bundle-patch entry (issue #95). A later host-side change clears that field's
// fallback again.
function createEffectiveSettings(host, overrides, logger) {
  const watchers = new Set()
  const current = () => overrides.apply(host.get())
  const announce = () => {
    const next = current()
    for (const callback of watchers) {
      try {
        callback(next)
      } catch (error) {
        logger.warn?.(`dsh-dafeiyu-jinrong failed to deliver settings: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const offHost = host.watch?.(() => announce())
  return {
    namespace: host.namespace,
    describe: host.describe?.bind(host),
    get: current,
    watch(callback) {
      watchers.add(callback)
      return () => watchers.delete(callback)
    },
    ...(typeof host.update === 'function' ? {
      async update(patch) {
        await host.update(patch)
        overrides.clear(Object.keys(patch))
        announce()
      },
    } : {}),
    refresh: announce,
    dispose() {
      offHost?.()
      watchers.clear()
      host.dispose?.()
    },
  }
}

export function eventText(event) {
  const data = event?.data ?? {}
  const parts = []
  const visit = (value) => {
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string') parts.push(value.text)
      if (typeof value.content === 'string') parts.push(value.content)
    }
  }
  visit(data.content)
  visit(data.text)
  visit(data.message?.content)
  visit(data.message?.text)
  return parts.join(' ')
}

export function eventHasImage(event) {
  const content = event?.data?.content ?? event?.data?.message?.content
  if (!Array.isArray(content)) return false
  return content.some((block) => block && typeof block === 'object'
    && (block.type === 'image' || block.image !== undefined || block.attachment !== undefined))
}

function mountCompanion(ctx, config = {}, eventCtx = ctx, logger) {
  const eventStream = createEventStream()
  const helperConfig = config.helper ?? {}
  // `helper.logFile: null` is the explicit test/custom-launch switch used by
  // HelperProcess; keep the settings diagnostics in the same file.
  const diagnosticsLog = createHelperLog(
    helperConfig.logFile === undefined ? defaultHelperLogPath() : helperConfig.logFile,
  )
  const hostSettings = createSettingsScope(ctx, Config, config, publicConfig)
  const overrides = createUserSettingsStore(defaultUserSettingsPath(), {
    warn(message) {
      diagnosticsLog.write('WARN', message)
      logger.warn?.(`dsh-dafeiyu-jinrong ${message}`)
    },
  })
  const settings = createEffectiveSettings(hostSettings, overrides, logger)
  let diagnosticsLogged = false

  let bridge
  let reducer
  let restartTimer
  let marketMonitor
  // Latest market state, kept so an idle DSH session can show it again after a
  // task finishes without waiting for the next poll.
  let marketMessage = null
  let lastTaskState = CompanionState.IDLE
  const bubbleStore = createBubbleStore({ logger })
  const actionsStore = createActionsStore({ logger })
  const getMemeService = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('dshMeme') : undefined
    } catch {
      return undefined
    }
  }
  const memes = createMemeLibrary({ logger, getService: getMemeService })
  let lastWeatherLine = ''
  const weatherService = createWeatherService({
    logger,
    onChange: (snapshot) => {
      const line = String(snapshot?.line ?? '')
      if (!line && !lastWeatherLine) return
      lastWeatherLine = line
      if (!bridge) return
      bridge.send(createMessage(CompanionMessageKind.WEATHER, {
        line,
        city: snapshot?.city ?? '',
        condition: snapshot?.condition ?? '',
        temperature: snapshot?.temperature ?? null,
        updatedAt: snapshot?.updatedAt ?? Date.now(),
      }))
    },
  })
  const pendingPreviews = new Map()
  let previewSeq = 0
  const balance = createBalanceMonitor({
    query: createBalanceQuery(ctx),
    onChange(snapshot) {
      const message = createMessage(CompanionMessageKind.BALANCE, snapshot)
      if (bridge) bridge.send(message)
      else eventStream.broadcast(message)
    },
  })

  const stopMarketRuntime = () => {
    marketMonitor?.stop()
    marketMonitor = undefined
    marketMessage = null
    lastTaskState = CompanionState.IDLE
  }

  const startMarketRuntime = () => {
    if (marketMonitor) return
    marketMonitor = createMarketMonitor({
      getConfig: () => settings.get(),
      // Route through the bridge so the arbitration below stays the only place
      // that decides which state the pet actually shows.
      send: (message) => {
        if (bridge) bridge.send(message)
      },
      logger,
    })
    marketMonitor.start()
  }

  /**
   * One pet, one state. DSH tasks win while something is actively happening;
   * otherwise the market mood owns the body. Alerts always get through.
   */
  const arbitrate = (message) => {
    if (!message || message.kind !== CompanionMessageKind.STATE) return message
    const current = settings.get()
    if (current.marketEnabled !== true) {
      lastTaskState = message.state
      return message
    }
    if (message.__alert === true) return message
    if (message.__market === true) {
      if (current.marketYieldToTask !== false && lastTaskState !== CompanionState.IDLE) return null
      marketMessage = message
      return message
    }
    lastTaskState = message.state
    if (message.state !== CompanionState.IDLE) return message
    return marketMessage ?? message
  }

  const stopRuntime = (reason = 'settings-change') => {
    stopMarketRuntime()
    weatherService.stop()
    for (const pending of pendingPreviews.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('桌宠已停止'))
    }
    pendingPreviews.clear()
    bridge?.stop(reason)
    bridge = undefined
    reducer = undefined
  }

  const restartRuntime = (next) => {
    stopRuntime('settings-change')
    startRuntime(next)
  }

  // `settings.describe()` lists the settings-page namespaces, not the
  // configEditor entries that `settings.update()` writes. Its absence of
  // "dsh-dafeiyu-jinrong" is not evidence of a failed write (issue #95), so it is only
  // printed on an actual failure and labelled explicitly.
  const settingsPageNamespaceList = () => {
    try {
      return (hostSettings.describe?.() ?? []).map((row) => row.ns).join(',')
    } catch {
      return ''
    }
  }

  // PyInstaller's one-shot helper unpacks ~100 MB into %TEMP% before it can
  // speak. Some Windows profiles reject that with "Could not create temporary
  // directory", which looks like a crashed pet, so give the child its own
  // writable directory. `DSH_DAFEIYU_TMP` overrides the location for machines
  // where the default profile temp is unusable (we hit one: extraction works on
  // a secondary NTFS volume but not under C:\AppData).
  const helperRuntimeTemp = () => {
    const override = process.env.DSH_DAFEIYU_TMP
    if (override) {
      try {
        mkdirSync(override, { recursive: true })
        return override
      } catch {
        return undefined
      }
    }
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const directory = join(base, 'dsh-dafeiyu-jinrong', 'tmp')
    try {
      mkdirSync(directory, { recursive: true })
    } catch {
      return undefined
    }
    return directory
  }

  const helperEnvironment = (resolved) => {
    const temp = helperRuntimeTemp()
    return {
      ...helperConfig.env,
      ...(temp ? { TMP: temp, TEMP: temp } : {}),
      DSH_DAFEIYU_SCALE: String(resolved.scale ?? defaults.scale),
    DSH_DAFEIYU_BUBBLE_SCALE: String(resolved.bubbleScale ?? defaults.bubbleScale),
    DSH_DAFEIYU_ACTIVITY_LEVEL: String(resolved.activityLevel ?? defaults.activityLevel),
    DSH_DAFEIYU_REDUCED_MOTION: resolved.reducedMotion === true ? '1' : '0',
    DSH_DAFEIYU_SOUND_ENABLED: resolved.soundEnabled !== false ? '1' : '0',
    DSH_DAFEIYU_SOUND_STATES: normalizeSoundStates(resolved.soundStates).join(','),
    DSH_DAFEIYU_BUBBLE_MODE: String(resolved.bubbleMode ?? defaults.bubbleMode),
    DSH_DAFEIYU_BUBBLE_STATES: (Array.isArray(resolved.bubbleStates) ? resolved.bubbleStates : defaults.bubbleStates).join(','),
    DSH_DAFEIYU_WEBUI_URL: resolveClientTarget({ ...config, ...resolved }).url,
    DSH_DAFEIYU_OPEN_LABEL: resolveClientTarget({ ...config, ...resolved }).label,
    }
  }

  const companionConfig = (next) => ({
    scale: next.scale ?? defaults.scale,
    bubbleScale: next.bubbleScale ?? defaults.bubbleScale,
    activityLevel: next.activityLevel ?? defaults.activityLevel,
    reducedMotion: next.reducedMotion === true,
    soundEnabled: next.soundEnabled !== false,
    soundStates: normalizeSoundStates(next.soundStates),
    bubbleMode: next.bubbleMode ?? defaults.bubbleMode,
    bubbleStates: Array.isArray(next.bubbleStates) ? next.bubbleStates : defaults.bubbleStates,
    openUrl: resolveClientTarget({ ...config, ...next }).url,
    openLabel: resolveClientTarget({ ...config, ...next }).label,
    bubble: bubbleStore.get(),
    actions: actionsStore.get(),
    idleTargets: String(next.idleTargets ?? defaults.idleTargets),
  })

  const sendConfig = (next = settings.get()) => {
    if (!bridge) return
    bridge.send(createMessage(CompanionMessageKind.CONFIG, companionConfig(next)))
  }

  const sendMeme = (tag) => {
    if (!bridge) return false
    const meme = memes.pick({ tag })
    if (!meme) return false
    bridge.send(createMessage(CompanionMessageKind.MEME, {
      path: meme.path,
      caption: meme.caption,
      tag: meme.tag,
      mime: meme.mime,
      ttlMs: 8000,
    }))
    return true
  }

  const requestPreview = (spec, scene, data) => new Promise((resolvePromise, reject) => {
    if (!bridge) {
      reject(new Error('桌宠尚未连接'))
      return
    }
    const requestId = `p-${++previewSeq}-${randomUUID().slice(0, 8)}`
    const timer = setTimeout(() => {
      pendingPreviews.delete(requestId)
      reject(new Error('预览超时'))
    }, 6000)
    timer.unref?.()
    pendingPreviews.set(requestId, { resolve: resolvePromise, reject, timer })
    bridge.send(createMessage(CompanionMessageKind.PREVIEW, {
      requestId,
      spec,
      scene: scene || 'status',
      data: data || {},
      path: bubbleStore.previewPath,
    }))
  })

  const handleHelperMessage = (message) => {
    if (!message || typeof message !== 'object') return
    if (message.kind === CompanionMessageKind.PREVIEW_READY) {
      const pending = pendingPreviews.get(message.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingPreviews.delete(message.requestId)
      pending.resolve({ rev: Date.now() })
      return
    }
    if (message.kind === CompanionMessageKind.MEME_REQUEST || message.kind === CompanionMessageKind.BUBBLE_CLICK) {
      if (!sendMeme(message.tag)) {
        logger.debug?.('dafeiyu: meme requested but the library is empty')
      }
      return
    }
    if (message.kind === CompanionMessageKind.INTERACTION) {
      logger.debug?.(`dafeiyu interaction: ${message.region ?? 'unknown'}`)
    }
  }

  let lastMemeReactionAt = 0
  // Read-only chat reaction: when the user posts a meme marker or an image,
  // the pet answers with its own meme bubble. It never writes to the session.
  const maybeCounterMeme = (event) => {
    if (!bridge || settings.get().memeBattle === false) return
    if (event?.type !== 'user/message') return
    const text = eventText(event)
    if (!text.includes('[表情:') && !eventHasImage(event)) return
    const now = Date.now()
    if (now - lastMemeReactionAt < 6000) return
    lastMemeReactionAt = now
    sendMeme('daily')
  }

  const applyLiveSettings = (next) => {
    if (!bridge || !reducer) return
    // Keep the environment used by a later Helper spawn in sync with the live
    // config; otherwise a crashed Helper would restart with stale values until
    // the replayed CONFIG snapshot arrives.
    bridge.options.env = { ...bridge.options.env, ...helperEnvironment(next) }
    for (const message of reducer.setIncludeSubagents(next.includeSubagents === true)) bridge.send(message)
    sendConfig(next)
    weatherService.configure({
      weatherEnabled: next.weatherEnabled !== false,
      weatherCity: String(next.weatherCity ?? defaults.weatherCity),
      weatherRefreshMinutes: next.weatherRefreshMinutes ?? defaults.weatherRefreshMinutes,
    })
    // Market settings apply live: toggling the switch starts or stops polling
    // without restarting the Helper window.
    if (next.marketEnabled === true) {
      startMarketRuntime()
      marketMonitor?.configure()
    } else {
      stopMarketRuntime()
    }
  }

  const scheduleRestart = (next) => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      restartRuntime(next)
    }, 400)
    restartTimer.unref?.()
  }

  const startRuntime = (resolved) => {
    if (resolved.enabled === false) {
      logger.info?.('dsh-dafeiyu-jinrong is disabled')
      return
    }
    bridge = new HelperProcess({
      ...helperConfig,
      env: helperEnvironment(resolved),
      // Tab on the pet advances 总盘 → 自选1 → 自选2 → …; the host owns the
      // list, so the Helper only reports the key press.
      onCycle: (reply) => {
        marketMonitor?.cycleView({ back: reply?.back === true })
      },
      onMessage: (message) => handleHelperMessage(message),
      onSettingsChange: (report) => {
        if (typeof settings.update !== 'function') return
        const patch = {}
        if (Number.isFinite(report.scale)) patch.scale = Math.min(1.4, Math.max(0.55, report.scale))
        if (Number.isFinite(report.bubbleScale)) patch.bubbleScale = Math.min(1.2, Math.max(0.8, report.bubbleScale))
        if (typeof report.reducedMotion === 'boolean') patch.reducedMotion = report.reducedMotion
        if (Object.keys(patch).length === 0) return
        // Capture the host values before the write: the fallback only applies
        // while the host still holds the same baseline.
        const hostBefore = hostSettings.get()
        // Record before the write: DSH can resolve settings.update() without
        // the profile patch actually reaching disk. The store keeps the menu
        // value while the host holds either the old baseline or that value, and
        // a later host-side change (a third value) clears it.
        overrides.record(patch, hostBefore)
        void Promise.resolve(hostSettings.update(patch)).then(() => {
          diagnosticsLog.write('INFO', `persisted native menu settings: ${JSON.stringify(patch)}; fallback retained: ${JSON.stringify(overrides.snapshot())}`)
        }).catch((error) => {
          const detail = error instanceof Error ? error.message : String(error)
          diagnosticsLog.write(
            'ERROR',
            `settings.update failed for namespace "${hostSettings.namespace ?? 'dsh-dafeiyu-jinrong'}": ${detail}; settings-page namespaces (describe, not write targets): ${settingsPageNamespaceList() || '(none)'}; kept native menu values: ${JSON.stringify(overrides.snapshot())}`,
          )
          logger.warn?.(`dsh-dafeiyu-jinrong failed to persist helper settings: ${detail}`)
        }).finally(() => {
          // The Helper already applied the menu choice locally. Re-sending the
          // effective CONFIG keeps that choice in the replay snapshot if the
          // process restarts, and updates the environment for a later spawn.
          if (bridge) applyLiveSettings(settings.get())
        })
      },
    }, logger)
    // Mirror every companion message to in-page subscribers without changing
    // what the helper receives; the wrap is per-runtime and dies with it.
    const deliver = bridge.send.bind(bridge)
    bridge.send = (message) => {
      const forwarded = arbitrate(message)
      if (!forwarded) return
      deliver(forwarded)
      eventStream.broadcast(forwarded)
    }
    reducer = new CompanionReducer({ includeSubagents: resolved.includeSubagents === true })
    if (!diagnosticsLogged) {
      diagnosticsLogged = true
      diagnosticsLog.write(
        'INFO',
        `settings persistence (activation): namespace="${hostSettings.namespace ?? 'dsh-dafeiyu-jinrong'}"; update=${typeof hostSettings.update === 'function'}; native-menu fallback: ${JSON.stringify(overrides.snapshot())}`,
      )
    }
    bridge.start()
    bridge.send(createMessage(CompanionMessageKind.HELLO, {
      state: CompanionState.IDLE,
      host: 'deepseek-harness',
      pluginVersion: pkg.version,
      message: 'BigFish connected to DSH',
    }))
    bridge.send(createMessage(CompanionMessageKind.STATE, {
      state: CompanionState.IDLE,
      phase: 'plugin-start',
      stage: '等待任务',
      message: '我在这儿等新任务哦',
      detail: 'DSH · 等待下一次任务',
    }))
    sendConfig(resolved)
    weatherService.configure({
      weatherEnabled: resolved.weatherEnabled !== false,
      weatherCity: String(resolved.weatherCity ?? defaults.weatherCity),
      weatherRefreshMinutes: resolved.weatherRefreshMinutes ?? defaults.weatherRefreshMinutes,
    })
    if (balance.get().status !== 'disabled') bridge.send(createMessage(CompanionMessageKind.BALANCE, balance.get()))
    if (resolved.marketEnabled === true) startMarketRuntime()
    logger.info?.('dsh-dafeiyu-jinrong companion bridge started')
  }

  startRuntime(settings.get())
  balance.configure(settings.get().enabled !== false && settings.get().balanceEnabled, settings.get().balanceSource)

  // The companion intentionally observes every DSH session. Loader entries may
  // live inside a scoped composition, so use the unscoped root bus and dispose
  // the registrations explicitly with this plugin's lifecycle.
  // Never let an exception from this optional companion escape into the shared
  // session bus: a throw here could stop every other subscriber from seeing
  // the event, which would look exactly like "installing the pet broke other
  // plugins".
  const offEvent = eventCtx.on('session/event', (session, event) => {
    try {
      maybeCounterMeme(event)
    } catch (error) {
      logger.warn?.(`dafeiyu: meme reaction failed: ${error?.message ?? error}`)
    }
    if (!bridge || !reducer) return
    try {
      for (const message of reducer.handle(session, event)) bridge.send(message)
    } catch (error) {
      logger.error?.('dsh-dafeiyu-jinrong failed to handle session event', error)
    }
  }, { global: true })
  const offDisposed = eventCtx.on('session/disposed', (session) => {
    if (!bridge || !reducer) return
    try {
      for (const message of reducer.disposeSession(session)) bridge.send(message)
    } catch (error) {
      logger.error?.('dsh-dafeiyu-jinrong failed to dispose session', error)
    }
  }, { global: true })

  const unwatch = settings.watch((next) => {
    // Disabling is the only path that tears the helper down.  Every other
    // setting is applied live through a CONFIG message, so sliders never
    // restart the pet.  Starting a previously-disabled runtime is debounced
    // to avoid spawning repeatedly while settings settle.
    try {
      balance.configure(next.enabled !== false && next.balanceEnabled, next.balanceSource)
      if (next.enabled === false) {
        if (restartTimer) {
          clearTimeout(restartTimer)
          restartTimer = undefined
        }
        stopRuntime('settings-change')
        return
      }
      if (!bridge) {
        scheduleRestart(next)
        return
      }
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = undefined
      }
      applyLiveSettings(next)
    } catch (error) {
      // This callback runs inside the host's settings dispatch; a throw here
      // would take the host's settings service down with the pet.
      logger.error?.(`dsh-dafeiyu-jinrong failed to apply settings: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  // A credential or account change invalidates the old display immediately.
  const refreshBalance = () => {
    const next = settings.get()
    balance.configure(next.enabled !== false && next.balanceEnabled, next.balanceSource, true)
  }
  const offCredential = eventCtx.on('credentials/reference-updated', refreshBalance, { global: true })
  const offAccount = eventCtx.on('deepseek-account/signed-out', refreshBalance, { global: true })
  const offAccountCredential = eventCtx.on('credentials/record-updated', refreshBalance, { global: true })
  const offProvider = eventCtx.on('settings/document-updated', (ns) => {
    if (['llm-deepseek', 'llm-deepseek-api-key', balanceProviderNamespace(ctx)].includes(ns)) refreshBalance()
  }, { global: true })

  const companionApi = createCompanionApi({
    bubbleStore,
    actionsStore,
    memes,
    getBridge: () => bridge,
    getCatalog: () => loadClipCatalog(),
    getMemeService,
    requestPreview,
    sendConfig,
    logger,
  })

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: CONFIG_ENDPOINT, handler: createConfigHandler(settings) }),
        'dsh-dafeiyu-jinrong: local settings endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: EVENTS_ENDPOINT, handler: createEventsHandler(eventStream) }),
        'dsh-dafeiyu-jinrong: local event stream',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: MARKET_VIEW_ENDPOINT, handler: createMarketViewHandler(() => marketMonitor) }),
        'dsh-dafeiyu-jinrong: local market view endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: BALANCE_ENDPOINT, handler: createBalanceHandler(balance) }),
        'dsh-dafeiyu-jinrong: local balance endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: BUBBLE_ENDPOINT, handler: companionApi.bubble }),
        'dsh-dafeiyu-jinrong: bubble spec endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: PREVIEW_ENDPOINT, handler: companionApi.preview }),
        'dsh-dafeiyu-jinrong: bubble preview endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: BUBBLE_PREVIEW_ENDPOINT, handler: companionApi.previewImage }),
        'dsh-dafeiyu-jinrong: bubble preview image',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: ACTIONS_ENDPOINT, handler: companionApi.actions }),
        'dsh-dafeiyu-jinrong: action config endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: ACTIONS_PLAY_ENDPOINT, handler: companionApi.actionsPlay }),
        'dsh-dafeiyu-jinrong: action playback endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: MEMES_ENDPOINT, handler: companionApi.memeList }),
        'dsh-dafeiyu-jinrong: meme library endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: MEME_IMAGE_ENDPOINT, handler: companionApi.memeImage }),
        'dsh-dafeiyu-jinrong: meme image endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: MEMES_PICK_ENDPOINT, handler: companionApi.memePick }),
        'dsh-dafeiyu-jinrong: meme pick endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: COMPANION_DIAGNOSTICS_ENDPOINT, handler: companionApi.diagnostics }),
        'dsh-dafeiyu-jinrong: companion diagnostics',
      )
      const assetRoutes = createAssetRoutes()
      if (assetRoutes) {
        httpCtx.effect(
          () => httpCtx.webServer.register({ kind: 'exact', path: MANIFEST_ENDPOINT, handler: assetRoutes.manifestHandler }),
          'dsh-dafeiyu-jinrong: local manifest endpoint',
        )
        httpCtx.effect(
          () => httpCtx.webServer.register({ kind: 'exact', path: FRAME_ENDPOINT, handler: assetRoutes.frameHandler }),
          'dsh-dafeiyu-jinrong: local frame endpoint',
        )
      }
    })
  }
  ctx.effect(() => () => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = undefined
    offEvent?.()
    offDisposed?.()
    offCredential?.()
    offAccount?.()
    offAccountCredential?.()
    offProvider?.()
    unwatch()
    settings.dispose?.()
    balance.stop()
    stopRuntime('dsh-host-stop')
  })
}

export function apply(ctx, config = {}) {
  // Settings is already a declared dependency. Keep observers on this fiber
  // so Loader's fiber-scoped volatile updates reach them.
  mount(ctx, config)
}

export {
  CompanionMessageKind,
  CompanionReducer,
  CompanionState,
  HelperProcess,
}
