/**
 * dsh-scratch-workspace — Ephemeral Scratch Workspace & Session Isolation for DeepSeek Harness (DSH).
 *
 * Provides:
 * 1. Per-session sandbox working directory (session-<id>) within parent workspaces.
 * 2. Permanent multi-version compatibility across DSH 0.1.x and 0.2.x+.
 * 3. Sidebar cleanliness with automatic session grouping under parent workspaces.
 * 4. Disk cleanliness with automatic lifecycle GC for empty and orphan directories.
 * @module dsh-scratch-workspace
 */

import { createIsolationState } from './lib/state.js'
import { isolatedSessionsApi, patchRegistry, patchSessionCreate } from './lib/patch.js'
import { setupAutoGc } from './lib/gc.js'
import { registerIsolationTool } from './lib/tool.js'
import { registerWebRoutes } from './lib/web.js'

export const inject = ['sessionController', 'workspaceRegistry', 'tools']

async function apply(ctx) {
  const iso = createIsolationState(ctx)

  const unpatchRegistry = patchRegistry(ctx.root?.workspaceRegistry ?? ctx.workspaceRegistry, iso)
  const unpatchCreate = patchSessionCreate(ctx, iso)

  const api = isolatedSessionsApi(ctx, iso)
  const provideIsolation = ctx.provide('isolatedSessions', api)
  const provideScratch = ctx.provide('scratchWorkspace', api)

  const unregisterTool = registerIsolationTool(ctx, iso)
  const stopGc = setupAutoGc(ctx, iso)

  await iso.scan()
  const stopWatching = ctx.on('domain/changed', (change) => {
    if (change?.domain !== 'workspace') return
    void iso.scan().catch(() => {})
  })

  const webServer = ctx.get('webServer', false)
  const offRoutes = webServer === undefined ? undefined : registerWebRoutes(ctx, webServer, iso)

  ctx.logger?.info?.(
    `dsh-scratch-workspace ready: ${iso.roots().length} isolating director${iso.roots().length === 1 ? 'y' : 'ies'}`,
  )

  ctx.effect(() => () => {
    offRoutes?.()
    stopWatching()
    stopGc()
    unregisterTool()
    provideScratch()
    provideIsolation()
    unpatchCreate()
    unpatchRegistry()
    iso.clear()
  }, 'dsh-scratch-workspace.patches')
}

apply.inject = inject

export default apply
