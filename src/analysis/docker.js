// Optional Docker lifecycle for an already-installed DSA container.
//
// This never pulls images, installs dependencies, or accepts arbitrary shell
// arguments. The container name is validated and passed as a single argv item.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

export function validContainerName(name) {
  return CONTAINER.test(String(name ?? ''))
}

async function docker(args, timeout = 20_000) {
  try {
    const { stdout, stderr } = await run('docker', args, {
      windowsHide: true,
      timeout,
      maxBuffer: 256 * 1024,
    })
    return { ok: true, output: String(stdout || stderr || '').trim() }
  } catch (error) {
    return {
      ok: false,
      output: '',
      error: String(error?.stderr || error?.message || error).trim(),
    }
  }
}

export async function dockerStatus(container) {
  if (!validContainerName(container)) return { ok: false, running: false, error: '容器名不合法' }
  const result = await docker(['inspect', '--format', '{{.State.Running}}', container])
  if (!result.ok) return { ok: false, running: false, error: result.error }
  return { ok: true, running: result.output === 'true', output: result.output }
}

export async function dockerAction(container, action) {
  if (!validContainerName(container)) return { ok: false, error: '容器名不合法' }
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: '不支持的操作' }
  return docker([action, container], 60_000)
}
