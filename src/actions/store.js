// Action pack configuration: weights, click pools, sleep clips and the action
// menu. The packaged `assets/actions.json` is the default; the user's version
// lives next to the bubble spec and is sent to the helper in CONFIG.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ASSETS_ROOT, dataRoot, readJsonFile } from '../bubble/store.js'

const CLIP = /^[a-zA-Z0-9_-]{1,48}$/

function fail(message) {
  throw new Error(message)
}

function text(value, fallback, max = 80) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') fail('action text values must be strings')
  return value.slice(0, max)
}

function clipList(value, label) {
  const list = (Array.isArray(value) ? value : []).filter((clip) => typeof clip === 'string' && CLIP.test(clip))
  if (list.length === 0) fail(`${label} needs at least one clip`)
  return [...new Set(list)].slice(0, 30)
}

function lineList(value, label) {
  const list = (Array.isArray(value) ? value : []).filter((line) => typeof line === 'string' && line.trim())
  if (list.length === 0) fail(`${label} needs at least one line`)
  return list.map((line) => line.slice(0, 120)).slice(0, 12)
}

function weight(value, fallback = 1) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(100, Math.max(0.1, parsed))
}

export function defaultActions() {
  return readJsonFile(join(ASSETS_ROOT, 'actions.json'))
}

export function normalizeActions(input, defaults = defaultActions()) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('actions must be an object')

  const categories = (Array.isArray(input.categories) ? input.categories : defaults.categories).map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`category ${index + 1} must be an object`)
    const id = text(entry.id, `category-${index + 1}`, 32)
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) fail(`invalid category id: ${id}`)
    return { id, label: text(entry.label, id, 40), weight: weight(entry.weight, 1), clips: clipList(entry.clips, `category ${id}`) }
  }).slice(0, 12)
  if (categories.length === 0) fail('at least one action category is required')

  const clickInput = input.click && typeof input.click === 'object' ? input.click : defaults.click
  const click = {}
  for (const region of ['head', 'body', 'tail', 'double']) {
    const value = clickInput?.[region]
    if (!value || typeof value !== 'object') {
      click[region] = defaults.click[region]
      continue
    }
    click[region] = {
      clips: clipList(value.clips, `click.${region}`),
      lines: lineList(value.lines, `click.${region}`),
    }
  }

  const sleepInput = input.sleep && typeof input.sleep === 'object' ? input.sleep : defaults.sleep
  const sleep = {
    enabled: sleepInput.enabled !== false,
    start: clipList(sleepInput.start, 'sleep.start'),
    loop: clipList(sleepInput.loop, 'sleep.loop'),
    end: clipList(sleepInput.end, 'sleep.end'),
    lines: lineList(sleepInput.lines, 'sleep.lines'),
    wakeLines: lineList(sleepInput.wakeLines, 'sleep.wakeLines'),
  }

  const eventsInput = input.events && typeof input.events === 'object' ? input.events : defaults.events
  const events = {}
  for (const [key, value] of Object.entries(eventsInput)) {
    if (!/^[A-Z_]{2,24}$/.test(key)) continue
    events[key] = clipList(value, `events.${key}`)
  }

  const menu = (Array.isArray(input.menu) ? input.menu : defaults.menu)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      if (typeof entry.id !== 'string' || !CLIP.test(entry.id)) return null
      return { id: entry.id, label: text(entry.label, entry.id, 40) }
    })
    .filter(Boolean)
    .slice(0, 30)

  const intervalsInput = input.intervalsMs && typeof input.intervalsMs === 'object' ? input.intervalsMs : defaults.intervalsMs
  const intervalsMs = {}
  for (const level of ['quiet', 'normal', 'lively']) {
    const pair = Array.isArray(intervalsInput[level]) ? intervalsInput[level] : defaults.intervalsMs[level]
    const lower = Math.min(600000, Math.max(2000, Number(pair?.[0]) || 12000))
    const upper = Math.min(900000, Math.max(lower + 1000, Number(pair?.[1]) || lower + 10000))
    intervalsMs[level] = [Math.round(lower), Math.round(upper)]
  }

  return {
    version: 1,
    labels: { ...defaults.labels, ...(input.labels && typeof input.labels === 'object' ? input.labels : {}) },
    categories,
    click,
    sleep,
    events,
    menu,
    intervalsMs,
    noRepeatWindow: Math.round(Math.min(8, Math.max(0, Number(input.noRepeatWindow ?? defaults.noRepeatWindow) || 0))),
    interactionCooldownMs: Math.round(Math.min(10000, Math.max(200, Number(input.interactionCooldownMs ?? defaults.interactionCooldownMs) || 1200))),
  }
}

export function loadClipCatalog() {
  const manifest = readJsonFile(join(ASSETS_ROOT, 'pet-manifest.json'))
  const actions = defaultActions()
  return {
    clips: Object.keys(manifest.clips),
    labels: actions.labels,
    menu: actions.menu,
  }
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function createActionsStore({ root = dataRoot(), logger = console } = {}) {
  const path = join(root, 'actions.json')
  const base = defaultActions()
  let current = base
  let loaded = false

  function load() {
    if (loaded) return current
    loaded = true
    try {
      current = normalizeActions(readJsonFile(path), base)
    } catch (error) {
      if (error && error.code !== 'ENOENT') logger.warn?.(`dafeiyu: action config is invalid, using defaults (${error.message})`)
      current = normalizeActions(base, base)
    }
    return current
  }

  return {
    path,
    get() {
      load()
      try {
        readFileSync(path)
      } catch {
        atomicWrite(path, current)
      }
      return current
    },
    base() {
      return normalizeActions(base, base)
    },
    save(next) {
      load()
      const normalized = normalizeActions(next, base)
      atomicWrite(path, normalized)
      current = normalized
      return current
    },
    reset() {
      load()
      const normalized = normalizeActions(base, base)
      atomicWrite(path, normalized)
      current = normalized
      return current
    },
  }
}
