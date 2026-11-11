import assert from 'node:assert/strict'
import test from 'node:test'
import { eventHasImage, eventText } from '../src/index.js'

test('user meme markers are extracted from the common message shapes', () => {
  assert.equal(eventText({ data: { content: [{ type: 'text', text: '好家伙 [表情: 猫猫]' }] } }), '好家伙 [表情: 猫猫]')
  assert.equal(eventText({ data: { message: { content: '纯文本 [表情: 狗]' } } }), '纯文本 [表情: 狗]')
  assert.equal(eventText({ data: {} }), '')
})

test('image blocks are detected without treating text as an image', () => {
  assert.equal(eventHasImage({ data: { content: [{ type: 'image', image: {} }] } }), true)
  assert.equal(eventHasImage({ data: { content: [{ type: 'text', text: '图' }] } }), false)
  assert.equal(eventHasImage({ data: { content: '不是数组' } }), false)
})
