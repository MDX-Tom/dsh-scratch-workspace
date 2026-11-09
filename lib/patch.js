/**
 * Compatibility patches for DeepSeek Harness (DSH):
 * 1. Wraps Workspace registry's session-path index for permanent multi-version
 *    compatibility (supporting both candidateMatches in 0.2.x+ and sessionPath in 0.1.x).
 * 2. Wraps sessionController.create to allocate per-session sandbox subfolders
 *    while avoiding ApiSessionCwdConflict when reusing existing blank sessions.
 * 3. Hooks session deletion for immediate disk cleanliness.
 * @module dsh-scratch-workspace/lib/patch
 */

import { readdir, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import {
  allocateSessionDir,
  isMeaningfulTitle,
  sanitizeTitleForPath,
  SESSION_DIR_PATTERN,
  SESSION_DIR_PREFIX,
  setIsolated,
} from './isolate.js'
import { cleanOrphans, isDirectoryEmpty, removeSessionDir, shortSessionId } from './gc.js'

/** The registry-internal host property. */
const HOST_PROPERTY = 'host'

/**
 * Resolves a session directory path to its actual existing on-disk location,
 * reconciling title-based renames, cold restarts, and stale header cwds.
 * @param {string} [targetPath] - candidate or stale path
 * @param {object} [options]
 * @param {string} [options.sessionId] - session ID if known
 * @param {object} [options.iso] - isolation state
 * @param {object} [options.ctx] - Cordis context
 * @returns {Promise<string>} real on-disk directory or fallback targetPath
 */
export async function resolveSessionDir(targetPath, { sessionId, iso, ctx } = {}) {
  // 1. If targetPath already exists on disk as a directory, it is valid
  if (typeof targetPath === 'string' && targetPath !== '') {
    try {
      if ((await stat(targetPath)).isDirectory()) {
        if (sessionId) iso?.recordSessionPath?.(sessionId, targetPath)
        return targetPath
      }
    } catch {}
  }

  // 2. Check if isolation state has a recorded rewrite
  if (typeof targetPath === 'string' && targetPath !== '') {
    const rewritten = iso?.rewritePath?.(targetPath)
    if (rewritten && rewritten !== targetPath) {
      try {
        if ((await stat(rewritten)).isDirectory()) {
          if (sessionId) iso?.recordSessionPath?.(sessionId, rewritten)
          return rewritten
        }
      } catch {}
    }
  }

  // 3. If sessionId is provided, check if iso already knows its session path
  if (sessionId) {
    const current = iso?.sessionPath?.(sessionId)
    if (current && current !== targetPath) {
      try {
        if ((await stat(current)).isDirectory()) {
          if (targetPath) iso?.recordRename?.(targetPath, current)
          return current
        }
      } catch {}
    }
  }

  // 4. If sessionId is not provided, try to find sessionId from ctx.sessions or ctx.sessionQuery
  let effectiveSessionId = sessionId
  if (!effectiveSessionId && typeof targetPath === 'string' && targetPath !== '' && ctx) {
    const sessionsService = typeof ctx.get === 'function' ? ctx.get('sessions', false) : ctx.sessions
    if (typeof sessionsService?.list === 'function') {
      try {
        for (const s of sessionsService.list()) {
          if (s?.header?.cwd === targetPath) {
            effectiveSessionId = s.id
            break
          }
        }
      } catch {}
    }

    if (!effectiveSessionId) {
      const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery', false) : ctx.sessionQuery
      if (typeof query?.listSessions === 'function') {
        try {
          const records = await query.listSessions()
          for (const r of records) {
            if (r?.header?.cwd === targetPath) {
              effectiveSessionId = r.header.id
              break
            }
          }
        } catch {}
      }
    }
  }

  // 5. If effectiveSessionId is known, check workingDirectory service if available
  if (effectiveSessionId && ctx) {
    const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory', false) : ctx.workingDirectory
    const sessionsService = typeof ctx.get === 'function' ? ctx.get('sessions', false) : ctx.sessions
    const session = sessionsService?.get?.(effectiveSessionId)
    if (session && typeof wd?.get === 'function') {
      try {
        const wdPath = wd.get(session)
        if (wdPath && (await stat(wdPath)).isDirectory()) {
          iso?.recordSessionPath?.(effectiveSessionId, wdPath)
          if (targetPath && targetPath !== wdPath) iso?.recordRename?.(targetPath, wdPath)
          return wdPath
        }
      } catch {}
    }
  }

  // 6. Look for matching session directory on disk using candidate short IDs
  const candidateShorts = new Set()
  if (effectiveSessionId) {
    candidateShorts.add(shortSessionId(effectiveSessionId))
  }
  if (typeof targetPath === 'string' && targetPath !== '') {
    const b = basename(targetPath)
    const match = b.match(SESSION_DIR_PATTERN)
    if (match) {
      const s = (match[2] ?? match[1] ?? '').split('-')[0].toLowerCase()
      if (s) candidateShorts.add(s)
    }
  }

  if (candidateShorts.size > 0) {
    const roots = new Set(iso?.roots?.() ?? [])
    if (typeof targetPath === 'string' && targetPath !== '') {
      const parent = iso?.ownerOf?.(targetPath) ?? (await stat(targetPath).catch(() => null) ? null : resolve(join(targetPath, '..')))
      if (parent) roots.add(parent)
    }

    for (const root of roots) {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const match = entry.name.match(SESSION_DIR_PATTERN)
          if (!match) continue
          const entryShort = (match[2] ?? match[1] ?? '').split('-')[0].toLowerCase()
          if (candidateShorts.has(entryShort)) {
            const foundDir = resolve(join(root, entry.name))
            if (effectiveSessionId) iso?.recordSessionPath?.(effectiveSessionId, foundDir)
            if (targetPath && targetPath !== foundDir) iso?.recordRename?.(targetPath, foundDir)
            return foundDir
          }
        }
      } catch {}
    }
  }

  return targetPath
}

