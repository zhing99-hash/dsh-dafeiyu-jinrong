// Bubble spec validation and normalisation.
//
// The spec is authored by the settings UI, stored by the host, and painted by
// the Qt helper. Both sides must agree on a small whitelist: module types,
// fields, sizes and colour syntax. Anything unknown is rejected instead of
// being forwarded to a renderer that would guess.

const STATES = ['IDLE', 'THINKING', 'WORKING', 'WAITING', 'SUCCESS', 'ERROR', 'DISCONNECTED']
const BINDING_KEYS = [...STATES, 'MULTI_TASK', 'BALANCE', 'CLICK', 'MEME']
const MODULE_TYPES = new Set(['text', 'icon', 'image', 'tasks', 'divider', 'spacer', 'stock', 'bar'])
const TEXT_FIELDS = new Set([
  'message', 'detail', 'balance', 'taskTitle', 'randomLine', 'caption', 'text',
  'state', 'stockName', 'stockPrice', 'stockPct', 'stockPercentile', 'time',
])
const COLOR_KEYS = new Set(['background', 'border', 'text', 'muted', 'accent'])
const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const MAX_ROWS = 6
const MAX_MODULES = 4
const MAX_TEXT = 200

function fail(message) {
  throw new Error(message)
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function color(value, fallback, label, tokens = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === 'transparent') return value
  if (tokens && ['text', 'muted', 'accent'].includes(value)) return value
  if (typeof value !== 'string' || !HEX.test(value)) fail(`${label} must be #RRGGBB, #RRGGBBAA, transparent or a theme token`)
  return value
}

function string(value, fallback, max = 80) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') fail('text values must be strings')
  return value.slice(0, max)
}

export function normalizeTheme(input, base) {
  const theme = object(input, 'theme')
  const merged = { ...base, ...theme }
  return {
    preset: string(merged.preset, base.preset, 24),
    width: Math.round(clampNumber(merged.width, 280, 560, base.width)),
    radius: Math.round(clampNumber(merged.radius, 0, 48, base.radius)),
    padding: Math.round(clampNumber(merged.padding, 8, 32, base.padding)),
    borderWidth: Math.round(clampNumber(merged.borderWidth, 0, 4, base.borderWidth)),
    shadow: merged.shadow !== false,
    opacity: Number(clampNumber(merged.opacity, 0.5, 1, base.opacity).toFixed(2)),
    font: string(merged.font, base.font, 80),
    text: color(merged.text, base.text, 'theme.text'),
    muted: color(merged.muted, base.muted, 'theme.muted'),
    accent: color(merged.accent, base.accent, 'theme.accent'),
    background: color(merged.background, base.background, 'theme.background'),
    border: color(merged.border, base.border, 'theme.border'),
    titleSize: Number(clampNumber(merged.titleSize, 6, 32, base.titleSize).toFixed(1)),
    bodySize: Number(clampNumber(merged.bodySize, 6, 32, base.bodySize).toFixed(1)),
  }
}

export function normalizeModule(input, baseTheme) {
  const module = object(input, 'module')
  const type = String(module.type ?? '')
  if (!MODULE_TYPES.has(type)) fail(`unknown module type: ${type || '(empty)'}`)
  const common = {
    type,
    align: ['left', 'center', 'right'].includes(module.align) ? module.align : 'left',
    weight: Number(clampNumber(module.weight, 0.05, 8, 1).toFixed(2)),
  }
  if (type === 'text') {
    const field = module.field === undefined ? undefined : String(module.field)
    if (field !== undefined && !TEXT_FIELDS.has(field)) fail(`unknown text field: ${field}`)
    const text = module.text === undefined ? undefined : string(module.text, '', MAX_TEXT)
    if (!field && !text) fail('text module needs a field or static text')
    return {
      ...common,
      field,
      text,
      size: Number(clampNumber(module.size, 6, 32, baseTheme.bodySize).toFixed(1)),
      bold: module.bold === true,
      italic: module.italic === true,
      color: color(module.color, 'text', 'module.color', true),
      wrap: module.wrap !== false,
      maxLines: Math.round(clampNumber(module.maxLines, 1, 6, 2)),
    }
  }
  if (type === 'icon') {
    return {
      ...common,
      field: 'state',
      size: Math.round(clampNumber(module.size, 20, 64, 46)),
    }
  }
  if (type === 'image') {
    return {
      ...common,
      field: module.field === 'meme' ? 'meme' : 'meme',
      maxWidth: Math.round(clampNumber(module.maxWidth, 40, 400, 300)),
      maxHeight: Math.round(clampNumber(module.maxHeight, 40, 400, 300)),
      radius: Math.round(clampNumber(module.radius, 0, 32, 12)),
    }
  }
  if (type === 'tasks') {
    return { ...common, max: Math.round(clampNumber(module.max, 1, 5, 3)), size: Number(clampNumber(module.size, 6, 24, baseTheme.bodySize).toFixed(1)) }
  }
  if (type === 'divider') return { ...common }
  if (type === 'spacer') return { ...common, weight: Number(clampNumber(module.weight, 0.02, 8, 1).toFixed(2)) }
  if (type === 'stock') {
    return {
      ...common,
      index: Math.round(clampNumber(module.index, 0, 9, 0)),
      size: Number(clampNumber(module.size, 6, 24, baseTheme.bodySize).toFixed(1)),
      showName: module.showName !== false,
      showPrice: module.showPrice !== false,
      showPct: module.showPct !== false,
      showPercentile: module.showPercentile === true,
    }
  }
  // bar
  return {
    ...common,
    field: module.field === 'stockPercentile' ? 'stockPercentile' : 'stockPercentile',
    height: Math.round(clampNumber(module.height, 3, 12, 6)),
  }
}

