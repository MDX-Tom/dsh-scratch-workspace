/**
 * Compatibility patches for DeepSeek Harness (DSH):
 * 1. Wraps Workspace registry's session-path index for permanent multi-version
 *    compatibility (supporting both candidateMatches in 0.2.x+ and sessionPath in 0.1.x).
 * 2. Wraps sessionController.create to allocate per-session sandbox subfolders
 *    while avoiding ApiSessionCwdConflict when reusing existing blank sessions.
 * 3. Hooks session deletion for immediate disk cleanliness.
 * @module dsh-scratch-workspace/lib/patch
 */

import { rm } from 'node:fs/promises'
import { allocateSessionDir, setIsolated } from './isolate.js'
import { cleanOrphans, removeSessionDir } from './gc.js'

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

  return () => {
    if (typeof originalMatches === 'function') target.candidateMatches = originalMatches
    if (typeof originalRemember === 'function') target.rememberSessionPath = originalRemember
    if (typeof originalPath === 'function') target.sessionPath = originalPath
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

    const cwd = await allocateSessionDir(
      owner,
      request0.sessionId ?? `session-${Date.now().toString(16)}`
    )

    // ApiSessionCwdConflict prevention:
    // If request0.sessionId is an existing blank session minted with the parent
    // workspace cwd, claiming it under a redirected cwd will throw ApiSessionCwdConflict.
    // In that case, omit sessionId so DSH mints a fresh session ID matching the new cwd.
    let effectiveRequest = request0
    if (request0.sessionId !== undefined) {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions', false) : ctx.sessions
      const agents = typeof ctx.get === 'function' ? ctx.get('agents', false) : ctx.agents
      const live = sessions?.get?.(request0.sessionId) ?? agents?.get?.(request0.sessionId)
      const existingCwd = live?.session?.header?.cwd
      if (existingCwd !== undefined && existingCwd !== cwd) {
        const { sessionId: _omitted, ...rest } = request0
        effectiveRequest = rest
      }
    }

    const restore = redirect(request0.workspaceId, cwd)
    try {
      const created = await originalCreate.call(this, effectiveRequest)
      if (created?.sessionId) {
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
    if (typeof originalDelete === 'function') controller().delete = originalDelete
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
