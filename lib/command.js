/**
 * Slash commands for DeepSeek Harness (DSH) chat composer:
 * - /scratch [status|enable|disable|gc]
 * - /isolate [status|enable|disable|gc]
 * @module dsh-scratch-workspace/lib/command
 */

/**
 * Register human-facing slash commands for the chat input box.
 * @param ctx - Cordis context.
 * @param iso - shared isolation state.
 * @param api - public isolation API.
 * @returns disposer removing command registrations.
 */
export function registerCommands(ctx, iso, api) {
  const commands = ctx.get('commands', false)
  if (!commands || typeof commands.register !== 'function') {
    return () => {}
  }

  const handler = async (invocation) => {
    const rawInput = invocation.rawInput?.trim() ?? ''
    const args = rawInput.split(/\s+/).filter(Boolean)
    const action = args[0]?.toLowerCase() ?? 'status'

    const session = invocation.agent?.session
    const sessionCwd = session?.header?.cwd
    const sessionId = session?.id

    const parentRoot = sessionCwd
      ? (iso.ownerOf(sessionCwd) ?? sessionCwd)
      : (iso.roots()[0] ?? iso.defaultPath?.())

    if (action === 'status') {
      const isIso = parentRoot ? (iso.workspaceRoot(parentRoot) !== undefined || iso.roots().includes(parentRoot)) : false
      const sessionPath = sessionId ? (iso.sessionPath(sessionId) ?? sessionCwd) : sessionCwd
      const lines = [
        `📁 **工作区隔离状态**`,
        `- **母工作区**: \`${parentRoot ?? '未知'}\``,
        `- **隔离状态**: ${isIso ? '✅ 已开启' : '⚪ 未开启'}`,
        `- **当前会话沙箱**: \`${sessionPath ?? '继承工作区'}\``,
        `- **已隔离工作区数**: ${iso.roots().length}`,
        ``,
        `💡 **可用操作**:`,
        `- \`/scratch enable\`：开启当前工作区隔离`,
        `- \`/scratch disable\`：关闭当前工作区隔离`,
        `- \`/scratch gc\`：立即清理磁盘废弃与孤儿草稿目录`,
      ]
      return { kind: 'success', text: lines.join('\n') }
    }

    if (action === 'enable') {
      if (!parentRoot) {
        return { kind: 'error', text: '无法识别当前会话所属工作区，请在工作区内执行。' }
      }
      await api.setIsolatedPath(parentRoot, true)
      return {
        kind: 'success',
        text: `✅ 已为工作区开启会话隔离：\`${parentRoot}\`\n后续新建会话将自动运行于专属 \`session-<id>\` 沙箱目录中。`,
      }
    }

    if (action === 'disable') {
      if (!parentRoot) {
        return { kind: 'error', text: '无法识别当前会话所属工作区，请在工作区内执行。' }
      }
      await api.setIsolatedPath(parentRoot, false)
      return {
        kind: 'success',
        text: `⚪ 已关闭工作区会话隔离：\`${parentRoot}\`。`,
      }
    }

    if (action === 'gc') {
      const result = await api.cleanOrphans()
      return {
        kind: 'success',
        text: `🧹 **磁盘常态清理完成**\n- 扫描目录数: ${result.scannedCount}\n- 已回收废弃/孤儿目录: ${result.cleanedCount}\n- 磁盘状态: 常态洁净`,
      }
    }

    return {
      kind: 'error',
      text: `未知参数: \`${action}\`。\n可用参数: \`status\` | \`enable\` | \`disable\` | \`gc\``,
    }
  }

  const unregScratch = commands.register({
    definitionId: 'dsh-scratch-workspace:scratch',
    name: 'scratch',
    description: '瞬态草稿工作区管理：查看隔离状态、切换隔离或清理磁盘垃圾',
    input: { hint: 'status | enable | disable | gc' },
    handler,
  })

  const unregIsolate = commands.register({
    definitionId: 'dsh-scratch-workspace:isolate',
    name: 'isolate',
    description: '查看或切换当前工作区会话隔离状态',
    input: { hint: 'status | enable | disable | gc' },
    handler,
  })

  return () => {
    unregScratch?.()
    unregIsolate?.()
  }
}