export function normalizeScene(input, name, baseTheme) {
  const scene = object(input, `scene ${name}`)
  const rows = Array.isArray(scene.rows) ? scene.rows : []
  if (rows.length === 0) fail(`scene ${name} needs at least one row`)
  if (rows.length > MAX_ROWS) fail(`scene ${name} has too many rows (max ${MAX_ROWS})`)
  const normalizedRows = rows.map((row, rowIndex) => {
    const value = object(row, `scene ${name} row ${rowIndex + 1}`)
    const modules = Array.isArray(value.modules) ? value.modules : []
    if (modules.length === 0) fail(`scene ${name} row ${rowIndex + 1} needs a module`)
    if (modules.length > MAX_MODULES) fail(`scene ${name} row ${rowIndex + 1} has too many modules`)
    return {
      gap: Math.round(clampNumber(value.gap, 0, 24, 8)),
      align: ['left', 'center', 'right', 'stretch'].includes(value.align) ? value.align : 'stretch',
      modules: modules.map((module) => normalizeModule(module, baseTheme)),
    }
  })
  return {
    name: string(scene.name, name, 40),
    ttlMs: Math.round(clampNumber(scene.ttlMs, 0, 60000, 4200)),
    rows: normalizedRows,
  }
}

export function normalizeSpec(input, defaults) {
  const spec = object(input, 'bubble spec')
  const theme = normalizeTheme(spec.theme ?? {}, defaults.theme)
  const scenesInput = object(spec.scenes ?? defaults.scenes, 'scenes')
  const scenes = {}
  for (const [name, scene] of Object.entries(scenesInput)) {
    if (!/^[a-zA-Z0-9_-]{1,24}$/.test(name)) fail(`invalid scene name: ${name}`)
    scenes[name] = normalizeScene(scene, name, theme)
    if (Object.keys(scenes).length > 12) fail('too many scenes (max 12)')
  }
  const defaultScene = Object.keys(scenes)[0]
  if (!defaultScene) fail('at least one scene is required')

  const bindingsInput = spec.bindings ?? defaults.bindings
  const bindings = {}
  for (const key of BINDING_KEYS) {
    const wanted = bindingsInput?.[key]
    bindings[key] = typeof wanted === 'string' && scenes[wanted] ? wanted : (scenes[defaults.bindings?.[key]] ? defaults.bindings[key] : defaultScene)
  }

  const sequenceInput = Array.isArray(spec.clickSequence) ? spec.clickSequence : defaults.clickSequence
  const clickSequence = sequenceInput
    .map((entry) => {
      const value = object(entry, 'click sequence entry')
      if (typeof value.scene !== 'string' || !scenes[value.scene]) fail(`click sequence references unknown scene: ${String(value.scene)}`)
      return { scene: value.scene, weight: Number(clampNumber(value.weight, 0.1, 10, 1).toFixed(2)) }
    })
    .slice(0, 8)
  if (clickSequence.length === 0) fail('click sequence needs at least one scene')

  const linesInput = Array.isArray(spec.randomLines) ? spec.randomLines : defaults.randomLines
  const randomLines = linesInput
    .map((entry) => {
      const value = object(entry, 'random lines entry')
      const lines = (Array.isArray(value.lines) ? value.lines : [])
        .filter((line) => typeof line === 'string' && line.trim())
        .map((line) => line.slice(0, MAX_TEXT))
        .slice(0, 8)
      return { weight: Number(clampNumber(value.weight, 0.1, 10, 1).toFixed(2)), lines }
    })
    .filter((entry) => entry.lines.length > 0)
    .slice(0, 12)
  if (randomLines.length === 0) fail('at least one random line is required')

  return {
    version: 1,
    theme,
    scenes,
    bindings,
    clickSequence,
    randomLines,
    limits: {
      maxRows: MAX_ROWS,
      maxModulesPerRow: MAX_MODULES,
      maxTextChars: MAX_TEXT,
      maxImageBytes: 8 * 1024 * 1024,
    },
  }
}

export { BINDING_KEYS, MODULE_TYPES, TEXT_FIELDS }
