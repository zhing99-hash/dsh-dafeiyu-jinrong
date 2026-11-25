// Optional local DSA launcher for machines without Docker.
//
// It only starts a checkout the user explicitly configured. No shell string is
// evaluated: python, main.py and the repository path are passed as argv/cwd.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { normalizeBaseUrl } from './client.js'
import { dockerEnsure } from './docker.js'

function readEnvFile(path) {
  if (!path || !existsSync(path)) return {}
  const result = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

function defaultLogPath() {
  return join(homedir(), '.dsh', 'dafeiyu', 'analysis', 'dsa.log')
}

async function healthOf(config) {
  const base = normalizeBaseUrl(config.analysisBaseUrl)
  try {
    const response = await fetch(`${base}/api/health`, {
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(3000) : undefined,
    })
    return response.ok
  } catch {
    return false
  }
}

export function createDsaLauncher({ getConfig, logger = console } = {}) {
  let child = null
  let lastError = ''
  let logStream = null

  function running() {
    return Boolean(child && child.exitCode === null && !child.killed)
  }

  async function start() {
    const config = getConfig() ?? {}
    if (await healthOf(config)) return { ok: true, started: false, message: 'DSA 已在运行' }
    if (running()) {
      const healthy = await waitForHealth(config, 30_000)
      return healthy
        ? { ok: true, started: false, message: 'DSA 正在启动' }
        : { ok: false, error: lastError || 'DSA 进程已启动但健康检查未通过' }
    }
    if (config.analysisLaunchMode === 'docker') {
      return startDocker(config)
    }
    if (config.analysisLaunchMode === 'auto') {
      const docker = await startDocker(config)
      if (docker.ok) return docker
      logger.warn?.(`[dafeiyu] Docker DSA unavailable, trying local: ${docker.error ?? ''}`)
    }
    return startLocal(config)
  }

  async function startDocker(config) {
    const result = await dockerEnsure({
      container: config.analysisContainer,
      image: config.analysisDockerImage,
      envFile: config.analysisEnvFile,
      port: config.analysisDockerPort,
    })
    if (!result.ok) return { ok: false, error: result.error || result.output || 'Docker 启动失败' }
    const healthy = await waitForHealth(config, 120_000)
    return healthy
      ? { ok: true, started: true, message: 'DSA 容器已启动' }
      : { ok: false, error: 'DSA 容器已启动，但 /api/health 未通过', output: result.output }
  }

  async function startLocal(config) {
    const repo = String(config.analysisRepoPath ?? '').trim()
    if (!repo) return { ok: false, error: '未配置 analysisRepoPath，无法本地启动 DSA' }
    const main = join(repo, 'main.py')
    if (!existsSync(main)) return { ok: false, error: `DSA main.py 不存在：${main}` }
    const python = String(config.analysisPython ?? '').trim() || (process.platform === 'win32' ? 'python.exe' : 'python3')
    const env = { ...process.env, PYTHONUNBUFFERED: '1', ...readEnvFile(config.analysisEnvFile) }
    const logPath = defaultLogPath()
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      logStream = createWriteStream(logPath, { flags: 'a' })
    } catch {
      logStream = null
    }
    lastError = ''
    child = spawn(python, ['main.py', '--serve-only'], {
      cwd: repo,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const write = (chunk) => { try { logStream?.write(chunk) } catch {} }
    child.stdout?.on('data', write)
    child.stderr?.on('data', write)
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) lastError = `DSA 进程退出（${code}）`
      write(`\n[launcher] DSA exited with ${code}\n`)
      child = null
    })
    child.on('error', (error) => {
      lastError = `DSA 启动失败：${error?.message ?? error}`
      child = null
    })
    const healthy = await waitForHealth(config, 120_000)
    if (healthy) return { ok: true, started: true, message: 'DSA 本地服务已启动', pid: child?.pid ?? null }
    return {
      ok: false,
      error: lastError || 'DSA 已启动但 /api/health 未通过；查看日志',
      logPath,
    }
  }

  async function waitForHealth(config, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await healthOf(config)) return true
      if (!running() && lastError) return false
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return false
  }

  function stop() {
    if (child && child.exitCode === null) {
      try { child.kill() } catch {}
    }
    child = null
    try { logStream?.end() } catch {}
    logStream = null
  }

  return {
    start,
    stop,
    get status() {
      return { running: running(), pid: child?.pid ?? null, error: lastError }
    },
  }
}