/**
 * Locate and remove a session's directory if it is empty.
 * Uses 3-tier lookup: in-memory iso state -> registry index -> isolating roots scan by shortId.
 * @param {string} sessionId
 * @param {object} iso
 * @param {object} [registry]
 */
export async function cleanEmptySessionDir(sessionId, iso, registry) {
  if (!sessionId) return
  let sessionDir = iso?.sessionPath?.(sessionId)
  if (!sessionDir && typeof registry?.sessionPath === 'function') {
    try { sessionDir = registry.sessionPath(sessionId) } catch {}
  }
  const short = shortSessionId(sessionId)
  const candidateDirs = new Set()
  if (sessionDir) candidateDirs.add(sessionDir)

  if (short && typeof iso?.roots === 'function') {
    for (const root of iso.roots()) {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const match = entry.name.match(SESSION_DIR_PATTERN)
          if (match) {
            const entryShort = (match[2] ?? match[1] ?? '').split('-')[0].toLowerCase()
            if (entryShort === short) {
              candidateDirs.add(join(root, entry.name))
            }
          }
        }
      } catch {}
    }
  }

  iso?.forgetSession?.(sessionId)

  for (const dir of candidateDirs) {
    const empty = await isDirectoryEmpty(dir).catch(() => false)
    if (empty) {
      await removeSessionDir(dir).catch(() => {})
    }
  }
}

/**
 * Wrap the Workspace registry's session-path index so isolated sessions resolve
 * to the Workspace that owns their directory across all DSH versions.
 * @param registry - live workspaceRegistry service.
 * @param iso - shared isolation state.
 * @returns disposer restoring original functions.
 */
