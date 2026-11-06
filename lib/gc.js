/**
 * Disk Cleanliness (磁盘常态洁净): Lifecycle garbage collection for ephemeral
 * session directories, empty abandoned folders, and orphan directories.
 * @module dsh-scratch-workspace/lib/gc
 */

import { readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_DIR_PATTERN } from './isolate.js'

/** Default TTL for orphan session directories: 24 hours. */
export const DEFAULT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000

/** Grace period for empty abandoned session folders: 5 minutes. */
export const EMPTY_SESSION_GRACE_MS = 5 * 60 * 1000

/**
 * Check whether a directory is empty (ignoring system artifacts like .DS_Store).
 * @param dir - absolute directory path.
 * @returns true if directory contains no meaningful files.
 */
export async function isDirectoryEmpty(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const meaningful = entries.filter(e => e.name !== '.DS_Store' && e.name !== 'Thumbs.db')
    return meaningful.length === 0
  } catch {
    return false
  }
}

/**
 * Remove one session directory safely.
 * @param sessionDir - absolute path of session directory.
 */
export async function removeSessionDir(sessionDir) {
  try {
    await rm(sessionDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Normalize session ID to its 8-char short prefix for directory matching.
 * @param id - full session ID (e.g. "session-de59473b-0408-...")
 * @returns 8-character hex prefix
 */
export function shortSessionId(id) {
  const flattened = String(id).replace(/^session-/, '').replaceAll('-', '')
  return flattened.slice(0, 8).toLowerCase()
}

/**
 * Scan isolating roots and clean up orphan and empty abandoned session folders.
 * @param options - execution parameters.
 * @returns summary of cleaned directories.
 */
export async function cleanOrphans({
  roots = [],
  knownSessionIds = new Set(),
  orphanTtlMs = DEFAULT_ORPHAN_TTL_MS,
  emptyGraceMs = EMPTY_SESSION_GRACE_MS,
  now = Date.now(),
  logger,
} = {}) {
  const cleaned = []
  const knownShortIds = new Set([...knownSessionIds].map(shortSessionId))

  for (const root of roots) {
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }

    // Index titled folders in this root: shortId -> titledDirPath
    const titledFolders = new Map()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const match = entry.name.match(SESSION_DIR_PATTERN)
      if (match && match[1]) {
        const short = match[2].split('-')[0].toLowerCase()
        titledFolders.set(short, join(root, entry.name))
      }
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        const match = entry.name.match(SESSION_DIR_PATTERN)
        if (match) {
          const linkPath = join(root, entry.name)
          await rm(linkPath, { force: true }).catch(() => {})
          cleaned.push({ path: linkPath, reason: 'legacy-symlink' })
          logger?.info?.(`dsh-scratch-workspace gc: removed legacy symlink ${linkPath}`)
          continue
        }
      }
      if (!entry.isDirectory()) continue
      const match = entry.name.match(SESSION_DIR_PATTERN)
      if (!match) continue

      const dirPath = join(root, entry.name)
      const folderShort = (match[2] ?? match[1] ?? '').split('-')[0].toLowerCase()

      try {
        // Case 0: Pre-rename duplicate leftover whose titled folder already exists
        if (!match[1] && titledFolders.has(folderShort)) {
          const titledDir = titledFolders.get(folderShort)
          try {
            const subEntries = await readdir(dirPath)
            for (const sub of subEntries) {
              if (sub === '.DS_Store' || sub === 'Thumbs.db') continue
              await rename(join(dirPath, sub), join(titledDir, sub)).catch(() => {})
            }
          } catch {}
          await removeSessionDir(dirPath)
          cleaned.push({ path: dirPath, reason: 'pre-rename-duplicate' })
          logger?.info?.(`dsh-scratch-workspace gc: removed pre-rename duplicate dir ${dirPath}`)
          continue
        }

        const info = await stat(dirPath)
        const ageMs = now - info.mtimeMs

        // Case 1: Empty abandoned session folder past grace period
        const empty = await isDirectoryEmpty(dirPath)
        if (empty && ageMs >= emptyGraceMs) {
          await removeSessionDir(dirPath)
          cleaned.push({ path: dirPath, reason: 'empty-abandoned' })
          logger?.info?.(`dsh-scratch-workspace gc: removed empty session dir ${dirPath}`)
          continue
        }

        // Case 2: Orphan session directory no longer associated with any session
        const hasSession = knownShortIds.has(folderShort)
        if (!hasSession && ageMs > orphanTtlMs) {
          await removeSessionDir(dirPath)
          cleaned.push({ path: dirPath, reason: 'orphan-ttl' })
          logger?.info?.(`dsh-scratch-workspace gc: removed orphan session dir ${dirPath}`)
        }
      } catch {
        // Ignore races with active filesystem operations
      }
    }
  }

  return cleaned
}

/**
 * Setup automatic periodic GC.
 * @param ctx - Cordis context.
 * @param iso - shared isolation state.
 * @param options - GC interval and TTL configuration.
 * @returns disposer function.
 */
export function setupAutoGc(ctx, iso, {
  intervalMs = 30 * 60 * 1000,
  orphanTtlMs = DEFAULT_ORPHAN_TTL_MS,
} = {}) {
  let timer = null

  async function collectKnownSessions() {
    const ids = new Set()
    // Live sessions from registry
    const registry = ctx.root?.workspaceRegistry ?? ctx.workspaceRegistry
    const workspaces = registry?.list?.() ?? []
    for (const ws of workspaces) {
      for (const id of ws.sessionIds ?? []) ids.add(id)
    }
    // Live agents
    const agents = ctx.agents ?? ctx.root?.agents
    if (typeof agents?.list === 'function') {
      for (const ag of agents.list() ?? []) if (ag?.id) ids.add(ag.id)
    }
    // Stored headers if available
    try {
      const stored = await registry?.listStoredHeaders?.()
      if (Array.isArray(stored)) {
        for (const h of stored) if (h?.id) ids.add(h.id)
      }
    } catch {}

    return ids
  }

  async function triggerGc() {
    try {
      const known = await collectKnownSessions()
      const roots = iso.roots()
      await cleanOrphans({
        roots,
        knownSessionIds: known,
        orphanTtlMs,
        logger: ctx.logger,
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-scratch-workspace gc failed: ${error?.message ?? error}`)
    }
  }

  // Initial GC after host settles (10 seconds)
  const initialTimeout = setTimeout(triggerGc, 10_000)

  // Periodic GC
  timer = setInterval(triggerGc, intervalMs)

  return () => {
    clearTimeout(initialTimeout)
    if (timer) clearInterval(timer)
  }
}
