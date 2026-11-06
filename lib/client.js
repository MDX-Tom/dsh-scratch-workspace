/**
 * Browser UI for DSH Settings → Plugins: Workspace Isolation & Disk GC.
 */
window.__ModuleLoader__.load({
  id: 'dsh-scratch-workspace',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useEffect, useState } = React

    const LIST_ROUTE = '/scratch-workspace/workspaces'
    const TOGGLE_ROUTE = '/scratch-workspace/toggle'
    const GC_ROUTE = '/scratch-workspace/gc'

    const TEXT = {
      tab: '工作区隔离与清理',
      title: '工作区隔离与磁盘清理',
      intro: '开启隔离后，每个新会话均在独立的 session-<id> 子沙箱中运行，隔离写权限，避免并行会话相互覆盖；'
        + '项目文件对所有会话完全只读可用。插件内置常态 GC 引擎，自动回收空闲与孤儿会话目录，保持磁盘整洁。',
      empty: '当前没有已注册的工作区。请先在侧边栏打开项目目录。',
      loading: '读取中…',
      retry: '重试',
      on: '已开启',
      off: '未开启',
      enable: '开启隔离',
      disable: '关闭隔离',
      sessions: '会话',
      isolatedCount: (count) => `已开启隔离的工作区：${count}`,
      runGc: '立即清理磁盘孤儿目录',
      gcRunning: '正在清理…',
      gcDone: (count) => `清理完成：已回收 ${count} 个孤儿/废弃目录`,
      failed: (message) => `操作失败：${message}`,
      unavailable: '宿主未响应接口，请确认插件已加载。',
    }

    async function fetchState() {
      const response = await fetch(LIST_ROUTE, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return await response.json()
    }

    async function toggle(workspaceId, enabled) {
      const response = await fetch(TOGGLE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ workspaceId, enabled }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error ?? `${response.status} ${response.statusText}`)
      return payload
    }

    async function triggerGc() {
      const response = await fetch(GC_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error ?? `${response.status} ${response.statusText}`)
      return payload
    }

    const styles = {
      root: { padding: '4px 0 24px', color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: 1.6 },
      title: { margin: '0 0 6px', fontSize: 14, fontWeight: 600 },
      intro: { margin: '0 0 16px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      toolbar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        margin: '0 0 12px',
        padding: '8px 12px',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 8,
      },
      summary: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
      },
      main: { minWidth: 0, flex: 1 },
      name: { fontWeight: 500 },
      path: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 12,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      state: { flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, minWidth: 48, textAlign: 'right' },
      button: {
        flex: 'none',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 8,
        padding: '5px 12px',
      },
      gcButton: {
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 6,
        padding: '4px 10px',
      },
      buttonBusy: { opacity: 0.6, cursor: 'default' },
      notice: { color: 'var(--dsw-alias-state-success-primary, #10b981)', fontSize: 12, margin: '8px 0 0' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '8px 0 0' },
      empty: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
    }

    function ScratchWorkspacePage() {
      const [state, setState] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [notice, setNotice] = useState(undefined)
      const [busyId, setBusyId] = useState(undefined)
      const [gcBusy, setGcBusy] = useState(false)

      const load = () => {
        fetchState().then(
          (next) => { setState(next); setError(undefined) },
          (cause) => { setError(cause?.message ?? String(cause)) },
        )
      }

      useEffect(() => {
        load()
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [])

      const apply = async (workspaceId, enabled) => {
        setBusyId(workspaceId)
        try {
          setState(await toggle(workspaceId, enabled))
          setError(undefined)
        } catch (cause) {
          setError(cause?.message ?? String(cause))
          load()
        } finally {
          setBusyId(undefined)
        }
      }

      const handleGc = async () => {
        setGcBusy(true)
        setNotice(undefined)
        try {
          const res = await triggerGc()
          setNotice(TEXT.gcDone(res.cleanedCount ?? 0))
          setError(undefined)
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setGcBusy(false)
        }
      }

      const workspaces = state?.workspaces ?? []

      return React.createElement(
        'div',
        { style: styles.root },
        React.createElement('h3', { style: styles.title }, TEXT.title),
        React.createElement('p', { style: styles.intro }, TEXT.intro),
        React.createElement(
          'div',
          { style: styles.toolbar },
          React.createElement(
            'span',
            { style: styles.summary },
            state ? TEXT.isolatedCount(state.isolatedCount ?? 0) : TEXT.loading,
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: gcBusy ? { ...styles.gcButton, ...styles.buttonBusy } : styles.gcButton,
              disabled: gcBusy,
              onClick: handleGc,
            },
            gcBusy ? TEXT.gcRunning : TEXT.runGc,
          ),
        ),
        notice ? React.createElement('p', { style: styles.notice }, notice) : null,
        error ? React.createElement(
          'p',
          { style: styles.error },
          TEXT.failed(error),
          React.createElement('button', {
            type: 'button',
            style: { ...styles.button, marginLeft: 8 },
            onClick: load,
          }, TEXT.retry),
        ) : null,
        state !== undefined && workspaces.length === 0
          ? React.createElement('p', { style: styles.empty }, TEXT.empty)
          : null,
        workspaces.map((workspace) => React.createElement(
          'div',
          { key: workspace.workspaceId, style: styles.row },
          React.createElement(
            'div',
            { style: styles.main },
            React.createElement('div', { style: styles.name }, workspace.title),
            React.createElement('div', { style: styles.path, title: workspace.path }, workspace.path),
          ),
          React.createElement(
            'span',
            { style: styles.state },
            `${TEXT.sessions} ${workspace.sessionCount} · ${workspace.isolates ? TEXT.on : TEXT.off}`,
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: busyId === workspace.workspaceId
                ? { ...styles.button, ...styles.buttonBusy }
                : styles.button,
              disabled: busyId === workspace.workspaceId,
              onClick: () => { void apply(workspace.workspaceId, !workspace.isolates) },
            },
            workspace.isolates ? TEXT.disable : TEXT.enable,
          ),
        )),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'scratch-workspace',
        order: 90,
        label: TEXT.tab,
      }, ScratchWorkspacePage))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
