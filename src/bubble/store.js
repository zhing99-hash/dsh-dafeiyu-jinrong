// Durable bubble spec storage.
//
// The packaged `assets/bubble-default.json` is the source of truth for the
// default look; the user's edits live under `$DSH_HOME/dafeiyu/bubble.json`.
// Writes are atomic (tmp + rename) so a crash during save cannot leave the
// helper with a truncated spec.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { normalizeSpec } from './spec.js'

const here = dirname(fileURLToPath(import.meta.url))
export const ASSETS_ROOT = resolve(here, '..', '..', 'assets')

export function dataRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dafeiyu')
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function defaultBubbleSpec() {
  const raw = readJsonFile(join(ASSETS_ROOT, 'bubble-default.json'))
  return normalizeSpec(raw, raw)
}

export function loadPresets() {
  try {
    return readJsonFile(join(ASSETS_ROOT, 'bubble-presets.json'))
  } catch {
    return {}
  }
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function createBubbleStore({ root = dataRoot(), logger = console } = {}) {
  const path = join(root, 'bubble.json')
  const previewPath = join(root, 'preview.png')
  const base = defaultBubbleSpec()
  let current = base
  let loaded = false
  // 0.5 added these scenes. Merge them into an existing user spec so an upgrade
  // shows the new idle/stock/countdown surfaces without overwriting edits.
  const NEW_SCENES = ['idle', 'stock', 'countdown']

  function withNewScenes(spec) {
    for (const name of NEW_SCENES) {
      if (!spec.scenes[name] && base.scenes[name]) spec.scenes[name] = base.scenes[name]
    }
    return spec
  }

  function load() {
    if (loaded) return current
    loaded = true
    try {
      const raw = readJsonFile(path)
      current = withNewScenes(normalizeSpec(raw, base))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        logger.warn?.(`dafeiyu: bubble spec is invalid, using defaults (${error.message})`)
        try {
          renameSync(path, `${path}.invalid-${Date.now()}.bak`)
        } catch {}
      }
      current = base
    }
    return current
  }

  function ensureFile() {
    try {
      readFileSync(path)
    } catch {
      atomicWrite(path, current)
    }
  }

  return {
    path,
    previewPath,
    get() {
      load()
      ensureFile()
      return current
    },
    base() {
      return base
    },
    save(next) {
      load()
      const normalized = withNewScenes(normalizeSpec(next, base))
      atomicWrite(path, normalized)
      current = normalized
      return current
    },
    reset() {
      load()
      atomicWrite(path, base)
      current = base
      return current
    },
    presets() {
      return loadPresets()
    },
  }
}
