/**
 * Isolation policy: which directories isolate their sessions, and where one
 * session's private directory lands.
 *
 * The durable marker is a per-directory `.dsh-isolate` file. In addition,
 * default-workspace can be automatically isolated to keep ad-hoc explorations
 * clean without manual intervention.
 * @module dsh-scratch-workspace/lib/isolate
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** Marker file that switches one directory to per-session working folders. */
export const MARKER_NAME = '.dsh-isolate'

/** Prefix of every per-session working directory. */
export const SESSION_DIR_PREFIX = 'session-'

/** Regex matching session directory names, supporting both raw shortIds and titled formats. */
export const SESSION_DIR_PATTERN = /^session-(?:(.*)-)?([0-9a-fA-F]{8,36}(?:-\d+)?)$/

/**
 * Sanitize a human session title for filesystem folder naming.
 * Strips path separators, illegal filename characters, and limits length.
 * @param {string} title
 * @param {number} [maxChars=30]
 * @returns {string}
 */
export function sanitizeTitleForPath(title, maxChars = 30) {
  if (typeof title !== 'string') return ''
  const cleaned = title
    .replace(/[\/\\:*?"<>|#\x00-\x1f]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .trim()
  return cleaned.slice(0, maxChars).replace(/^-+|-+$/g, '')
}

/**
 * Whether a session title is meaningful (not a default placeholder).
 * @param {string} title
 * @returns {boolean}
 */
export function isMeaningfulTitle(title) {
  if (typeof title !== 'string') return false
  const trimmed = title.trim().toLowerCase()
  if (!trimmed) return false
  const placeholders = new Set([
    '新会话', '新建会话', 'new session', 'new chat', 'untitled', '新任务', 'new task'
  ])
  return !placeholders.has(trimmed)
}

/** The one separator that follows a root spelling in a prefix test. */
const SEPARATORS = new Set(['/', '\\'])

/** Whether `child` is `root` itself or lies inside it (both canonical absolute paths). */
export function sameOrInside(root, child) {
  if (child === root) return true
  const prefix = root !== '' && SEPARATORS.has(root.at(-1)) ? root : root + sep
  return child.startsWith(prefix)
}

/**
 * Whether one directory currently isolates its sessions.
 * @param root - absolute directory path.
 * @param defaultPath - optional default workspace path to auto-isolate.
 * @returns true when marked or when matching the default workspace.
 */
export async function isIsolated(root, defaultPath) {
  if (typeof root !== 'string' || root === '') return false
  if (defaultPath && root === defaultPath) return true
  try {
    return (await stat(join(root, MARKER_NAME))).isFile()
  } catch {
    return false
  }
}

/** The comment a freshly written marker carries. */
const MARKER_TEXT = [
  '# DeepSeek Harness per-session working directories',
  '#',
  '# While this file exists, every new session created in this directory works in',
  '# its own "session-<id>" subfolder instead of the directory itself, so',
  '# concurrent sessions cannot overwrite each other\'s files.',
  '#',
  '# Delete this file to share one working directory again. Sessions already',
  '# created keep the folder they were created in.',
  '',
].join('\n')

/**
 * Enable or disable isolation for one directory by writing or removing its marker.
 * @param root - absolute directory path.
 * @param enabled - target state.
 * @returns the state that is now on disk.
 */
export async function setIsolated(root, enabled) {
  const marker = join(root, MARKER_NAME)
  if (!enabled) {
    await rm(marker, { force: true })
    return false
  }
  await mkdir(root, { recursive: true })
  await writeFile(marker, MARKER_TEXT, 'utf8')
  return true
}

/**
 * Every marked directory that is an ancestor of `path`, nearest first.
 * @param roots - candidate marked directories.
 * @param path - absolute directory to test.
 * @returns matching roots in nearest-first order.
 */
export function containingRoots(roots, path) {
  return [...roots]
    .filter(root => sameOrInside(root, path))
    .sort((left, right) => right.length - left.length)
}

/**
 * The nearest marked ancestor of `path`, if any.
 * @param roots - candidate marked directories.
 * @param path - absolute directory to test.
 * @returns the owning marked directory, or undefined.
 */
export function owningRoot(roots, path) {
  return containingRoots(roots, path)[0]
}

/**
 * Allocate one private directory for a session under an isolating directory.
 *
 * The name keeps the `session-<id>` shape: the first eight characters of
 * the session id, with `-2`, `-3`, … on collision.
 * If a collided candidate is completely empty (abandoned draft), it is reused.
 * @param root - isolating directory.
 * @param sessionId - the session's id.
 * @param isDirectoryEmptyFn - optional predicate to check if an existing folder is empty.
 * @returns the absolute directory path, created on disk.
 */
export async function allocateSessionDir(root, sessionId, isDirectoryEmptyFn) {
  const flattened = String(sessionId).replace(/^session-/, '').replaceAll('-', '')
  const short = flattened.slice(0, 8) === '' ? 'unknown' : flattened.slice(0, 8)
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`
    const candidate = resolve(join(root, `${SESSION_DIR_PREFIX}${short}${suffix}`))
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
        if (typeof isDirectoryEmptyFn === 'function') {
          const empty = await isDirectoryEmptyFn(candidate).catch(() => false)
          if (empty) return candidate
        }
        continue
      }
      throw error
    }
  }
}