export function patchRegistry(registry, iso) {
  const target = entityHostOf(registry) ?? registry?.[HOST_PROPERTY]
  if (target === null || typeof target !== 'object') {
    // Graceful fallback instead of crashing DSH host
    return () => {}
  }

  const originalMatches = target.candidateMatches
  const originalPath = target.sessionPath
  const originalRemember = target.rememberSessionPath

  const mappedPath = path => (path === undefined ? undefined : (iso.ownerOf(path) ?? path))

  // Modern DSH (0.2.x+): candidateMatches(id, path)
  if (typeof originalMatches === 'function') {
    target.candidateMatches = function candidateMatches(id, path) {
      if (originalMatches.call(this, id, path)) return true

      // If id is recorded in isolation state, check if its owner matches path
      const sessionDir = iso.sessionPath(id)
      if (sessionDir !== undefined) {
        if (iso.ownerOf(sessionDir) === path) return true
      }

      // If the registry keeps a private sessionPaths Map
      const stored = registry?.sessionPaths?.get?.(id)
      if (stored !== undefined) {
        if (iso.ownerOf(stored) === path) return true
      }

      return false
    }
  }

  // Modern and legacy DSH: rememberSessionPath(id, path)
  if (typeof originalRemember === 'function') {
    target.rememberSessionPath = function rememberSessionPath(id, path) {
      iso.recordSessionPath(id, path)
      originalRemember.call(this, id, mappedPath(path))
    }
  }

  // Legacy DSH (0.1.x): sessionPath(id)
  if (typeof originalPath === 'function') {
    target.sessionPath = function sessionPath(id) {
      const raw = originalPath.call(this, id)
      return mappedPath(raw)
    }
  }

  // Hook archiveSession to immediately clean empty session directories on archive
  const proto = registry ? Object.getPrototypeOf(registry) : null
  const originalArchive = proto?.archiveSession ?? registry?.archiveSession
  if (typeof originalArchive === 'function') {
    const wrappedArchive = async function archiveSession(sessionId, options) {
      const res = await originalArchive.call(this, sessionId, options)
      await cleanEmptySessionDir(sessionId, iso, this).catch(() => {})
      return res
    }
    registry.archiveSession = wrappedArchive
    if (proto && typeof proto.archiveSession === 'function') {
      proto.archiveSession = wrappedArchive
    }
  }

  return () => {
    if (typeof originalMatches === 'function') target.candidateMatches = originalMatches
    if (typeof originalRemember === 'function') target.rememberSessionPath = originalRemember
    if (typeof originalPath === 'function') target.sessionPath = originalPath
    if (typeof originalArchive === 'function') {
      registry.archiveSession = originalArchive
      if (proto && typeof proto.archiveSession === 'function') {
        proto.archiveSession = originalArchive
      }
    }
  }
}

/**
 * Discover the host object from registry entities or registry itself.
 */
function entityHostOf(registry) {
  const entities = registry?.entities
  if (entities === null || typeof entities?.values !== 'function') return undefined
  for (const entity of entities.values()) {
    const host = entity?.[HOST_PROPERTY]
    if (host !== null && typeof host === 'object') {
      if (typeof host.candidateMatches === 'function' || typeof host.sessionPath === 'function') {
        return host
      }
    }
  }
  return undefined
}

/**
 * Wrap session creation so new sessions in isolating Workspaces get private subfolders,
 * while preventing ApiSessionCwdConflict if the UI attempts to reuse a blank session.
 * @param ctx - Cordis context.
 * @param iso - shared isolation state.
 * @returns disposer restoring original controller functions.
 */
