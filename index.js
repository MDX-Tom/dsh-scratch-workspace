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
import {
  isolatedSessionsApi,
  patchRegistry,
  patchSessionCreate,
  patchWorkingDirectory,
  renameSessionDirToTitle,
} from './lib/patch.js'
import { isMeaningfulTitle } from './lib/isolate.js'
import { setupAutoGc } from './lib/gc.js'
import { registerIsolationTool } from './lib/tool.js'
import { registerCommands } from './lib/command.js'
import { registerWebRoutes } from './lib/web.js'

export const inject = ['sessionController', 'workspaceRegistry', 'tools', 'commands', 'sessions', 'workingDirectory']

async function apply(ctx) {
  const iso = createIsolationState(ctx)

  const unpatchRegistry = patchRegistry(ctx.root?.workspaceRegistry ?? ctx.workspaceRegistry, iso)
  const unpatchCreate = patchSessionCreate(ctx, iso)
  const unpatchWorkingDirectory = patchWorkingDirectory(ctx, iso)

  const api = isolatedSessionsApi(ctx, iso)
  const provideIsolation = ctx.provide('isolatedSessions', api)
  const provideScratch = ctx.provide('scratchWorkspace', api)

  const unregisterTool = registerIsolationTool(ctx, iso)
  const unregisterCommands = registerCommands(ctx, iso, api)
  const stopGc = setupAutoGc(ctx, iso)

  await iso.scan()
  const stopWatching = ctx.on('domain/changed', (change) => {
    if (change?.domain !== 'workspace') return
    void iso.scan().catch(() => {})
  })

  const stopTitleEvents = ctx.on('session/event', async (session, event) => {
    if (event?.type !== 'session/title') return
    const title = event?.data?.title
    if (!isMeaningfulTitle(title)) return
    const sessionId = session?.id
    if (!sessionId) return
    const reg = ctx.root?.workspaceRegistry ?? ctx.workspaceRegistry
    await renameSessionDirToTitle(sessionId, title, iso, reg, ctx, session)
  })

  const webServer = ctx.get('webServer', false)
  const offRoutes = webServer === undefined ? undefined : registerWebRoutes(ctx, webServer, iso)

  ctx.logger?.info?.(
    `dsh-scratch-workspace ready: ${iso.roots().length} isolating director${iso.roots().length === 1 ? 'y' : 'ies'}`,
  )

  ctx.effect(() => () => {
    offRoutes?.()
    stopTitleEvents?.()
    stopWatching()
    stopGc()
    unregisterCommands()
    unregisterTool()
    provideScratch()
    provideIsolation()
    unpatchWorkingDirectory()
    unpatchCreate()
    unpatchRegistry()
    iso.clear()
  }, 'dsh-scratch-workspace.patches')
}

apply.inject = inject

export default apply
