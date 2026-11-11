// Meme library for the pet bubble.
//
// Sources, in order:
//   1. dsh-meme's read-only Cordis service (`ctx.get('dshMeme')`) when that
//      plugin is installed — its 大肥鱼 pack is the natural battle partner.
//   2. The user's local folder under `$DSH_HOME/dafeiyu/memes`.
//
// Files are never fetched from the network. Anything that reaches the helper
// is a local absolute path that this module has verified (magic bytes, size,
// real path under an allowed root).

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { dataRoot } from './bubble/store.js'

const MAX_BYTES = 8 * 1024 * 1024
const TAGS = new Set(['happy', 'angry', 'sad', 'shy', 'confused', 'daily', 'success', 'error', 'work'])

export function mimeOf(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.readUInt32BE(0) === 0x47494638) return 'image/gif'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function extensionFor(mime) {
  return { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[mime] ?? null
}

function safeTag(value) {
  const tag = String(value ?? 'daily').toLowerCase()
  return TAGS.has(tag) ? tag : 'daily'
}

function safeText(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function createMemeLibrary({ root = dataRoot(), logger = console, getService = () => undefined } = {}) {
  const dir = join(root, 'memes')
  const indexPath = join(dir, 'index.json')
  mkdirSync(dir, { recursive: true })

  function readIndex() {
    try {
      const value = JSON.parse(readFileSync(indexPath, 'utf8'))
      if (!value || typeof value !== 'object' || !value.items || typeof value.items !== 'object') return { version: 1, items: {} }
      return value
    } catch {
      return { version: 1, items: {} }
    }
  }

  function writeIndex(index) {
    atomicWrite(indexPath, index)
  }

  function presentItems() {
    const index = readIndex()
    const items = []
    for (const [id, item] of Object.entries(index.items)) {
      const path = join(dir, item.file)
      try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > MAX_BYTES) continue
        items.push({ id, ...item, path, bytes: stat.size })
      } catch {}
    }
    return items
  }

  function pickLocal({ tag, query } = {}) {
    const items = presentItems()
    const wantedTag = tag ? safeTag(tag) : null
    const needle = String(query ?? '').trim().toLowerCase()
    const candidates = items.filter((item) => {
      if (wantedTag && item.tag !== wantedTag) return false
      if (!needle) return true
      return `${item.caption} ${item.keywords ?? ''} ${item.tag}`.toLowerCase().includes(needle)
    })
    const pool = candidates.length > 0 ? candidates : items
    if (pool.length === 0) return null
    const item = pool[Math.floor(Math.random() * pool.length)]
    return { source: 'local', id: item.id, path: item.path, tag: item.tag, caption: item.caption, mime: item.mime, bytes: item.bytes }
  }

  function pickFromService({ tag, query } = {}) {
    let service
    try {
      service = getService()
    } catch {
      return null
    }
    if (!service || typeof service.pick !== 'function') return null
    let result
    try {
      result = service.pick({ tag, query })
    } catch {
      return null
    }
    if (!result || result.ok === false || typeof result.path !== 'string') return null
    try {
      const path = resolve(result.path)
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > MAX_BYTES) return null
      const mime = mimeOf(readFileSync(path).subarray(0, 16))
      if (!mime) return null
      return {
        source: 'dsh-meme',
        path,
        tag: safeTag(result.tag),
        caption: safeText(result.caption ?? result.description ?? ''),
        mime,
        bytes: stat.size,
      }
    } catch {
      return null
    }
  }

  return {
    dir,
    list() {
      return presentItems().map(({ path, ...item }) => item)
    },
    add(input = {}) {
      const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(String(input.data ?? ''), 'base64')
      if (buffer.length === 0) throw new Error('empty image')
      if (buffer.length > MAX_BYTES) throw new Error('image is larger than 8 MB')
      const mime = mimeOf(buffer)
      if (!mime) throw new Error('only PNG, JPEG, GIF or WebP images are supported')
      const ext = extensionFor(mime)
      const id = createHash('sha1').update(buffer).digest('hex').slice(0, 16)
      const index = readIndex()
      if (index.items[id]) {
        return { id, ...index.items[id], duplicate: true }
      }
      const file = `${id}${ext}`
      writeFileSync(join(dir, file), buffer)
      const item = {
        file,
        mime,
        tag: safeTag(input.tag),
        caption: safeText(input.caption ?? input.name ?? ''),
        keywords: safeText(input.keywords ?? '', 200),
        bytes: buffer.length,
        addedAt: Date.now(),
      }
      index.items[id] = item
      writeIndex(index)
      return { id, ...item }
    },
    remove(id) {
      const index = readIndex()
      const item = index.items[id]
      if (!item) return false
      try {
        unlinkSync(join(dir, item.file))
      } catch {}
      delete index.items[id]
      writeIndex(index)
      return true
    },
    pick({ tag, query } = {}) {
      return pickFromService({ tag, query }) ?? pickLocal({ tag, query })
    },
    pathFor(id) {
      const index = readIndex()
      const item = index.items[id]
      if (!item) return null
      const path = join(dir, item.file)
      try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > MAX_BYTES) return null
        return { path, mime: item.mime, bytes: stat.size }
      } catch {
        return null
      }
    },
    hasLocal() {
      return presentItems().length > 0
    },
  }
}
