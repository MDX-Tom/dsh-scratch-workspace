/**
 * HTTP routes backing the Settings → Plugins GUI page.
 * @module dsh-scratch-workspace/lib/web
 */

export const LIST_ROUTE = '/scratch-workspace/workspaces'
export const TOGGLE_ROUTE = '/scratch-workspace/toggle'
export const GC_ROUTE = '/scratch-workspace/gc'

// Backwards-compatibility aliases for dsh-session-isolation
export const LEGACY_LIST_ROUTE = '/session-isolation/workspaces'
export const LEGACY_TOGGLE_ROUTE = '/session-isolation/toggle'

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

  return () => {
    for (const d of disposers) d?.()
  }
}
