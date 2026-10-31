import { useState, type FormEvent } from 'react'
import { Blocks, Braces, Cable, Globe2, Pencil, Plus, Power, RefreshCw, Trash2, Unplug } from 'lucide-react'
import type { McpServerConfig } from '../../shared/types'

import type { Notify } from '../App'
import { EmptyState, Field, Modal, PageHeader, StatusPill, Toggle, errorText } from '../components/ui'
import type { PageProps } from './types'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象')
  return value as Record<string, unknown>
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  const record = asRecord(value)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, String(item)]))
}

function ConnectionForm({ server, onClose, notify, refresh }: { server?: McpServerConfig; onClose: () => void; notify: Notify; refresh: () => Promise<void> }) {
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>(server?.transport ?? 'stdio')
  const [name, setName] = useState(server?.name ?? '')
  const [alias, setAlias] = useState(server?.alias ?? '')
  const [enabled, setEnabled] = useState(server?.enabled ?? true)
  const [command, setCommand] = useState(server?.transport === 'stdio' ? server.command : 'npx')
  const [args, setArgs] = useState(server?.transport === 'stdio' ? server.args.join('\n') : '')
  const [cwd, setCwd] = useState(server?.transport === 'stdio' ? server.cwd ?? '' : '')
  const [env, setEnv] = useState(server?.transport === 'stdio' ? JSON.stringify(server.env, null, 2) : '{}')
  const [url, setUrl] = useState(server?.transport === 'streamable-http' ? server.url : '')
  const [headers, setHeaders] = useState(server?.transport === 'streamable-http' ? JSON.stringify(server.headers, null, 2) : '{}')
  const [importText, setImportText] = useState('')
  const [busy, setBusy] = useState(false)

  const importJson = (): void => {
    try {
      const parsed = asRecord(JSON.parse(importText))
      const servers = parsed.mcpServers ? asRecord(parsed.mcpServers) : parsed
      const [entryName, value] = Object.entries(servers)[0] ?? []
      if (!entryName || !value) throw new Error('没有找到 MCP Server 配置')
      const entry = asRecord(value)
      setName(entryName)
      setAlias(entryName)
      if (typeof entry.command === 'string') {
        setTransport('stdio')
        setCommand(entry.command)
        setArgs(Array.isArray(entry.args) ? entry.args.map(String).join('\n') : '')
        setCwd(typeof entry.cwd === 'string' ? entry.cwd : '')
        setEnv(JSON.stringify(stringRecord(entry.env), null, 2))
      } else if (typeof entry.url === 'string') {
        setTransport('streamable-http')
        setUrl(entry.url)
        setHeaders(JSON.stringify(stringRecord(entry.headers), null, 2))
      } else {
        throw new Error('配置需要 command 或 url 字段')
      }
      notify('配置已导入，请检查后保存')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      const common = { id: server?.id, name: name.trim(), alias: alias.trim() || name.trim(), enabled }
      const input = transport === 'stdio'
        ? { ...common, transport, command: command.trim(), args: args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), cwd: cwd.trim() || undefined, env: stringRecord(JSON.parse(env)) }
        : { ...common, transport, url: url.trim(), headers: stringRecord(JSON.parse(headers)) }
      const saved = await window.webCodex.saveMcpServer(input)
      if (enabled) await window.webCodex.connectMcpServer(saved.id)
      else await window.webCodex.disconnectMcpServer(saved.id)
      await refresh()
      notify(enabled ? 'MCP 已保存并连接' : 'MCP 配置已保存')
      onClose()
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={server ? '编辑 MCP 连接' : '添加 MCP 连接'} description="把其他 MCP 的工具统一交给 ChatGPT，工具名会自动添加连接别名。" onClose={onClose} wide>
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      {!server && <details><summary className="muted">导入标准 MCP JSON 配置</summary><Field label="JSON 配置" hint="支持常见的 mcpServers 配置格式。"><textarea className="code" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'{"mcpServers":{"server-name":{"command":"npx","args":["-y","server-package"]}}}'} /></Field><button type="button" className="button secondary small" onClick={importJson}><Braces size={14} />解析配置</button></details>}
      <div className="segmented"><button type="button" className={transport === 'stdio' ? 'active' : ''} onClick={() => setTransport('stdio')}><Cable size={14} /> 本地命令 · stdio</button><button type="button" className={transport === 'streamable-http' ? 'active' : ''} onClick={() => setTransport('streamable-http')}><Globe2 size={14} /> 远程服务 · HTTP</button></div>
      <div className="form-row"><Field label="显示名称"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：文件系统" required /></Field><Field label="工具别名" hint="最终工具名：别名__工具名"><input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="自动使用显示名称" /></Field></div>
      {transport === 'stdio' ? <>
        <Field label="启动命令"><input className="mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" required /></Field>
        <Field label="命令参数" hint="每行一个参数，避免引号和转义差异。"><textarea value={args} onChange={(event) => setArgs(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\Projects'} /></Field>
        <div className="form-row"><Field label="工作目录（可选）"><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="留空使用应用目录" /></Field><Field label="环境变量 JSON"><input className="mono" value={env} onChange={(event) => setEnv(event.target.value)} spellCheck={false} /></Field></div>
      </> : <>
        <Field label="MCP Server URL"><input className="mono" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" required /></Field>
        <Field label="请求头 JSON" hint="认证信息会保留在本机，不会显示在任务日志中。"><textarea className="code" value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={'{"Authorization":"Bearer ..."}'} /></Field>
      </>}
      <Toggle checked={enabled} onChange={setEnabled} label="保存后立即连接" />
      <div className="form-footer"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? '正在连接…' : '保存并连接'}</button></div>
    </form>
  </Modal>
}

export function ConnectionsPage({ config, runtime, notify, refresh }: PageProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerConfig | undefined>()

  const connect = async (id: string): Promise<void> => {
    try {
      await window.webCodex.connectMcpServer(id)
      notify('MCP 已连接')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  const remove = async (server: McpServerConfig): Promise<void> => {
    if (!window.confirm(`移除 ${server.name}？只会删除连接配置。`)) return
    try {
      await window.webCodex.removeMcpServer(server.id)
      await refresh()
      notify('MCP 连接已移除')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  return <div className="page-container">
    <PageHeader eyebrow="MCP HUB" title="连接其他 MCP" description="本地命令和远程 MCP 都能接入。ChatGPT 只需连接 Web Codex，就能使用这里的工具。" actions={<button className="button primary" onClick={() => { setEditing(undefined); setFormOpen(true) }}><Plus size={16} />添加 MCP</button>} />
    {config.mcpServers.length === 0 ? <EmptyState icon={<Blocks size={27} />} title="把已有 MCP 工具接进来" description="粘贴标准 JSON 配置，或者用简单表单添加 stdio 与 Streamable HTTP 服务。" action={<button className="button primary" onClick={() => setFormOpen(true)}><Plus size={16} />添加第一个 MCP</button>} /> : <div className="grid-cards">
      {config.mcpServers.map((server) => {
        const state = runtime.mcpConnections.find((item) => item.id === server.id)
        return <article className="card connection-card" key={server.id}>
          <div className="resource-card-top"><div className={`resource-icon ${state?.connected ? 'connected' : ''}`}>{server.transport === 'stdio' ? <Cable size={21} /> : <Globe2 size={21} />}</div><div className="resource-title"><h3>{server.name}</h3><p>{server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url}</p></div><StatusPill tone={state?.connected ? 'success' : state?.error ? 'danger' : 'neutral'}>{state?.connected ? '已连接' : state?.error ? '连接失败' : '未连接'}</StatusPill></div>
          <div className="resource-meta"><span><Blocks size={14} />{state?.toolCount ?? 0} 个工具</span><span className="mono">{server.alias}__*</span><span>{server.transport}</span></div>
          {state?.error && <p className="field-hint" title={state.error}>{state.error}</p>}
          <div className="resource-actions"><button className="button secondary small" onClick={() => state?.connected ? void window.webCodex.disconnectMcpServer(server.id) : void connect(server.id)}>{state?.connected ? <Unplug size={14} /> : <Power size={14} />}{state?.connected ? '断开' : '连接'}</button><button className="icon-button" title="重新连接" onClick={() => void connect(server.id)}><RefreshCw size={16} /></button><span className="spacer" /><button className="icon-button" onClick={() => { setEditing(server); setFormOpen(true) }}><Pencil size={16} /></button><button className="icon-button danger" onClick={() => void remove(server)}><Trash2 size={16} /></button></div>
        </article>
      })}
    </div>}
    {formOpen && <ConnectionForm server={editing} onClose={() => setFormOpen(false)} notify={notify} refresh={refresh} />}
  </div>
}