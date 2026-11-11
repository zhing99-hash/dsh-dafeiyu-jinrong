import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createActionsStore, defaultActions, normalizeActions } from '../src/actions/store.js'

test('the packaged action config has weighted categories and click pools', () => {
  const actions = normalizeActions(defaultActions())
  assert.ok(actions.categories.length >= 2)
  assert.ok(actions.categories.every((category) => category.clips.length > 0))
  for (const region of ['head', 'body', 'tail', 'double']) {
    assert.ok(actions.click[region].clips.length > 0)
    assert.ok(actions.click[region].lines.length > 0)
  }
  assert.equal(actions.noRepeatWindow, 2)
})

test('clip lists are de-duplicated, trimmed and reject empty categories', () => {
  const actions = normalizeActions({
    ...defaultActions(),
    categories: [{ id: 'micro', label: '小动作', weight: 10, clips: ['idle_yawn', 'idle_yawn', 'idle_stretch'] }],
  })
  assert.deepEqual(actions.categories[0].clips, ['idle_yawn', 'idle_stretch'])
  assert.throws(() => normalizeActions({
    ...defaultActions(),
    categories: [{ id: 'empty', label: '空', weight: 1, clips: [] }],
  }), /at least one clip/)
})

test('interval pairs are clamped and the store round-trips through disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-actions-'))
  const store = createActionsStore({ root, logger: console })
  const saved = store.save({
    ...defaultActions(),
    intervalsMs: { quiet: [100, 200], normal: [25000, 45000], lively: [12000, 22000] },
  })
  assert.ok(saved.intervalsMs.quiet[0] >= 2000)
  assert.ok(saved.intervalsMs.quiet[1] > saved.intervalsMs.quiet[0])
  const reloaded = createActionsStore({ root, logger: console }).get()
  assert.deepEqual(reloaded.intervalsMs, saved.intervalsMs)
})
