import test from 'node:test'
import assert from 'node:assert/strict'
import { registerCommands } from '../lib/command.js'

test('registerCommands registers /scratch and /isolate and executes commands', async () => {
  const registered = new Map()
  const mockCommands = {
    register: (def) => {
      registered.set(def.name, def)
      return () => registered.delete(def.name)
    },
  }

  const mockCtx = {
    get: (key) => (key === 'commands' ? mockCommands : undefined),
  }

  let cleaned = false
  let isolatedSet = false

  const mockIso = {
    roots: () => ['/workspace/mock'],
    ownerOf: (path) => (path.startsWith('/workspace/mock') ? '/workspace/mock' : undefined),
    isIsolated: (path) => path === '/workspace/mock',
    workspaceRoot: (path) => (path === '/workspace/mock' ? path : undefined),
    sessionPath: (id) => `/workspace/mock/${id}`,
  }

  const mockApi = {
    cleanOrphans: async () => {
      cleaned = true
      return { scannedCount: 3, cleanedCount: 2 }
    },
    setIsolatedPath: async (_path, enabled) => {
      isolatedSet = enabled
      return { isolates: enabled }
    },
  }

  const unregister = registerCommands(mockCtx, mockIso, mockApi)

  assert.equal(registered.has('scratch'), true)
  assert.equal(registered.has('isolate'), true)

  const scratch = registered.get('scratch')

  // Test status
  const statusRes = await scratch.handler({
    rawInput: 'status',
    agent: {
      session: {
        id: 'session-abc',
        header: { cwd: '/workspace/mock/session-abc' },
      },
    },
  })
  assert.equal(statusRes.kind, 'success')
  assert.match(statusRes.text, /工作区隔离状态/)
  assert.match(statusRes.text, /已开启/)

  // Test gc
  const gcRes = await scratch.handler({
    rawInput: 'gc',
    agent: {
      session: {
        id: 'session-abc',
        header: { cwd: '/workspace/mock/session-abc' },
      },
    },
  })
  assert.equal(gcRes.kind, 'success')
  assert.equal(cleaned, true)
  assert.match(gcRes.text, /磁盘常态清理完成/)

  // Test enable
  const enableRes = await scratch.handler({
    rawInput: 'enable',
    agent: {
      session: {
        id: 'session-abc',
        header: { cwd: '/workspace/mock/session-abc' },
      },
    },
  })
  assert.equal(enableRes.kind, 'success')
  assert.equal(isolatedSet, true)

  // Test disable
  const disableRes = await scratch.handler({
    rawInput: 'disable',
    agent: {
      session: {
        id: 'session-abc',
        header: { cwd: '/workspace/mock/session-abc' },
      },
    },
  })
  assert.equal(disableRes.kind, 'success')
  assert.equal(isolatedSet, false)

  // Test unregister disposer
  unregister()
  assert.equal(registered.size, 0)
})
