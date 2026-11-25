import assert from 'node:assert/strict'
import test from 'node:test'

import { dockerAction, dockerStatus, validContainerName } from '../src/analysis/docker.js'

test('Docker actions reject injection-shaped container names and unknown actions', async () => {
  assert.equal(validContainerName('daily_stock_analysis'), true)
  assert.equal(validContainerName('dsa; rm -rf /'), false)
  assert.equal((await dockerStatus('bad name')).ok, false)
  assert.equal((await dockerAction('daily_stock_analysis', 'rm')).ok, false)
})
