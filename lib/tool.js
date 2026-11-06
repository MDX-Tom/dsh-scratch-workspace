/**
 * Model-facing control of session isolation and scratch directory GC.
 * Actions: status, list, enable, disable, gc.
 * @module dsh-scratch-workspace/lib/tool
 */

import { isAbsolute, resolve } from 'node:path'
import { isIsolated } from './isolate.js'

function absolute(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return undefined
  return resolve(isAbsolute(value) ? value : resolve(process.cwd(), value))
}

function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

export function registerIsolationTool(ctx, iso) {
  const owner = () => {
    const service = ctx.isolatedSessions ?? ctx.scratchWorkspace
    if (service === undefined) throw new Error('dsh-scratch-workspace is not active in this deployment')
    return service
  }

  return ctx.tools.register({
    name: 'session_isolation',
    description: [
      'Read or change whether a project directory gives every session its own working folder, or trigger disk GC.',
      '',
      'While isolation is on for a directory, each NEW session created there works in its own',
      '"session-<id>" subfolder: that subfolder is the session\'s file-sandbox root, so parallel',
      'sessions cannot overwrite each other\'s files. Project files remain readable.',
      '',
      'Actions:',
      '- status: check one directory',
      '- list: list all isolated directories',
      '- enable: turn on isolation for a directory',
      '- disable: turn off isolation for a directory',
      '- gc: clean up empty abandoned session folders and orphan directories',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'enable', 'disable', 'gc'],
          description: 'status, list, enable, disable, gc.',
        },
        path: {
          type: 'string',
          description: 'Project directory for status/enable/disable; defaults to current workspace.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['action'],
        properties: {
          action: { type: 'string' },
          path: { type: 'string' },
          isolates: { type: 'boolean' },
          isolatedPaths: { type: 'array', items: { type: 'string' } },
          cleanedCount: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const lines = []
        if (value.action === 'gc') {
          lines.push(`Disk GC completed. Removed ${value.cleanedCount ?? 0} orphan/abandoned directories.`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.path !== undefined) {
          lines.push(`${value.path} — per-session working directories are ${value.isolates === true ? 'ON' : 'OFF'}.`)
          if (value.isolates === true) lines.push('New sessions created there work in their own session-<id> subfolder.')
        }
        lines.push((value.isolatedPaths?.length ?? 0) === 0
          ? 'No directory currently isolates its sessions.'
          : `Isolating directories:\n${value.isolatedPaths.map(p => `- ${p}`).join('\n')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const service = owner()
      const action = args?.action

      if (action === 'gc') {
        const cleaned = await service.cleanOrphans()
        return { action, cleanedCount: cleaned.length, isolatedPaths: service.list() }
      }

      if (action === 'list') {
        return { action, isolatedPaths: service.list() }
      }

      const path = absolute(args?.path ?? sessionWorkspace(exec))
      if (path === undefined) {
        throw new Error('session_isolation needs a path (or a calling session) for this action')
      }

      if (action === 'status') {
        return { action, path, isolates: await isIsolated(path), isolatedPaths: service.list() }
      }

      if (action === 'enable' || action === 'disable') {
        const result = await service.setIsolatedPath(path, action === 'enable')
        return { action, path: result.path, isolates: result.isolates, isolatedPaths: service.list() }
      }

      throw new Error(`session_isolation: unknown action ${JSON.stringify(action)}`)
    },
  })
}
