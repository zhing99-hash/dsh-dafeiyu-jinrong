// Optional Docker lifecycle for an already-installed DSA container.
//
// This never pulls images, installs dependencies, or accepts arbitrary shell
// arguments. The container name is validated and passed as a single argv item.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const run = promisify(execFile)
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/

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

export async function dockerAvailable() {
  return docker(['version', '--format', '{{.Server.Version}}'], 8_000)
}

/**
 * Start an existing container, or create it once from the configured image.
 * The image must already be pullable; this never runs arbitrary shell text.
 */
export async function dockerEnsure({ container, image, envFile, port }) {
  if (!validContainerName(container)) return { ok: false, error: '容器名不合法' }
  const status = await dockerStatus(container)
  if (status.ok) {
    if (status.running) return { ok: true, output: 'already running', started: false }
    const started = await docker(['start', container], 60_000)
    return { ...started, started: started.ok }
  }
  if (!IMAGE.test(String(image ?? ''))) return { ok: false, error: '镜像名不合法' }
  if (envFile && !existsSync(envFile)) return { ok: false, error: `env 文件不存在：${envFile}` }
  const args = ['run', '-d', '--name', container, '-p', `127.0.0.1:${Number(port) || 8000}:8000`]
  if (envFile) args.push('--env-file', envFile)
  args.push(image)
  const result = await docker(args, 300_000)
  return { ...result, started: result.ok }
}
