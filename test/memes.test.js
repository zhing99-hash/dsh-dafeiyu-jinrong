import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMemeLibrary } from '../src/memes.js'

// 1x1 transparent PNG; valid magic bytes are all the library needs.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')

test('local memes can be added, listed, picked and removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-memes-'))
  const library = createMemeLibrary({ root, logger: console })
  const added = library.add({ buffer: PNG, tag: 'happy', caption: '开心鲸' })
  assert.match(added.id, /^[a-f0-9]{16}$/)
  assert.equal(added.duplicate, undefined)
  const duplicate = library.add({ buffer: PNG, tag: 'happy' })
  assert.equal(duplicate.duplicate, true)
  assert.equal(library.list().length, 1)
  const picked = library.pick({ tag: 'happy' })
  assert.equal(picked.source, 'local')
  assert.equal(picked.caption, '开心鲸')
  assert.ok(library.pathFor(added.id).path.endsWith('.png'))
  assert.equal(library.remove(added.id), true)
  assert.equal(library.list().length, 0)
})

test('non-image bytes and oversize files are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-memes-'))
  const library = createMemeLibrary({ root, logger: console })
  assert.throws(() => library.add({ buffer: Buffer.from('not an image'), tag: 'daily' }), /only PNG/)
  assert.throws(() => library.add({ buffer: Buffer.alloc(9 * 1024 * 1024), tag: 'daily' }), /8 MB/)
})

test('an optional dsh-meme service takes priority over local files', () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-memes-'))
  const servicePath = join(root, 'service.png')
  writeFileSync(servicePath, PNG)
  const library = createMemeLibrary({
    root,
    logger: console,
    getService: () => ({ pick: () => ({ ok: true, path: servicePath, caption: '服务图', tag: 'daily' }) }),
  })
  const picked = library.pick({ tag: 'daily' })
  assert.equal(picked.source, 'dsh-meme')
  assert.equal(picked.caption, '服务图')
})
