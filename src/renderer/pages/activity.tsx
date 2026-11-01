import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Activity, ChevronDown, ChevronUp, CircleStop, Clock3, Download, FileJson, FolderOpen, Play, RefreshCw, ScrollText, Search, TerminalSquare } from 'lucide-react'
import type { AuditLogEvent, AuditLogFilter, LogCategory, LogLevel, LogOrigin, LogServiceState, ShellKind } from '../../shared/types'
import type { Notify } from '../App'
import { EmptyState, Field, Modal, PageHeader, StatusPill, errorText } from '../components/ui'
import type { PageProps } from './types'

const statusText = { running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止' } as const
const categoryLabels: Record<LogCategory, string> = { app: '应用', gateway: 'Gateway', tunnel: 'Tunnel', mcp: '下游 MCP', project: '项目', file: '文件', shell: 'Shell', network: '网络', config: '配置', security: '安全' }
const originLabels: Record<LogOrigin, string> = { remote: '远程', local: '本机', system: '系统' }
const levelLabels: Record<LogLevel, string> = { debug: '调试', info: '信息', warn: '警告', error: '错误' }

function LogCenter({ notify }: { notify: Notify }) {
  const [events, setEvents] = useState<AuditLogEvent[]>([])
  const [state, setState] = useState<LogServiceState | null>(null)
  const [category, setCategory] = useState<AuditLogFilter['category']>('all')
  const [origin, setOrigin] = useState<AuditLogFilter['origin']>('all')
  const [level, setLevel] = useState<AuditLogFilter['level']>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)

  const loadLogs = useCallback(async () => {
    try {
      const result = await window.webCodex.listLogs({ category, origin, level, query, limit: 500 })
      setEvents(result)
      setLoading(false)
    } catch (error) {
      notify(errorText(error), 'error')
      setLoading(false)
    }
  }, [category, origin, level, query, notify])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  useEffect(() => {
    void window.webCodex.getLogState().then(setState).catch(() => undefined)
    return window.webCodex.onLogState(setState)
  }, [])

  useEffect(() => window.webCodex.onLogEvent(() => void loadLogs()), [loadLogs])

  const exportLogs = async (): Promise<void> => {
    setExporting(true)
    try {
      const exported = await window.webCodex.exportLogs()
      if (exported) notify(`已导出 ${exported.files} 个日志文件：${exported.destination}`)
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setExporting(false)
    }
  }

  const exportDiagnostics = async (): Promise<void> => {
    setExportingDiagnostics(true)
    try {
      const destination = await window.webCodex.exportDiagnostics()
      if (destination) notify(`已导出脱敏诊断：${destination}`)
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setExportingDiagnostics(false)
    }
  }

  return <section>
    <div className="log-toolbar card">
      <div className="log-search"><Search size={16} /><input aria-label="搜索日志" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索命令、requestId、工具或错误…" /></div>
      <select aria-label="日志分类" value={category} onChange={(event) => setCategory(event.target.value as AuditLogFilter['category'])}><option value="all">全部分类</option>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="日志来源" value={origin} onChange={(event) => setOrigin(event.target.value as AuditLogFilter['origin'])}><option value="all">全部来源</option><option value="remote">远程操作</option><option value="local">本机操作</option><option value="system">系统事件</option></select>
      <select aria-label="日志级别" value={level} onChange={(event) => setLevel(event.target.value as AuditLogFilter['level'])}><option value="all">全部级别</option>{Object.entries(levelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button className="icon-button" title="刷新日志" onClick={() => void loadLogs()}><RefreshCw size={17} /></button>
      <button className="button secondary" onClick={() => void window.webCodex.openLogDirectory()}><FolderOpen size={16} />打开目录</button>
      <button className="button secondary" disabled={exportingDiagnostics} onClick={() => void exportDiagnostics()}><FileJson size={16} />{exportingDiagnostics ? '正在生成…' : '导出诊断'}</button>
      <button className="button primary" disabled={exporting} onClick={() => void exportLogs()}><Download size={16} />{exporting ? '正在导出…' : '导出 JSONL'}</button>
    </div>
    <div className="log-summary"><span><ScrollText size={14} />{events.length} 条匹配事件</span><span>JSONL 持久化 · 保留 {state?.retentionDays ?? 14} 天</span><span className={state?.persistent === false ? 'log-write-error' : ''}>{state?.persistent === false ? `写入异常：${state.lastError}` : '日志写入正常'}</span></div>
    {loading ? <div className="empty-state"><p>正在读取审计日志…</p></div> : events.length === 0 ? <EmptyState icon={<ScrollText size={27} />} title="没有匹配的日志" description="调整筛选条件，或者启动 Gateway、Tunnel、项目命令后再次查看。" /> : <div className="log-list">
      {events.map((event) => {
        const isExpanded = expanded === event.id
        const tone = event.level === 'error' ? 'danger' : event.level === 'warn' ? 'warning' : event.category === 'tunnel' ? 'info' : event.status === 'success' ? 'success' : 'neutral'
        return <article className={`card log-event ${event.level}`} key={event.id}>
          <button className="log-event-summary" onClick={() => setExpanded(isExpanded ? null : event.id)} aria-expanded={isExpanded}>
            <span className={`log-level-marker ${event.level}`} />
            <span className="log-time">{new Date(event.timestamp).toLocaleTimeString()}<small>{new Date(event.timestamp).toLocaleDateString()}</small></span>
            <span className="log-tags"><StatusPill tone={tone}>{categoryLabels[event.category]}</StatusPill><span className={`log-origin ${event.origin}`}>{originLabels[event.origin]}</span></span>
            <span className="log-message"><strong>{event.action}</strong><span>{event.message}</span></span>
            <span className="log-duration">{event.durationMs !== undefined ? `${event.durationMs}ms` : levelLabels[event.level]}</span>
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {isExpanded && <div className="log-event-detail"><dl>{event.requestId && <><dt>requestId</dt><dd className="mono">{event.requestId}</dd></>}{event.taskId && <><dt>taskId</dt><dd className="mono">{event.taskId}</dd></>}{event.projectId && <><dt>projectId</dt><dd className="mono">{event.projectId}</dd></>}<dt>status</dt><dd>{event.status}</dd><dt>eventId</dt><dd className="mono">{event.id}</dd></dl>{event.data !== undefined && <pre>{JSON.stringify(event.data, null, 2)}</pre>}</div>}
        </article>
      })}
    </div>}
  </section>
}

export function ActivityPage({ config, runtime, notify }: PageProps) {
  const [view, setView] = useState<'tasks' | 'logs'>('tasks')
  const [formOpen, setFormOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [projectId, setProjectId] = useState(config.projects[0]?.id ?? '')
  const [shell, setShell] = useState<ShellKind>('auto')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      await window.webCodex.runShell({ projectId, command, shell, wait: false, timeoutMs: 3_600_000 })
      notify('命令已开始运行')
      setCommand('')
      setFormOpen(false)
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return <div className="page-container">
    <PageHeader eyebrow="ACTIVITY & AUDIT" title="任务与日志" description="查看本机命令输出，并审计每一次远程请求、连接变化和本机操作。" actions={view === 'tasks' ? <button className="button primary" disabled={!config.projects.length} onClick={() => setFormOpen(true)}><Play size={16} />运行命令</button> : undefined} />
    <div className="segmented activity-tabs"><button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}><TerminalSquare size={15} />命令任务<span>{runtime.tasks.length}</span></button><button className={view === 'logs' ? 'active' : ''} onClick={() => setView('logs')}><ScrollText size={15} />审计日志</button></div>
    {view === 'logs' ? <LogCenter notify={notify} /> : runtime.tasks.length === 0 ? <EmptyState icon={<Activity size={27} />} title="还没有运行过命令" description={config.projects.length ? '你可以在这里直接测试终端，也可以等待 ChatGPT 开始工作。' : '先添加一个项目，终端命令会在项目目录中运行。'} action={config.projects.length ? <button className="button primary" onClick={() => setFormOpen(true)}><TerminalSquare size={16} />运行第一条命令</button> : undefined} /> : <div className="task-list">
      {runtime.tasks.map((task) => {
        const project = config.projects.find((item) => item.id === task.projectId)
        const isExpanded = expanded === task.id
        return <article className="card task-card" key={task.id}>
          <div className="task-summary"><div className={`task-status-icon ${task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : ''}`}><TerminalSquare size={17} /></div><div className="task-main"><div className="task-command" title={task.command}>{task.command}</div><div className="task-meta"><span>{project?.name ?? '已移除项目'}</span><span>{task.kind === 'process' ? 'process' : task.shell}</span><span><Clock3 size={10} /> {new Date(task.startedAt).toLocaleTimeString()}</span>{task.exitCode !== null && <span>exit {task.exitCode}</span>}</div>{task.stateReason && <p className="field-hint">{task.stateReason}</p>}</div><StatusPill tone={task.status === 'running' ? 'info' : task.status === 'completed' ? 'success' : task.status === 'failed' ? 'danger' : 'neutral'}>{statusText[task.status]}</StatusPill>{task.status === 'running' && <button className="icon-button danger" title="停止任务" onClick={() => void window.webCodex.stopShell(task.id).catch((error) => notify(errorText(error), 'error'))}><CircleStop size={18} /></button>}<button className="icon-button" onClick={() => setExpanded(isExpanded ? null : task.id)} aria-label="查看输出">{isExpanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button></div>
          {isExpanded && <div className="task-output">{task.stdout && <pre>{task.stdout}</pre>}{task.stderr && <div className="stderr"><pre>{task.stderr}</pre></div>}{!task.stdout && !task.stderr && <pre>暂无输出</pre>}{task.truncated && <p className="field-hint">输出已达到上限，较早内容仍保留在当前缓冲区中。</p>}</div>}
        </article>
      })}
    </div>}
    {formOpen && <Modal title="运行本机命令" description="命令会在所选项目目录中运行，并显示在任务活动里。" onClose={() => setFormOpen(false)}>
      <form className="form-stack" onSubmit={(event) => void run(event)}>
        <div className="form-row"><Field label="项目"><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{config.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label="Shell"><select value={shell} onChange={(event) => setShell(event.target.value as ShellKind)}><option value="auto">系统自动选择</option><option value="cmd">cmd</option><option value="powershell">PowerShell</option><option value="bash">bash</option><option value="zsh">zsh</option></select></Field></div>
        <Field label="命令" hint="长时间运行的开发服务器也可以使用，任务会在后台持续运行。"><textarea className="code mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npm test" required autoFocus /></Field>
        <div className="form-footer"><button type="button" className="button secondary" onClick={() => setFormOpen(false)}>取消</button><button className="button primary" disabled={busy || !projectId || !command.trim()}><Play size={15} />{busy ? '正在启动…' : '开始运行'}</button></div>
      </form>
    </Modal>}
  </div>
}