export function patchSessionCreate(ctx, iso) {
  const controller = () => ctx.root?.sessionController ?? ctx.sessionController
  const registry = () => ctx.root?.workspaceRegistry ?? ctx.workspaceRegistry

  const originalCreate = controller()?.create
  if (typeof originalCreate !== 'function') return () => {}

  function redirect(workspaceId, sessionDir) {
    const workspace = registry().get(workspaceId)
    if (workspace === undefined) return undefined
    const privateRecord = Object.getOwnPropertyDescriptor(workspace, 'record')
    const previousPath = Object.getOwnPropertyDescriptor(workspace, 'path')
    const slot = { value: workspace.record }
    iso.beginRedirect()

    Object.defineProperty(workspace, 'path', {
      configurable: true,
      enumerable: true,
      get: () => sessionDir,
    })
    Object.defineProperty(workspace, 'record', {
      configurable: true,
      enumerable: true,
      get: () => ({ ...slot.value, path: sessionDir }),
      set: (next) => { slot.value = next },
    })

    return () => {
      iso.endRedirect()
      if (privateRecord === undefined || 'value' in privateRecord) {
        Object.defineProperty(workspace, 'record', { ...privateRecord, value: slot.value })
      } else {
        Object.defineProperty(workspace, 'record', privateRecord)
      }
      if (previousPath === undefined) delete workspace.path
      else Object.defineProperty(workspace, 'path', previousPath)
    }
  }

  controller().create = async function create(request) {
    const request0 = request ?? {}
    if (request0.workspaceId !== undefined) await iso.settledRegistry()

    const owner = request0.workspaceId === undefined
      ? undefined
      : iso.workspaceRoot(request0.workspaceId)

    if (owner === undefined) return await originalCreate.call(this, request0)

    // Check if request0.sessionId is an existing blank session minted under parent workspace cwd.
    // If so, it cannot be adopted for sandbox cwd; drop it and mint a fresh ID.
    let targetSessionId = request0.sessionId
    if (targetSessionId !== undefined) {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions', false) : ctx.sessions
      const agents = typeof ctx.get === 'function' ? ctx.get('agents', false) : ctx.agents
      const live = sessions?.get?.(targetSessionId) ?? agents?.get?.(targetSessionId)
      const existingCwd = live?.session?.header?.cwd
      if (existingCwd !== undefined && existingCwd === owner) {
        targetSessionId = undefined
      } else {
        const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery', false) : ctx.sessionQuery
        if (typeof query?.observeSession === 'function') {
          try {
            const obs = await query.observeSession(targetSessionId)
            if (obs?.header?.cwd !== undefined && obs.header.cwd === owner) {
              targetSessionId = undefined
            }
          } catch {}
        }
      }
    }

    const mintedId = targetSessionId ?? `session-${randomUUID()}`
    let cwd = await allocateSessionDir(
      owner,
      mintedId,
      isDirectoryEmpty,
    )

    let effectiveRequest = request0
    if (targetSessionId === undefined) {
      const { sessionId: _omitted, ...rest } = request0
      effectiveRequest = rest
    }

    const restore = redirect(request0.workspaceId, cwd)
    try {
      let created
      try {
        created = await originalCreate.call(this, effectiveRequest)
      } catch (error) {
        if (error?.name === 'ApiSessionCwdConflict' || error?.message?.includes('belongs to')) {
          // Clean up candidate directory before fallback
          await rm(cwd, { recursive: true, force: true }).catch(() => {})
          const fallbackId = `session-${randomUUID()}`
          const fallbackCwd = await allocateSessionDir(owner, fallbackId, isDirectoryEmpty)
          restore?.()
          const restoreFallback = redirect(request0.workspaceId, fallbackCwd)
          try {
            const { sessionId: _omitted, ...cleanRequest } = request0
            created = await originalCreate.call(this, cleanRequest)
            if (created?.sessionId) {
              const actualShort = shortSessionId(created.sessionId)
              const currentBase = basename(fallbackCwd)
              if (!currentBase.includes(actualShort)) {
                const correctDir = resolve(join(owner, `${SESSION_DIR_PREFIX}${actualShort}`))
                await rename(fallbackCwd, correctDir).catch(() => {})
                iso.recordSessionPath(created.sessionId, correctDir)
                return created
              }
              iso.recordSessionPath(created.sessionId, fallbackCwd)
            }
            return created
          } finally {
            restoreFallback?.()
          }
        } else {
          throw error
        }
      }
      if (created?.sessionId) {
        const actualShort = shortSessionId(created.sessionId)
        const currentBase = basename(cwd)
        if (!currentBase.includes(actualShort)) {
          const correctDir = resolve(join(owner, `${SESSION_DIR_PREFIX}${actualShort}`))
          try {
            await rename(cwd, correctDir)
            cwd = correctDir
          } catch {}
        }
        iso.recordSessionPath(created.sessionId, cwd)
      }
      return created
    } catch (error) {
      // Clean up newly created folder on failure
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
      throw error
    } finally {
      restore?.()
    }
  }

  // Hook session title rename for automatic directory naming
  const originalRename = controller()?.rename
  if (typeof originalRename === 'function') {
    controller().rename = async function rename(req) {
      const res = await originalRename.call(this, req)
      if (req?.sessionId && isMeaningfulTitle(req?.title)) {
        await renameSessionDirToTitle(req.sessionId, req.title, iso, registry(), ctx)
      }
      return res
    }
  }

  // Hook session deletion for immediate disk cleanliness
  const originalDelete = controller()?.delete
  if (typeof originalDelete === 'function') {
    controller().delete = async function del(req) {
      const sessionId = req?.sessionId ?? (typeof req === 'string' ? req : undefined)
      try {
        return await originalDelete.call(this, req)
      } finally {
        if (sessionId) {
          await cleanEmptySessionDir(sessionId, iso, registry())
        }
      }
    }
  }

  // Hook sessionController.list to project real on-disk session paths to frontend useSessions
  const originalList = controller()?.list
  if (typeof originalList === 'function') {
    controller().list = async function list(request, signal) {
      const res = await originalList.call(this, request, signal)
      if (Array.isArray(res?.items)) {
        for (const item of res.items) {
          if (!item?.sessionId) continue
          const resolved = await resolveSessionDir(item.cwd, {
            sessionId: item.sessionId,
            iso,
            ctx,
          })
          if (resolved) {
            item.cwd = resolved
          }
        }
      }
      return res
    }
  }

  // Also hook controller().listState.list if present
  const listState = controller()?.listState
  const originalStateList = listState?.list
  if (typeof originalStateList === 'function') {
    listState.list = async function list(signal) {
      const items = await originalStateList.call(this, signal)
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item?.sessionId) continue
          const resolved = await resolveSessionDir(item.cwd, {
            sessionId: item.sessionId,
            iso,
            ctx,
          })
          if (resolved) {
            item.cwd = resolved
          }
        }
      }
      return items
    }
  }

  // Hook controller().openWorkspacePath to rewrite paths for file reveals/opens
  const originalOpenWorkspacePath = controller()?.openWorkspacePath
  if (typeof originalOpenWorkspacePath === 'function') {
    controller().openWorkspacePath = async function openWorkspacePath(request, signal) {
      if (request && typeof request.path === 'string') {
        const resolved = await resolveSessionDir(request.path, { iso, ctx })
        if (resolved && resolved !== request.path) {
          request = { ...request, path: resolved }
        }
      }
      return await originalOpenWorkspacePath.call(this, request, signal)
    }
  }

  // Hook workspaceController.archiveSession for frontend archive actions
  const wsCtrl = ctx.root?.workspaceController ?? ctx.workspaceController
  const originalWsArchive = wsCtrl?.archiveSession
  if (typeof originalWsArchive === 'function') {
    wsCtrl.archiveSession = async function archiveSession(request) {
      const res = await originalWsArchive.call(this, request)
      if (request?.sessionId) {
        await cleanEmptySessionDir(request.sessionId, iso, registry())
      }
      return res
    }
  }

  return () => {
    controller().create = originalCreate
    if (typeof originalRename === 'function') controller().rename = originalRename
    if (typeof originalDelete === 'function') controller().delete = originalDelete
    if (typeof originalWsArchive === 'function') wsCtrl.archiveSession = originalWsArchive
    if (typeof originalList === 'function') controller().list = originalList
    if (typeof originalStateList === 'function' && controller()?.listState) {
      controller().listState.list = originalStateList
    }
    if (typeof originalOpenWorkspacePath === 'function') {
      controller().openWorkspacePath = originalOpenWorkspacePath
    }
  }
}

