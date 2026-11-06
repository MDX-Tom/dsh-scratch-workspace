/**
 * Shared isolation state: tracks which Workspace directories isolate sessions,
 * session directory mappings, and redirect locks.
 * @module dsh-scratch-workspace/lib/state
 */

import { isIsolated, owningRoot } from './isolate.js'

/**
 * Build the state holder over a live Workspace registry.
 * @param ctx - Cordis context.
 * @returns state API.
 */
export function createIsolationState(ctx) {
  const probe = (candidate) => {
    try {
      candidate?.list?.()
      return candidate
    } catch {
      return undefined
    }
  }

  const registry = () => {
    const candidates = [ctx.root?.workspaceRegistry, ctx.workspaceRegistry]
    const live = candidates.filter(candidate => probe(candidate) !== undefined)
    if (live.length === 0) return ctx.workspaceRegistry
    return live.reduce((best, candidate) =>
      (candidate.list().length > best.list().length ? candidate : best))
  }

  async function settledRegistry(signal) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = registry()
      if ((candidate?.list?.().length ?? 0) > 0) return candidate
      await new Promise(resolve => setTimeout(resolve, 5))
      if (signal?.aborted === true) return undefined
    }
    return registry()
  }

  /** Canonical paths of currently isolating Workspaces. */
  let roots = []
  /** In-flight redirect counter. */
  let redirects = 0
  /** Serialization tail for scans. */
  let tail = Promise.resolve()
  /** Map of sessionId -> private sessionDir. */
  const sessionPathMap = new Map()
  /** Map of oldDir -> targetDir for path rewriting after title-based renames. */
  const renamedPathsMap = new Map()

  /** Find default workspace path if available. */
  function defaultWorkspacePath() {
    const list = registry()?.list?.() ?? []
    const def = list.find(w => w.id === 'default-workspace' || w.title === 'default-workspace' || w.record?.isDefault === true)
    return def?.path ?? ctx.sessionController?.defaultCwd
  }

  async function scan() {
    const guarded = redirects > 0
    const workspaces = registry()?.list?.() ?? []
    const defPath = defaultWorkspacePath()
    const found = []
    for (const workspace of workspaces) {
      const path = workspace?.path
      if (typeof path !== 'string' || path === '') continue
      if (await isIsolated(path, defPath)) found.push(path)
    }
    roots = guarded ? [...new Set([...roots, ...found])] : found
    return [...roots]
  }

  function schedule() {
    const next = tail.then(scan, scan).then(scan, scan)
    tail = next.then(() => {}, () => {})
    return next
  }

  function workspaceRoot(workspaceId) {
    const path = registry()?.get?.(workspaceId)?.path
    if (typeof path !== 'string' || path === '') return undefined
    return roots.includes(path) ? path : undefined
  }

  return {
    scan: schedule,
    settledRegistry,
    scanNow: scan,
    workspaceRoot,
    roots: () => [...roots],
    ownerOf: path => (typeof path === 'string' ? owningRoot(roots, path) : undefined),
    recordSessionPath: (id, path) => {
      if (id && path) sessionPathMap.set(id, path)
    },
    sessionPath: id => sessionPathMap.get(id),
    forgetSession: id => sessionPathMap.delete(id),
    recordRename: (oldDir, targetDir) => {
      if (oldDir && targetDir && oldDir !== targetDir) {
        renamedPathsMap.set(oldDir, targetDir)
        // Update transitive renames: if X -> oldDir, update to X -> targetDir
        for (const [prevOld, prevTarget] of renamedPathsMap.entries()) {
          if (prevTarget === oldDir) {
            renamedPathsMap.set(prevOld, targetDir)
          }
        }
      }
    },
    rewritePath: (p) => {
      if (typeof p !== 'string' || p === '') return p
      for (const [oldDir, targetDir] of renamedPathsMap.entries()) {
        if (p === oldDir) return targetDir
        if (p.startsWith(oldDir + '/') || p.startsWith(oldDir + '\\')) {
          return targetDir + p.slice(oldDir.length)
        }
      }
      return p
    },
    beginRedirect: () => { redirects += 1 },
    endRedirect: () => { redirects = Math.max(0, redirects - 1) },
    clear: () => {
      roots = []
      sessionPathMap.clear()
      renamedPathsMap.clear()
    },
  }
}
