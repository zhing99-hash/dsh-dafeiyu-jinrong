import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultBubbleSpec } from '../src/bubble/store.js'
import { normalizeSpec } from '../src/bubble/spec.js'

test('the packaged bubble spec validates and keeps the default scenes', () => {
  const spec = defaultBubbleSpec()
  assert.equal(spec.version, 1)
  assert.deepEqual(Object.keys(spec.scenes).sort(), ['balance', 'click1', 'click2', 'meme', 'status', 'tasks'])
  assert.equal(spec.bindings.WORKING, 'status')
  assert.equal(spec.theme.width, 420)
  assert.ok(spec.randomLines.length >= 4)
  assert.ok(spec.clickSequence.length >= 2)
})

test('theme and layout values are clamped into the renderer budget', () => {
  const base = defaultBubbleSpec()
  const spec = normalizeSpec({
    ...base,
    theme: { ...base.theme, width: 9999, radius: -10, padding: 1, opacity: 3 },
  }, base)
  assert.equal(spec.theme.width, 560)
  assert.equal(spec.theme.radius, 0)
  assert.equal(spec.theme.padding, 8)
  assert.equal(spec.theme.opacity, 1)
})

test('text modules accept semantic theme tokens and static text', () => {
  const base = defaultBubbleSpec()
  const spec = normalizeSpec({
    ...base,
    scenes: {
      status: {
        rows: [{
          modules: [
            { type: 'text', field: 'message', color: 'accent', size: 12, maxLines: 2 },
            { type: 'text', text: '固定文字', color: 'muted' },
          ],
        }],
      },
    },
    clickSequence: [{ scene: 'status', weight: 1 }],
  }, base)
  assert.equal(spec.scenes.status.rows[0].modules[0].color, 'accent')
  assert.equal(spec.scenes.status.rows[0].modules[1].text, '固定文字')
})

test('unknown modules and missing click scenes are rejected', () => {
  const base = defaultBubbleSpec()
  assert.throws(() => normalizeSpec({
    ...base,
    scenes: { status: { rows: [{ modules: [{ type: 'video' }] }] } },
  }, base), /unknown module type/)

  assert.throws(() => normalizeSpec({
    ...base,
    clickSequence: [{ scene: 'missing', weight: 1 }],
  }, base), /unknown scene/)
})

test('a scene with no rows and a spec with no scenes are rejected', () => {
  const base = defaultBubbleSpec()
  assert.throws(() => normalizeSpec({ ...base, scenes: { status: { rows: [] } } }, base), /at least one row/)
  assert.throws(() => normalizeSpec({ ...base, scenes: {} }, base), /at least one scene/)
})
