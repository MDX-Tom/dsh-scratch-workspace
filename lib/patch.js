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
  SESSION_DIR_PREFIX,
  setIsolated,
} from './isolate.js'
import { cleanOrphans, isDirectoryEmpty, removeSessionDir, shortSessionId } from './gc.js'

/** The registry-internal host property. */
const HOST_PROPERTY = 'host'

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
  const originalArchive = registry?.archiveSession
  if (typeof originalArchive === 'function') {
    registry.archiveSession = async function archiveSession(sessionId, options) {
      const res = await originalArchive.call(this, sessionId, options)
      if (sessionId) {
        const sessionDir = iso.sessionPath(sessionId)
        if (sessionDir) {
          const empty = await isDirectoryEmpty(sessionDir).catch(() => false)
          if (empty) {
            iso.forgetSession(sessionId)
            await removeSessionDir(sessionDir).catch(() => {})
          }
        }
      }
      return res
    }
  }

  return () => {
    if (typeof originalMatches === 'function') target.candidateMatches = originalMatches
    if (typeof originalRemember === 'function') target.rememberSessionPath = originalRemember
    if (typeof originalPath === 'function') target.sessionPath = originalPath
    if (typeof originalArchive === 'function') registry.archiveSession = originalArchive
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

    // Check if request0.sessionId is an existing blank session.
    // In an isolating workspace, if request0.sessionId already has a recorded cwd in DSH,
    // or is already tracked in isolation, drop it so a fresh unique session is minted,
    // avoiding ApiSessionCwdConflict and duplicate directory naming.
    let targetSessionId = request0.sessionId
    if (targetSessionId !== undefined) {
      const trackedPath = typeof iso?.sessionPath === 'function' ? iso.sessionPath(targetSessionId) : undefined
      if (trackedPath !== undefined) {
        targetSessionId = undefined
      } else {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions', false) : ctx.sessions
        const agents = typeof ctx.get === 'function' ? ctx.get('agents', false) : ctx.agents
        const live = sessions?.get?.(targetSessionId) ?? agents?.get?.(targetSessionId)
        const existingCwd = live?.session?.header?.cwd
        if (existingCwd !== undefined) {
          targetSessionId = undefined
        } else {
          const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery', false) : ctx.sessionQuery
          if (typeof query?.observeSession === 'function') {
            try {
              const obs = await query.observeSession(targetSessionId)
              if (obs?.header?.cwd !== undefined) {
                targetSessionId = undefined
              }
            } catch {}
          }
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
                iso.recordRename?.(fallbackCwd, correctDir)
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
            iso.recordRename?.(cwd, correctDir)
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
      const sessionDir = sessionId ? iso.sessionPath(sessionId) : undefined
      try {
        return await originalDelete.call(this, req)
      } finally {
        if (sessionDir) {
          iso.forgetSession(sessionId)
          await removeSessionDir(sessionDir)
        }
      }
    }
  }

  return () => {
    controller().create = originalCreate
    if (typeof originalRename === 'function') controller().rename = originalRename
    if (typeof originalDelete === 'function') controller().delete = originalDelete
  }
}

/**
 * Helper to patch a method across an object and its entire prototype chain
 * up to Object.prototype, ensuring every Cordis service proxy, derived instance,
 * and caller shares the patched behavior.
 * @param {object} obj - target instance or service
 * @param {string} methodName - method to wrap
 * @param {Function} wrapper - function taking original method and returning new method
 * @returns {Function} disposer restoring all patched methods
 */
function patchMethod(obj, methodName, wrapper) {
  if (!obj) return () => {}
  const targets = []
  let curr = obj
  while (curr && curr !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(curr, methodName) || typeof curr[methodName] === 'function') {
      targets.push({ target: curr, original: curr[methodName] })
    }
    curr = Object.getPrototypeOf(curr)
  }
  if (!targets.some(t => t.target === obj) && typeof obj[methodName] === 'function') {
    targets.push({ target: obj, original: obj[methodName] })
  }
  for (const item of targets) {
    item.target[methodName] = wrapper(item.original)
  }
  return () => {
    for (const item of targets) {
      item.target[methodName] = item.original
    }
  }
}

