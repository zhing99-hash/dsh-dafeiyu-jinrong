export const PROTOCOL_VERSION = 1

export const CompanionState = Object.freeze({
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED',
})

export const CompanionMessageKind = Object.freeze({
  READY: 'ready',
  HELLO: 'hello',
  STATE: 'state',
  PULSE: 'pulse',
  ALERT: 'alert',
  TASK: 'task',
  TASKS: 'tasks',
  CONFIG: 'config',
  BALANCE: 'balance',
  SETTINGS: 'settings',
  // Host → helper: the IP-locked idle weather line (refreshed on a timer).
  WEATHER: 'weather',
  // Helper → host: the user pressed Tab on the pet, advance the bubble view.
  CYCLE: 'cycle',
  // Companion surfaces added in 0.4: custom bubble spec, meme cards, action
  // playback and the editor's offscreen preview.
  BUBBLE: 'bubble',
  MEME: 'meme',
  ACTION: 'action',
  INTERACTION: 'interaction',
  BUBBLE_CLICK: 'bubble-click',
  MEME_REQUEST: 'meme-request',
  PREVIEW: 'preview',
  PREVIEW_READY: 'preview-ready',
  ACTION_DONE: 'action-done',
  PING: 'ping',
  PONG: 'pong',
  CLOSED: 'closed',
  SHUTDOWN: 'shutdown',
})

// One-shot attention signals that do not change the companion state.
export const CompanionAlert = Object.freeze({
  APPROVAL: 'APPROVAL',
})

const states = new Set(Object.values(CompanionState))
const kinds = new Set(Object.values(CompanionMessageKind))

export function createMessage(kind, payload = {}) {
  if (!kinds.has(kind)) throw new TypeError(`Unknown companion message kind: ${kind}`)
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind,
    timestamp: Date.now(),
    ...payload,
  }
}

export function assertCompanionMessage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Companion message must be an object')
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported protocol version: ${String(value.protocolVersion)}`)
  }
  if (!kinds.has(value.kind)) throw new TypeError(`Unknown companion message kind: ${String(value.kind)}`)
  if ((value.kind === CompanionMessageKind.STATE || value.kind === CompanionMessageKind.PULSE)
    && !states.has(value.state)) {
    throw new TypeError(`Unknown companion state: ${String(value.state)}`)
  }
  return value
}

export function encodeMessage(message) {
  assertCompanionMessage(message)
  return `${JSON.stringify(message)}\n`
}
