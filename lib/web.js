/**
 * HTTP routes backing the Settings → Plugins GUI page.
 * @module dsh-scratch-workspace/lib/web
 */

import { Readable } from 'node:stream'
import { stat } from 'node:fs/promises'
import { resolveSessionDir } from './patch.js'

export const LIST_ROUTE = '/scratch-workspace/workspaces'
export const TOGGLE_ROUTE = '/scratch-workspace/toggle'
export const GC_ROUTE = '/scratch-workspace/gc'

// Backwards-compatibility aliases for dsh-session-isolation
export const LEGACY_LIST_ROUTE = '/session-isolation/workspaces'
export const LEGACY_TOGGLE_ROUTE = '/session-isolation/toggle'

export const OPEN_IN_APP_OPEN_PATH = '/open-in-app/open'

const MAX_BODY_BYTES = 4096

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function snapshot(ctx, iso) {
  const registry = ctx.workspaceRegistry ?? ctx.root?.workspaceRegistry
  const workspaces = registry?.list?.() ?? []
  const isolated = new Set(iso.roots())
  const entries = workspaces.map((workspace) => {
    const path = workspace.path
    return {
      workspaceId: String(workspace.id),
      title: workspace.title,
      path,
      isolates: isolated.has(path),
      sessionCount: workspace.sessionIds?.length ?? 0,
    }
  }).sort((left, right) => left.title.localeCompare(right.title))

  return {
    workspaces: entries,
    isolatedCount: entries.filter(entry => entry.isolates).length,
  }
}

export function registerWebRoutes(ctx, webServer, iso) {
  const disposers = []

  const handleList = (_req, res) => {
    try {
      json(res, 200, snapshot(ctx, iso))
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleToggle = async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'use POST' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const { workspaceId, enabled } = body ?? {}
      if (typeof workspaceId !== 'string' || workspaceId === '' || typeof enabled !== 'boolean') {
        json(res, 400, { error: 'body must be { workspaceId: string, enabled: boolean }' })
        return
      }
      const service = ctx.isolatedSessions ?? ctx.scratchWorkspace
      await service.setIsolated(workspaceId, enabled)
      json(res, 200, snapshot(ctx, iso))
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleGc = async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'use POST' })
      return
    }
    try {
      const service = ctx.isolatedSessions ?? ctx.scratchWorkspace
      const cleaned = await service.cleanOrphans()
      json(res, 200, { success: true, cleanedCount: cleaned.length, cleaned })
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Register modern routes
  disposers.push(webServer.register({ kind: 'exact', path: LIST_ROUTE, handler: handleList }))
  disposers.push(webServer.register({ kind: 'exact', path: TOGGLE_ROUTE, handler: handleToggle }))
  disposers.push(webServer.register({ kind: 'exact', path: GC_ROUTE, handler: handleGc }))

  // Register legacy aliases
  disposers.push(webServer.register({ kind: 'exact', path: LEGACY_LIST_ROUTE, handler: handleList }))
  disposers.push(webServer.register({ kind: 'exact', path: LEGACY_TOGGLE_ROUTE, handler: handleToggle }))

  // Intercept open-in-app to rewrite stale or renamed session directories
  disposers.push(interceptOpenInApp(webServer, iso, ctx))

  return () => {
    for (const d of disposers) d?.()
  }
}

function createFakeReq(originalReq, buffer) {
  const fakeStream = Readable.from([buffer])
  return new Proxy(originalReq, {
    get(target, prop, receiver) {
      if (
        prop === Symbol.asyncIterator ||
        prop === 'read' ||
        prop === 'on' ||
        prop === 'once' ||
        prop === 'pipe' ||
        prop === 'resume' ||
        prop === 'pause'
      ) {
        const val = fakeStream[prop]
        return typeof val === 'function' ? val.bind(fakeStream) : val
      }
      if (prop === 'headers') {
        return {
          ...target.headers,
          'content-length': String(buffer.length),
        }
      }
      const val = Reflect.get(target, prop, receiver)
      return typeof val === 'function' ? val.bind(target) : val
    },
  })
}

export function interceptOpenInApp(webServer, iso, ctx) {
  if (!webServer || typeof webServer.register !== 'function') return () => {}

  const wrapHandler = (originalHandler) => {
    if (typeof originalHandler !== 'function') return originalHandler
    if (originalHandler.__dsh_scratch_wrapped) return originalHandler

    const wrapped = async function openInAppHandler(req, res) {
      if (req.method !== 'POST') {
        return originalHandler(req, res)
      }

      const chunks = []
      let size = 0
      let tooLarge = false
      try {
        for await (const chunk of req) {
          size += chunk.length
          if (size > 65536) {
            tooLarge = true
            break
          }
          chunks.push(chunk)
        }
      } catch {}

      const rawBuffer = Buffer.concat(chunks)
      if (tooLarge) {
        const fakeReq = createFakeReq(req, rawBuffer)
        return originalHandler(fakeReq, res)
      }

      let body = null
      try {
        body = JSON.parse(rawBuffer.toString('utf8'))
      } catch {}

      if (!body || typeof body.path !== 'string') {
        const fakeReq = createFakeReq(req, rawBuffer)
        return originalHandler(fakeReq, res)
      }

      let isDir = false
      try {
        isDir = (await stat(body.path)).isDirectory()
      } catch {
        isDir = false
      }

      if (!isDir) {
        const targetPath = await resolveSessionDir(body.path, { iso, ctx })
        if (targetPath && targetPath !== body.path) {
          body.path = targetPath
          const newBuffer = Buffer.from(JSON.stringify(body), 'utf8')
          const fakeReq = createFakeReq(req, newBuffer)
          return originalHandler(fakeReq, res)
        }
      }

      const fakeReq = createFakeReq(req, rawBuffer)
      return originalHandler(fakeReq, res)
    }

    wrapped.__dsh_scratch_wrapped = true
    wrapped.__dsh_scratch_original = originalHandler
    return wrapped
  }

  // 1. If /open-in-app/open is already registered in webServer.exact
  const existingRoute = webServer.exact?.get(OPEN_IN_APP_OPEN_PATH)
  let originalExactHandler = undefined
  if (existingRoute && typeof existingRoute.handler === 'function') {
    originalExactHandler = existingRoute.handler
    existingRoute.handler = wrapHandler(existingRoute.handler)
  }

  // 2. Wrap webServer.register to catch future /open-in-app/open registrations
  const originalRegister = webServer.register.bind(webServer)
  webServer.register = function (route) {
    if (route?.kind === 'exact' && route?.path === OPEN_IN_APP_OPEN_PATH && typeof route.handler === 'function') {
      route.handler = wrapHandler(route.handler)
    }
    return originalRegister(route)
  }

  return () => {
    webServer.register = originalRegister
    if (existingRoute && originalExactHandler) {
      existingRoute.handler = originalExactHandler
    }
  }
}
