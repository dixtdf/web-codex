import { useEffect, useState } from 'react'
import { ArrowRight, Blocks, Bot, Check, CheckCircle2, Copy, FolderKanban, Play, Power, Radio, RadioTower, ShieldCheck, Sparkles, TerminalSquare, Wifi } from 'lucide-react'
import type { ConnectionInfo } from '../../shared/api'
import type { Page } from '../App'
import { CopyButton, StatusPill, errorText } from '../components/ui'
import type { PageProps } from './types'

export function HomePage({ config, runtime, notify, onNavigate }: PageProps & { onNavigate: (page: Page) => void }) {
  const [connection, setConnection] = useState<ConnectionInfo>({ localAddress: '', publicUrl: '', token: '', tunnelId: '' })
  const [busy, setBusy] = useState(false)
  const hasProjects = config.projects.length > 0
  const tunnelConfigured = Boolean(config.tunnel.tunnelId && config.tunnel.apiKey)
  const connected = runtime.tunnel.phase === 'ready' && !runtime.tunnel.error
  const address = connection.tunnelId || config.tunnel.tunnelId

  useEffect(() => {
    void window.webCodex.getConnectionInfo().then(setConnection).catch(() => undefined)
  }, [runtime.gateway.address, runtime.tunnel.publicUrl, config.tunnel.tunnelId])

  const startConnection = async (): Promise<void> => {
    if (!tunnelConfigured) {
      onNavigate('tunnel')
      return
    }
    setBusy(true)
    try {
      if (!runtime.gateway.running) await window.webCodex.startGateway()
      await window.webCodex.startTunnel()
      notify('Tunnel 正在启动，请等待 ChatGPT 连接')
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return <div className="page-container">
    <section className="hero">
      <div className="hero-content">
        <span className="hero-kicker"><Sparkles size={14} />YOUR COMPUTER, READY FOR CHATGPT</span>
        <h1>让 ChatGPT 像 Codex 一样，<br />在你的电脑上工作。</h1>
        <p>项目、文件、终端和其他 MCP 工具，已经准备好了。无需上传代码，也不用理解复杂的部署。</p>
        <div className="hero-actions">
          {connected ? <CopyButton value={address} label="复制 Tunnel ID" className="button primary large" /> : <button className="button primary large" disabled={busy} onClick={() => void startConnection()}><Play size={17} />{busy ? '正在启动…' : tunnelConfigured ? '启动并连接 ChatGPT' : '配置 Tunnel'}</button>}
          <button className="button secondary large" onClick={() => onNavigate('projects')}>管理项目<ArrowRight size={16} /></button>
        </div>
      </div>
      <div className="hero-visual"><div className="orbit"><div className="orbit-inner"><Bot size={50} strokeWidth={1.3} /></div></div></div>
    </section>

    <section className="stats-grid">
      <div className="card stat-card"><div className="stat-icon green"><Radio size={19} /></div><div><span className="stat-value">{runtime.gateway.running ? '运行中' : '已停止'}</span><span className="stat-label">本地 MCP 服务</span></div></div>
      <div className="card stat-card"><div className="stat-icon"><FolderKanban size={19} /></div><div><span className="stat-value">{config.projects.length}</span><span className="stat-label">可用项目</span></div></div>
      <div className="card stat-card"><div className="stat-icon"><Blocks size={19} /></div><div><span className="stat-value">{runtime.mcpConnections.filter((item) => item.connected).length}</span><span className="stat-label">已连接 MCP</span></div></div>
      <div className="card stat-card"><div className="stat-icon amber"><TerminalSquare size={19} /></div><div><span className="stat-value">{runtime.tasks.filter((item) => item.status === 'running').length}</span><span className="stat-label">正在运行的任务</span></div></div>
    </section>

    <div className="home-grid">
      <section className="card">
        <div className="card-header"><div><h2>三步开始使用</h2><p>只需要完成一次，之后打开应用即可工作。</p></div>{connected ? <StatusPill tone="success">等待 ChatGPT</StatusPill> : <StatusPill>等待设置</StatusPill>}</div>
        <div className="card-body setup-list">
          <div className={`setup-step ${hasProjects ? 'done' : ''}`}><span className="step-number">{hasProjects ? <Check size={14} /> : '1'}</span><div className="step-content"><h3>添加一个工作项目</h3><p>选择本地文件夹，ChatGPT 就能读取代码、修改文件并运行开发命令。</p>{!hasProjects && <button className="button soft small" onClick={() => onNavigate('projects')}>选择项目文件夹<ArrowRight size={13} /></button>}</div></div>
          <div className={`setup-step ${connected ? 'done' : ''}`}><span className="step-number">{connected ? <Check size={14} /> : '2'}</span><div className="step-content"><h3>连接 OpenAI Tunnel</h3><p>在 Tunnel 页面填写 Tunnel ID 和 API Key，启动细节全部由应用处理。</p>{!connected && <button className="button soft small" disabled={busy} onClick={() => void startConnection()}><Power size={13} />{tunnelConfigured ? '启动 Tunnel' : '填写 Tunnel 凭证'}</button>}</div></div>
          <div className={`setup-step ${connected && address ? 'done' : ''}`}><span className="step-number">{connected && address ? <Check size={14} /> : '3'}</span><div className="step-content"><h3>在 ChatGPT 中添加 Plugins</h3><p>选择添加自定义 MCP 服务，连接方式选 Tunnel，Authentication 选 No Auth，然后粘贴 Tunnel ID。</p><div className="connection-box"><label>TUNNEL ID</label><div className="connection-value mono">{address || '填写 Tunnel 后显示'}</div><CopyButton value={address} label="复制 Tunnel ID" className="button secondary small" /></div></div></div>
        </div>
      </section>

      <div className="home-grid" style={{ gridTemplateColumns: '1fr' }}>
        <section className="card"><div className="card-header"><div><h3>Tunnel 凭证</h3><p>密钥只保存在本机。</p></div><RadioTower size={17} /></div><div className="card-body"><div className="connection-box"><label>TUNNEL ID</label><div className="connection-value mono">{address || '尚未配置'}</div><CopyButton value={address} label="复制 Tunnel ID" className="button secondary small" /></div></div></section>
        <section className="card"><div className="card-header"><h3>当前状态</h3><Wifi size={16} /></div><div className="card-body quick-list"><div className="quick-item"><CheckCircle2 size={15} /><span>网络：<strong>{runtime.proxy.proxy ? `${runtime.proxy.source} 代理` : '直接连接'}</strong></span></div><div className="quick-item"><ShieldCheck size={15} /><span>权限：<strong>{runtime.privileged ? '管理员完全访问' : '当前用户访问'}</strong></span></div><div className="quick-item"><Copy size={15} /><span>数据：<strong>保留在本机</strong></span></div></div></section>
      </div>
    </div>
  </div>
}