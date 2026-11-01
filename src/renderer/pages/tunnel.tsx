import { useState, type FormEvent } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Play, RadioTower, Save, ScrollText, ShieldCheck, Square } from 'lucide-react'
import { TUNNEL_API_KEY_CONFIGURED } from '../../shared/api'
import type { Page } from '../App'
import { CopyButton, Field, PageHeader, StatusPill, Toggle, errorText } from '../components/ui'
import type { PageProps } from './types'

export function TunnelPage({ config, runtime, notify, refresh, onNavigate }: PageProps & { onNavigate: (page: Page) => void }) {
  const [tunnelId, setTunnelId] = useState(config.tunnel.tunnelId)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [autoStart, setAutoStart] = useState(config.tunnel.autoStart)
  const [busy, setBusy] = useState(false)
  const hasSavedKey = config.tunnel.apiKey === TUNNEL_API_KEY_CONFIGURED
  const running = runtime.tunnel.running
  const ready = runtime.tunnel.phase === 'ready' && !runtime.tunnel.error
  const client = runtime.tunnel.client

  const save = async (startAfterSave: boolean): Promise<void> => {
    const id = tunnelId.trim()
    if (!id) {
      notify('请输入 Tunnel ID', 'error')
      return
    }
    if (!hasSavedKey && !apiKey.trim()) {
      notify('请输入 API Key', 'error')
      return
    }
    setBusy(true)
    try {
      const wasRunning = runtime.tunnel.running
      if (wasRunning) await window.webCodex.stopTunnel()
      await window.webCodex.updateConfig({
        tunnel: {
          ...config.tunnel,
          tunnelId: id,
          apiKey: apiKey.trim() || TUNNEL_API_KEY_CONFIGURED,
          autoStart
        }
      })
      if (startAfterSave) {
        if (!runtime.gateway.running) await window.webCodex.startGateway()
        await window.webCodex.startTunnel()
      }
      await refresh()
      setApiKey('')
      notify(startAfterSave ? 'Tunnel 进程已启动，正在等待就绪状态' : 'Tunnel 配置已保存')
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.webCodex.stopTunnel()
      await refresh()
      notify('Tunnel 已停止')
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const openExternal = (url: string): void => {
    void window.webCodex.openExternal(url).catch((error) => notify(errorText(error), 'error'))
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void save(false)
  }

  return <div className="page-container">
    <PageHeader eyebrow="OPENAI SECURE TUNNEL" title="Tunnel 连接" description="只需填写 Tunnel ID 和 API Key。启动命令、网络路由和本地 MCP 凭证由应用自动管理。" actions={<button className="button secondary" onClick={() => onNavigate('activity')}><ScrollText size={16} />连接日志</button>} />

    <section className={`tunnel-status-card card ${runtime.tunnel.error ? 'has-error' : ''}`}>
      <div className={`resource-icon ${ready ? 'connected' : ''}`}><RadioTower size={24} /></div>
      <div className="tunnel-status-main"><h2>{ready ? 'Tunnel 已就绪，正在等待 ChatGPT' : runtime.tunnel.error ? 'Tunnel 连接失败' : client && !client.available ? 'Tunnel 客户端不可用' : running ? 'Tunnel 正在连接' : 'Tunnel 尚未启动'}</h2><p>{runtime.tunnel.error || client?.error || runtime.tunnel.detail}</p>{ready && <span className="tunnel-ready-note"><CheckCircle2 size={14} />现在可以在 ChatGPT Plugins 中选择此 Tunnel</span>}</div>
      <StatusPill tone={ready ? 'success' : runtime.tunnel.error || client && !client.available ? 'danger' : running ? 'info' : 'neutral'}>{ready ? '等待 ChatGPT' : client && !client.available && !running ? '客户端不可用' : running ? '正在连接' : '未连接'}</StatusPill>
    </section>
    {client && !client.available && <div className="tunnel-hint-card" role="alert"><AlertCircle size={18} /><div><strong>启动前客户端检查未通过</strong><p>{client.error}。请重新构建或安装 Web Codex，确保内置 <code>tunnel-client</code> 完整存在；也可在“任务与日志”中查看客户端预检和 doctor 诊断。</p></div></div>}

    <div className="tunnel-layout">
      <form className="card settings-section" onSubmit={submit}>
        <div className="card-header"><div><h3>OpenAI Tunnel 凭证</h3><p>密钥只保存在本机，不会显示在日志或发送给 ChatGPT。</p></div><KeyRound size={18} /></div>
        <div className="card-body">
          <Field label="Tunnel ID" hint="在 OpenAI Platform 的 Tunnels 页面创建并复制完整 Tunnel ID。"><input className="mono" value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} placeholder="tunnel_..." autoComplete="off" /></Field>
          <div className="external-actions"><button type="button" className="button soft small" onClick={() => openExternal('https://platform.openai.com/settings/organization/tunnels')}><ExternalLink size={14} />打开 Tunnels 页面</button><button type="button" className="button soft small" onClick={() => openExternal('https://platform.openai.com/settings/organization/api-keys')}><ExternalLink size={14} />创建 API Key</button></div>
          <Field label="API Key" hint={hasSavedKey ? '已保存。留空保持不变；填写新 Key 可替换。建议使用仅有 Tunnels: Read 与 Tunnels: Use 权限的受限 Key。' : '输入可以访问此 Tunnel 的 Restricted API Key。'}>
            <div className="secret-input"><input type={showKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasSavedKey ? '已保存，留空保持不变' : 'sk-...'} autoComplete="new-password" /><button type="button" className="icon-button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          </Field>
          <Toggle checked={autoStart} onChange={setAutoStart} label="应用启动时自动连接 Tunnel" />
          <div className="form-footer"><button className="button secondary" disabled={busy}><Save size={15} />保存配置</button>{running ? <button type="button" className="button danger" disabled={busy} onClick={() => void stop()}><Square size={14} />停止 Tunnel</button> : <button type="button" className="button primary" disabled={busy} onClick={() => void save(true)}><Play size={15} />{busy ? '正在连接…' : '保存并启动'}</button>}</div>
        </div>
      </form>

      <div className="tunnel-side">
        <section className="card settings-section">
          <div className="card-header"><div><h3>在 ChatGPT 中连接</h3><p>个人使用选择 Tunnel 和 No Auth。</p></div><ShieldCheck size={18} /></div>
          <div className="card-body">
            <div className="connection-box"><label>TUNNEL ID</label><div className="connection-value mono">{tunnelId || '填写后显示'}</div><CopyButton value={tunnelId} label="复制 Tunnel ID" className="button secondary small" /></div>
            <ol className="tunnel-steps"><li>打开 ChatGPT Plugins，选择“添加自定义 MCP 服务”。</li><li>连接方式选择 <strong>Tunnel</strong>，粘贴上面的 Tunnel ID。</li><li>Authentication 选择 <strong>No Auth</strong>，创建插件并扫描工具。</li></ol>
            <button type="button" className="button secondary" onClick={() => openExternal('https://chatgpt.com/#settings/Connectors')}><ExternalLink size={15} />打开 ChatGPT Plugins</button>
          </div>
        </section>

        <div className="tunnel-hint-card"><ShieldCheck size={18} /><div><strong>凭证不会交给 ChatGPT</strong><p>本地 Tunnel 会注入 Web Codex 认证。ChatGPT 只持有 Tunnel ID，不需要 Bearer Token。</p></div></div>
        <div className="tunnel-hint-card"><AlertCircle size={18} /><div><strong>“无法发现 OAuth 设置”说明入口或认证方式不对</strong><p>请选择 <strong>Tunnel + No Auth</strong>，不要选择 URL + OAuth。网页不能访问 <code>127.0.0.1</code>；Web Codex 不提供 OpenAI OAuth 登录服务，也不会通过关闭本地认证绕过它。</p></div></div>
        <div className="tunnel-hint-card"><AlertCircle size={18} /><div><strong>本地就绪不等于对话已连通</strong><p>最终请在 ChatGPT 中执行一次“列出项目”，成功后才算完整连接。</p></div></div>
      </div>
    </div>
  </div>
}