/**
 * Wrap ctx.fs.resolve so tool operations (write, edit, read, etc.) automatically
 * translate pre-rename directory paths to their new renamed directory paths.
 * @param ctx - Cordis context
 * @param iso - shared isolation state
 * @returns disposer
 */
export function patchFs(ctx, iso) {
  const getFs = () => {
    try {
      return typeof ctx.get === 'function'
        ? (ctx.get('fs', false) ?? ctx.root?.get?.('fs', false))
        : (ctx.fs ?? ctx.root?.fs)
    } catch {
      return undefined
    }
  }

  const fs = getFs()
  if (!fs || typeof fs.resolve !== 'function') return () => {}

  const originalResolve = fs.resolve
  fs.resolve = async function resolve(path, options) {
    let target = path
    if (typeof path === 'string') {
      target = iso.rewritePath?.(path) ?? path
    }
    return await originalResolve.call(this, target, options)
  }

  return () => {
    fs.resolve = originalResolve
  }
}

/**
 * Wrap workingDirectory service so all tool executions (write, edit, bash, etc.)
 * immediately track renamed session working directories without throwing ENOENT.
 * @param ctx - Cordis context
 * @param iso - shared isolation state
 * @returns disposer
 */
export function patchWorkingDirectory(ctx, iso) {
  const getWd = () => {
    try {
      return typeof ctx.get === 'function'
        ? (ctx.get('workingDirectory', false) ?? ctx.root?.get?.('workingDirectory', false))
        : (ctx.workingDirectory ?? ctx.root?.workingDirectory)
    } catch {
      return undefined
    }
  }

  const wd = getWd()
  if (!wd) return () => {}

  const originalGet = wd.get
  const originalEnsure = wd.ensure

  if (typeof originalGet === 'function') {
    wd.get = function get(session) {
      const sessionId = session?.id
      if (sessionId) {
        const isolated = iso.sessionPath(sessionId)
        if (isolated !== undefined) {
          return isolated
        }
      }
      return originalGet.call(this, session)
    }
  }

  if (typeof originalEnsure === 'function') {
    wd.ensure = async function ensure(agent, signal) {
      const sessionId = agent?.session?.id
      if (sessionId) {
        const isolated = iso.sessionPath(sessionId)
        if (isolated !== undefined) {
          const session = agent?.session
          if (session) {
            if (typeof session.append === 'function') {
              const handle = wd.workingDirectoryProjectionHandle
              const currentProj = handle?.stateOf?.(session)
              if (currentProj !== isolated) {
                session.append('working-directory/change', { cwd: isolated })
              }
            }
          }
          return isolated
        }
      }
      return await originalEnsure.call(this, agent, signal)
    }
  }

  return () => {
    if (typeof originalGet === 'function') wd.get = originalGet
    if (typeof originalEnsure === 'function') wd.ensure = originalEnsure
  }
}

