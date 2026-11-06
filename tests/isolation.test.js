import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  allocateSessionDir, containingRoots, isIsolated, owningRoot, setIsolated, MARKER_NAME,
} from '../lib/isolate.js'
import { createIsolationState } from '../lib/state.js'
import { patchRegistry, patchSessionCreate, isolatedSessionsApi } from '../lib/patch.js'

async function stage() {
  return await mkdtemp(join(tmpdir(), 'dsh-test-'))
}

test('marker file is the durable toggle', async () => {
  const root = await stage()
  try {
    assert.equal(await isIsolated(root), false)
    assert.equal(await setIsolated(root, true), true)
    assert.equal(await isIsolated(root), true)
    assert.match(await readFile(join(root, MARKER_NAME), 'utf8'), /per-session working directories/)
    assert.equal(await setIsolated(root, false), false)
    assert.equal(await isIsolated(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('default workspace path is automatically isolated', async () => {
  const root = await stage()
  try {
    assert.equal(await isIsolated(root, root), true)
    assert.equal(await isIsolated(root, '/other/path'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('containingRoots and owningRoot find nearest ancestor', async () => {
  const outer = await stage()
  const inner = join(outer, 'sub')
  await mkdir(inner, { recursive: true })
  try {
    const roots = [outer, inner]
    assert.equal(owningRoot(roots, join(inner, 'session-abc')), inner)
    assert.equal(owningRoot(roots, join(outer, 'session-xyz')), outer)
    assert.deepEqual(containingRoots(roots, join(inner, 'test')), [inner, outer])
  } finally {
    await rm(outer, { recursive: true, force: true })
  }
})

test('allocateSessionDir allocates collision-free directories', async () => {
  const root = await stage()
  try {
    const dir1 = await allocateSessionDir(root, 'session-12345678-abcd')
    assert.match(dir1, /session-12345678$/)
    const dir2 = await allocateSessionDir(root, 'session-12345678-wxyz')
    assert.match(dir2, /session-12345678-2$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchRegistry works with candidateMatches (modern DSH 0.2.x+)', async () => {
  const root = await stage()
  try {
    const sessionDir = join(root, 'session-abcdef01')
    await mkdir(sessionDir)

    const fakeRegistry = {
      host: {
        candidateMatches(id, path) {
          return false
        },
        rememberSessionPath(id, path) {},
      },
    }

    const iso = {
      roots: () => [root],
      ownerOf: p => (p.startsWith(root) ? root : undefined),
      recordSessionPath: () => {},
      sessionPath: id => (id === 'sess-1' ? sessionDir : undefined),
    }

    const unpatch = patchRegistry(fakeRegistry, iso)
    assert.equal(fakeRegistry.host.candidateMatches('sess-1', root), true)
    assert.equal(fakeRegistry.host.candidateMatches('sess-other', root), false)
    unpatch()
    assert.equal(fakeRegistry.host.candidateMatches('sess-1', root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchRegistry works with legacy sessionPath (DSH 0.1.x)', async () => {
  const root = await stage()
  try {
    const sessionDir = join(root, 'session-abcdef01')
    await mkdir(sessionDir)

    const fakeRegistry = {
      host: {
        sessionPath(id) {
          return id === 'sess-legacy' ? sessionDir : undefined
        },
        rememberSessionPath(id, path) {},
      },
    }

    const iso = {
      roots: () => [root],
      ownerOf: p => (p?.startsWith(root) ? root : undefined),
      recordSessionPath: () => {},
    }

    const unpatch = patchRegistry(fakeRegistry, iso)
    assert.equal(fakeRegistry.host.sessionPath('sess-legacy'), root)
    unpatch()
    assert.equal(fakeRegistry.host.sessionPath('sess-legacy'), sessionDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchSessionCreate avoids ApiSessionCwdConflict when reusing blank sessions', async () => {
  const root = await stage()
  try {
    const ws = { id: 'ws-1', path: root, record: { path: root } }
    const fakeCtx = {
      workspaceRegistry: {
        get: id => (id === 'ws-1' ? ws : undefined),
        list: () => [ws],
      },
      sessionController: {
        async create(req) {
          // If sessionId is present with old cwd, a real DSH throws ApiSessionCwdConflict.
          // Here we verify our wrapper stripped the mismatched sessionId.
          return { sessionId: req.sessionId ?? 'session-minted-new', cwd: ws.path }
        },
      },
      sessions: {
        get: id => (id === 'existing-blank' ? { session: { header: { cwd: root } } } : undefined),
      },
    }

    const iso = {
      settledRegistry: async () => {},
      workspaceRoot: id => (id === 'ws-1' ? root : undefined),
      beginRedirect: () => {},
      endRedirect: () => {},
      recordSessionPath: () => {},
    }

    const unpatch = patchSessionCreate(fakeCtx, iso)
    // Request with existing blank session that was minted with parent root cwd
    const res = await fakeCtx.sessionController.create({
      workspaceId: 'ws-1',
      sessionId: 'existing-blank',
    })

    // Our wrapper should have omitted sessionId so new one was minted
    assert.equal(res.sessionId, 'session-minted-new')
    unpatch()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
