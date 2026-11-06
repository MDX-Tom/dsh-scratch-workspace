import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  allocateSessionDir,
  containingRoots,
  isIsolated,
  isMeaningfulTitle,
  owningRoot,
  sanitizeTitleForPath,
  setIsolated,
  MARKER_NAME,
} from '../lib/isolate.js'
import {
  patchFs,
  patchRegistry,
  patchSessionCreate,
  patchWorkingDirectory,
  renameSessionDirToTitle,
} from '../lib/patch.js'

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

test('sanitizeTitleForPath and isMeaningfulTitle filter and validate titles', () => {
  assert.equal(sanitizeTitleForPath('调整 DeepSeek 网页搜索超时'), '调整-DeepSeek-网页搜索超时')
  assert.equal(sanitizeTitleForPath('Test / Slash : Colon * Star'), 'Test-Slash-Colon-Star')
  assert.equal(isMeaningfulTitle('新会话'), false)
  assert.equal(isMeaningfulTitle('New Session'), false)
  assert.equal(isMeaningfulTitle('调整 DeepSeek 网页搜索超时'), true)
})

test('allocateSessionDir reuses empty draft directory instead of adding -2', async () => {
  const root = await stage()
  try {
    const isDirEmpty = async (dir) => {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(dir)
      return entries.length === 0
    }
    // First allocation
    const dir1 = await allocateSessionDir(root, 'session-d83adb64-1111', isDirEmpty)
    assert.match(dir1, /session-d83adb64$/)

    // Second allocation with same draft ID when dir1 is completely empty should reuse dir1
    const dir2 = await allocateSessionDir(root, 'session-d83adb64-1111', isDirEmpty)
    assert.equal(dir2, dir1)

    // If dir1 now has a file, second allocation should allocate suffix -2
    await writeFile(join(dir1, 'test.txt'), 'hello')
    const dir3 = await allocateSessionDir(root, 'session-d83adb64-1111', isDirEmpty)
    assert.match(dir3, /session-d83adb64-2$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchRegistry archiveSession removes empty session directory', async () => {
  const root = await stage()
  try {
    const sessionDir = join(root, 'session-empty01')
    await mkdir(sessionDir)

    let archived = null
    const fakeRegistry = {
      host: {},
      async archiveSession(id) {
        archived = id
      },
    }

    const iso = {
      roots: () => [root],
      ownerOf: p => (p?.startsWith(root) ? root : undefined),
      sessionPath: id => (id === 'sess-empty' ? sessionDir : undefined),
      forgetSession: () => {},
    }

    const unpatch = patchRegistry(fakeRegistry, iso)
    await fakeRegistry.archiveSession('sess-empty')
    assert.equal(archived, 'sess-empty')

    // Directory should have been removed because it was empty
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(sessionDir), false)
    unpatch()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renameSessionDirToTitle directly renames directory without creating symlinks', async () => {
  const root = await stage()
  try {
    const sessionDir = join(root, 'session-d83adb64')
    await mkdir(sessionDir)
    await writeFile(join(sessionDir, 'test.txt'), 'content')

    let recorded = null
    const iso = {
      sessionPath: id => (id === 'sess-1' ? sessionDir : undefined),
      ownerOf: p => (p?.startsWith(root) ? root : undefined),
      recordSessionPath: (id, path) => { recorded = path },
    }

    let remembered = null
    const fakeRegistry = {
      rememberSessionPath: (id, path) => { remembered = path },
    }

    await renameSessionDirToTitle('sess-1', '调整 DeepSeek 网页搜索超时', iso, fakeRegistry)

    const expectedName = 'session-调整-DeepSeek-网页搜索超时-sess1'
    const targetDir = join(root, expectedName)
    const { existsSync, readFileSync } = await import('node:fs')

    // Target directory exists with contents preserved
    assert.equal(existsSync(targetDir), true)
    assert.equal(readFileSync(join(targetDir, 'test.txt'), 'utf8'), 'content')

    // Old path is directly renamed — no leftover alias / symlink!
    assert.equal(existsSync(sessionDir), false)

    assert.equal(recorded, targetDir)
    assert.equal(remembered, targetDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchWorkingDirectory and renameSessionDirToTitle sync live working directory', async () => {
  const root = await stage()
  try {
    const sessionDir = join(root, 'session-d83adb64')
    await mkdir(sessionDir)

    const events = []
    const fakeSession = {
      id: 'sess-sync-1',
      append(type, data) {
        events.push({ type, data })
      },
    }

    const iso = {
      roots: () => [root],
      ownerOf: p => (p?.startsWith(root) ? root : undefined),
      sessionPath: id => (id === 'sess-sync-1' ? sessionDir : undefined),
      recordSessionPath: (id, path) => {
        iso.sessionPath = (queryId) => (queryId === id ? path : undefined)
      },
    }

    const fakeRegistry = {
      rememberSessionPath: () => {},
    }

    const fakeWd = {
      get(session) {
        return sessionDir
      },
      async ensure(agent) {
        return sessionDir
      },
      workingDirectoryProjectionHandle: {
        stateOf: () => sessionDir,
      },
    }

    const fakeCtx = {
      get(name) {
        if (name === 'workingDirectory') return fakeWd
        return undefined
      },
      sessions: {
        get: id => (id === 'sess-sync-1' ? fakeSession : undefined),
      },
    }

    const unpatchWd = patchWorkingDirectory(fakeCtx, iso)

    // Before rename: wd.get returns sessionDir
    assert.equal(fakeWd.get(fakeSession), sessionDir)

    // Now rename
    await renameSessionDirToTitle('sess-sync-1', 'SVG 绘制鹈鹕骑自行车', iso, fakeRegistry, fakeCtx, fakeSession)

    const targetDir = join(root, 'session-SVG-绘制鹈鹕骑自行车-sesssync')

    // 1. Live session received working-directory/change event
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'working-directory/change')
    assert.equal(events[0].data.cwd, targetDir)

    // 2. Working directory get and ensure immediately return the new targetDir!
    assert.equal(fakeWd.get(fakeSession), targetDir)
    assert.equal(await fakeWd.ensure({ session: fakeSession }), targetDir)

    unpatchWd()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('patchFs rewrites pre-rename session directories so tools write into renamed directory', async () => {
  const root = await stage()
  try {
    const oldDir = join(root, 'session-d83adb64')
    const targetDir = join(root, 'session-SVG-绘制鹈鹕-18d34aa8')
    await mkdir(targetDir, { recursive: true })

    const iso = {
      rewritePath(p) {
        if (p === oldDir) return targetDir
        if (p.startsWith(oldDir + '/')) return targetDir + p.slice(oldDir.length)
        return p
      },
    }

    const fakeFs = {
      async resolve(path, options) {
        return { displayPath: path, path }
      },
    }

    const fakeCtx = {
      get(name) {
        if (name === 'fs') return fakeFs
        return undefined
      },
    }

    const unpatchFs = patchFs(fakeCtx, iso)

    // Old path passed by model tool call
    const oldFilePath = join(oldDir, 'pelican-bicycle.svg')
    const resolved = await fakeFs.resolve(oldFilePath)

    // Must be translated directly to targetDir
    const expectedFilePath = join(targetDir, 'pelican-bicycle.svg')
    assert.equal(resolved.path, expectedFilePath)

    unpatchFs()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