/**
 * Rename a session's directory directly to reflect its determined human title.
 * Directly renames in-place without creating any symlinks or aliases, and
 * immediately synchronizes workingDirectory and live session state.
 * @param {string} sessionId
 * @param {string} title
 * @param {object} iso - isolation state
 * @param {object} registry - workspaceRegistry service
 * @param {object} [ctx] - Cordis context
 * @param {object} [sessionObj] - live session object if available
 */
export async function renameSessionDirToTitle(sessionId, title, iso, registry, ctx, sessionObj) {
  let currentDir = iso.sessionPath(sessionId)
  if (!currentDir) {
    currentDir = await resolveSessionDir(undefined, { sessionId, iso, ctx })
  }
  if (!currentDir) return

  const clean = sanitizeTitleForPath(title)
  if (!clean) return

  const parent = iso.ownerOf(currentDir)
  if (!parent) return

  const currentBase = basename(currentDir)
  if (currentBase.includes(clean)) return

  const short = shortSessionId(sessionId)
  const targetName = `${SESSION_DIR_PREFIX}${clean}-${short}`
  const targetDir = resolve(join(parent, targetName))

  if (targetDir === currentDir) return

  try {
    const exists = await stat(targetDir).then(() => true).catch(() => false)
    if (exists) return

    // 1. Direct in-place rename — no symlinks or aliases created
    await rename(currentDir, targetDir)

    // 2. Record rename in iso for path rewriting (ctx.fs.resolve, etc.)
    iso.recordRename?.(currentDir, targetDir)

    // 3. Update iso mapping immediately (source of truth for workingDirectory.get & ensure)
    iso.recordSessionPath(sessionId, targetDir)

    // 4. Update workspaceRegistry index
    if (typeof registry?.rememberSessionPath === 'function') {
      registry.rememberSessionPath(sessionId, targetDir)
    }

    // 5. Update the live session's working-directory projection event and header
    const sessionsService = typeof ctx?.get === 'function' ? ctx.get('sessions', false) : ctx?.sessions
    const agentsService = typeof ctx?.get === 'function' ? ctx.get('agents', false) : ctx?.agents

    const liveAgent = agentsService?.get?.(sessionId)
    const targetSession = sessionObj ??
      sessionsService?.get?.(sessionId)?.session ??
      sessionsService?.get?.(sessionId) ??
      liveAgent?.session

    if (targetSession) {
      if (typeof targetSession.append === 'function') {
        targetSession.append('working-directory/change', { cwd: targetDir })
      }
    }

    // 6. Post-rename cleanup guard: If currentDir is ever re-created by an in-flight tool call,
    // merge files to targetDir and delete currentDir!
    const guardCheck = async () => {
      try {
        const recheck = await stat(currentDir).then(() => true).catch(() => false)
        if (recheck) {
          const entries = await readdir(currentDir)
          for (const name of entries) {
            if (name === '.DS_Store') continue
            await rename(join(currentDir, name), join(targetDir, name)).catch(() => {})
          }
          await rm(currentDir, { recursive: true, force: true }).catch(() => {})
        }
      } catch {}
    }
    setTimeout(guardCheck, 500)?.unref?.()
    setTimeout(guardCheck, 2000)?.unref?.()
    setTimeout(guardCheck, 6000)?.unref?.()
  } catch {
    // Ignore rename failures gracefully to avoid disrupting active session
  }
}