/**
 * Wrap ctx.fs (resolve, stat, lstat) so tool operations (write, edit, read, etc.) automatically
 * translate pre-rename directory paths to their new renamed directory paths across all contexts.
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
  if (!fs) return () => {}

  const disposers = []

  // Wrap fs.resolve
  disposers.push(patchMethod(fs, 'resolve', (originalResolve) => {
    if (typeof originalResolve !== 'function') return originalResolve
    return async function resolve(path, options) {
      const targetPath = typeof path === 'string' ? (iso.rewritePath?.(path) ?? path) : path
      let targetOpts = options
      if (options?.cwd && typeof options.cwd === 'string') {
        const rewrittenCwd = iso.rewritePath?.(options.cwd) ?? options.cwd
        if (rewrittenCwd !== options.cwd) {
          targetOpts = { ...options, cwd: rewrittenCwd }
        }
      }
      return await originalResolve.call(this, targetPath, targetOpts)
    }
  }))

  // Wrap fs.stat
  disposers.push(patchMethod(fs, 'stat', (originalStat) => {
    if (typeof originalStat !== 'function') return originalStat
    return async function stat(target, signal) {
      let effectiveTarget = target
      if (target && typeof target === 'object' && typeof target.targetKey === 'string') {
        const rewritten = iso.rewritePath?.(target.targetKey)
        if (rewritten && rewritten !== target.targetKey) {
          effectiveTarget = { ...target, targetKey: rewritten }
        }
      } else if (typeof target === 'string') {
        effectiveTarget = iso.rewritePath?.(target) ?? target
      }
      return await originalStat.call(this, effectiveTarget, signal)
    }
  }))

  // Wrap fs.lstat
  disposers.push(patchMethod(fs, 'lstat', (originalLstat) => {
    if (typeof originalLstat !== 'function') return originalLstat
    return async function lstat(path, opts, signal) {
      const targetPath = typeof path === 'string' ? (iso.rewritePath?.(path) ?? path) : path
      let targetOpts = opts
      if (opts?.cwd && typeof opts.cwd === 'string') {
        const rewrittenCwd = iso.rewritePath?.(opts.cwd) ?? opts.cwd
        if (rewrittenCwd !== opts.cwd) {
          targetOpts = { ...opts, cwd: rewrittenCwd }
        }
      }
      return await originalLstat.call(this, targetPath, targetOpts, signal)
    }
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Wrap workingDirectory service so all tool executions (write, edit, bash, etc.)
 * immediately track renamed session working directories without throwing ENOENT.
 * Patches get, ensure, and directory across instance and prototype hierarchy.
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

  const disposers = []

  // Wrap wd.get
  disposers.push(patchMethod(wd, 'get', (originalGet) => {
    if (typeof originalGet !== 'function') return originalGet
    return function get(session) {
      const sessionId = session?.id
      if (sessionId) {
        const isolated = iso.sessionPath(sessionId)
        if (isolated !== undefined) {
          if (session?.header) session.header.cwd = isolated
          return isolated
        }
      }
      if (session?.header?.cwd) {
        const rewritten = iso.rewritePath?.(session.header.cwd)
        if (rewritten && rewritten !== session.header.cwd) {
          session.header.cwd = rewritten
          return rewritten
        }
      }
      const raw = originalGet.call(this, session)
      return typeof raw === 'string' ? (iso.rewritePath?.(raw) ?? raw) : raw
    }
  }))

  // Wrap wd.ensure
  disposers.push(patchMethod(wd, 'ensure', (originalEnsure) => {
    if (typeof originalEnsure !== 'function') return originalEnsure
    return async function ensure(agent, signal) {
      const sessionId = agent?.session?.id ?? agent?.id
      let isolated = sessionId ? iso.sessionPath(sessionId) : undefined
      if (!isolated && agent?.session?.header?.cwd) {
        const rewritten = iso.rewritePath?.(agent.session.header.cwd)
        if (rewritten && rewritten !== agent.session.header.cwd) {
          isolated = rewritten
        }
      }
      if (isolated !== undefined) {
        const session = agent?.session
        if (session) {
          if (session.header) session.header.cwd = isolated
          if (typeof session.append === 'function') {
            try {
              const handle = this.workingDirectoryProjectionHandle
              const currentProj = handle?.stateOf?.(session)
              if (currentProj !== isolated) {
                session.append('working-directory/change', { cwd: isolated })
              }
            } catch {}
          }
        }
        return isolated
      }
      return await originalEnsure.call(this, agent, signal)
    }
  }))

  // Wrap wd.directory
  disposers.push(patchMethod(wd, 'directory', (originalDirectory) => {
    if (typeof originalDirectory !== 'function') return originalDirectory
    return async function directory(path, cwd, signal) {
      const targetPath = typeof path === 'string' ? (iso.rewritePath?.(path) ?? path) : path
      const targetCwd = typeof cwd === 'string' ? (iso.rewritePath?.(cwd) ?? cwd) : cwd
      return await originalDirectory.call(this, targetPath, targetCwd, signal)
    }
  }))

  return () => {
    for (const dispose of disposers) dispose()
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
  const currentDir = iso.sessionPath(sessionId)
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
      if (targetSession.header) targetSession.header.cwd = targetDir
      if (typeof targetSession.append === 'function') {
        targetSession.append('working-directory/change', { cwd: targetDir })
      }
    }
    if (liveAgent?.session?.header) {
      liveAgent.session.header.cwd = targetDir
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
      for (const ws of registryInstance?.list?.() ?? []) {
        for (const id of ws.sessionIds ?? []) known.add(id)
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
