import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

test('client registers the studio and sidebar without duplicate settings cards', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject(name, register) {
        assert.ok(['main', 'sidebar.panellist'].includes(name))
        injections.push(name)
        register()
      },
      register(options) {
        registrations.push(options)
        return {}
      },
    },
  }

  const React = {
    createElement(type, props, ...children) { return { type, props, children } },
    Fragment: 'Fragment',
    useCallback(fn) { return fn },
    useEffect() {},
    useRef(initial) { return { current: initial } },
    useState(initial) { return [initial, () => {}] },
  }

  let client
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          client = factory((id) => {
            if (id === 'react') return React
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
    },
    console,
  }

  runInNewContext(source, sandbox)
  client.apply(ctx)

  assert.deepEqual(injections, ['main', 'sidebar.panellist'])
  assert.deepEqual(registrations.map((row) => row.name), ['main', 'sidebar.panellist'])
  assert.equal(registrations[0].key, 'dafeiyu-studio')
  assert.equal(registrations[1].id, 'dafeiyu-studio')
  assert.match(source, /'settings', '设置'/u)
  assert.match(source, /CompanionSettings/u)
  assert.doesNotMatch(source, /settings\.plugin\.item/u)
})

test('client apply does not throw when the slot contract changes or fails', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  const React = {
    createElement() {},
    useEffect() {},
    useRef() { return { current: undefined } },
    useState() { return [] },
  }

  let client
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          client = factory((id) => {
            if (id === 'react') return React
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
    },
    console: { error() {} },
  }

  runInNewContext(source, sandbox)

  // DSH may invoke the inject callback asynchronously, so a throw must be
  // contained inside that callback too. A broken card must degrade to "missing",
  // never fail the whole WebUI load.
  let registerAttempted = 0
  let injectAttempted = 0
  const deferred = []
  const ctx = {
    slots: {
      inject(name, register) {
        injectAttempted += 1
        assert.ok(['main', 'sidebar.panellist'].includes(name))
        deferred.push(register)
      },
      register() {
        registerAttempted += 1
        throw new Error('keyed slot main requires options.key')
      },
    },
  }

  assert.doesNotThrow(() => client.apply(ctx))
  assert.equal(injectAttempted, 2)
  assert.equal(registerAttempted, 0)
  for (const register of deferred) assert.doesNotThrow(register)
  assert.equal(registerAttempted, 2)
})

test('client apply also contains a synchronous inject failure', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  const React = {
    createElement() {},
    useEffect() {},
    useRef() { return { current: undefined } },
    useState() { return [] },
  }

  let client
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          client = factory((id) => {
            if (id === 'react') return React
            throw new Error(`unexpected require: ${id}`)
          })
        },
      },
    },
    console: { error() {} },
  }
  runInNewContext(source, sandbox)

  let registerAttempted = 0
  const ctx = {
    slots: {
      inject() { throw new Error('slots service contract changed') },
      register() { registerAttempted += 1 },
    },
  }

  assert.doesNotThrow(() => client.apply(ctx))
  assert.equal(registerAttempted, 0)
})