/**
 * Public service API for scratch workspace management.
 * @param ctx - Cordis context.
 * @param iso - shared isolation state.
 * @returns service API.
 */
export function isolatedSessionsApi(ctx, iso) {
  const registry = () => ctx.root?.workspaceRegistry ?? ctx.workspaceRegistry
  const requirePath = (workspaceId) => {
    const path = registry()?.get?.(workspaceId)?.path
    if (typeof path !== 'string' || path === '') {
      throw new Error(`dsh-scratch-workspace: unknown workspace ${JSON.stringify(workspaceId)}`)
    }
    return path
  }

  return {
    list: () => [...iso.roots()],
    isIsolated: workspaceId => iso.workspaceRoot(workspaceId) !== undefined,
    async setIsolated(workspaceId, enabled) {
      const path = requirePath(workspaceId)
      const isolates = await setIsolated(path, enabled)
      await iso.scan()
      return { workspaceId, path, isolates }
    },
    async setIsolatedPath(path, enabled) {
      const isolates = await setIsolated(path, enabled)
      await iso.scan()
      return { path, isolates }
    },
    async cleanOrphans(options = {}) {
      const registryInstance = registry()
      const known = new Set()
      const archived = new Set(registryInstance?.archivedSessionIds ?? [])
      for (const ws of registryInstance?.list?.() ?? []) {
        for (const id of ws.sessionIds ?? []) {
          if (!archived.has(id)) known.add(id)
        }
      }
      return await cleanOrphans({
        roots: iso.roots(),
        knownSessionIds: known,
        ...options,
        logger: ctx.logger,
      })
    },
  }
}
