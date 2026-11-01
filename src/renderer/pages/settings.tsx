import { useState, type FormEvent } from 'react'
import { Globe2, Network, Save, ShieldAlert, ShieldCheck, SlidersHorizontal, Unplug } from 'lucide-react'
import type { NetworkSettings } from '../../shared/types'
import { Field, PageHeader, StatusPill, Toggle, errorText } from '../components/ui'
import type { PageProps } from './types'

export function SettingsPage({ config, runtime, notify, refresh }: PageProps) {
  const [mode, setMode] = useState<NetworkSettings['mode']>(config.network.mode)
  const [manualProxy, setManualProxy] = useState(config.network.manualProxy ?? '')
  const [noProxy, setNoProxy] = useState(config.network.noProxy)
  const [startMinimized, setStartMinimized] = useState(config.ui.startMinimized)
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(config.limits.maxConcurrentTasks)
  const [busy, setBusy] = useState(false)

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      await window.webCodex.updateConfig({
        network: { ...config.network, mode, manualProxy: manualProxy.trim() || undefined, noProxy },
        ui: { ...config.ui, startMinimized },
        limits: { ...config.limits, maxConcurrentTasks }
      })
      await refresh()
      notify('设置已保存，网络配置会自动生效')
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const changeTheme = async (theme: 'system' | 'light' | 'dark'): Promise<void> => {
    await window.webCodex.updateConfig({ ui: { ...config.ui, theme } })
  }

  return <div className="page-container">
    <PageHeader eyebrow="PREFERENCES" title="设置" description="管理外观、网络代理和本机权限。Tunnel 配置已移动到独立页面。" />
    <form className="settings-layout" onSubmit={(event) => void save(event)}>
      <section className="card settings-section"><div className="card-header"><div><h3>外观</h3><p>选择适合你工作环境的界面。</p></div><SlidersHorizontal size={18} /></div><div className="card-body"><div className="settings-inline"><div><h4>界面主题</h4><p>跟随系统会在操作系统切换外观时自动更新。</p></div><div className="segmented" style={{ minWidth: 260 }}><button type="button" className={config.ui.theme === 'system' ? 'active' : ''} onClick={() => void changeTheme('system')}>跟随系统</button><button type="button" className={config.ui.theme === 'light' ? 'active' : ''} onClick={() => void changeTheme('light')}>浅色</button><button type="button" className={config.ui.theme === 'dark' ? 'active' : ''} onClick={() => void changeTheme('dark')}>深色</button></div></div><div className="settings-inline"><div><h4>启动行为</h4><p>启动后保持后台运行，可从系统托盘重新打开面板。</p></div><Toggle checked={startMinimized} onChange={setStartMinimized} label="启动时最小化到托盘" /></div></div></section>

      <section className="card settings-section"><div className="card-header"><div><h3>网络代理</h3><p>运行期间检测系统变化，新请求会自动使用最新配置。</p></div><Network size={18} /></div><div className="card-body">
        <div className="proxy-banner"><Globe2 size={17} /><span>当前：<strong>{runtime.proxy.proxy ? `${runtime.proxy.source} · ${runtime.proxy.proxy}` : '直接连接'}</strong>，检测于 {new Date(runtime.proxy.checkedAt).toLocaleTimeString()}</span></div>
        <Field label="代理模式"><div className="segmented"><button type="button" className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}>自动检测</button><button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>手动代理</button><button type="button" className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}>始终直连</button></div></Field>
        {mode === 'manual' && <Field label="代理地址" hint="支持 http:// 或 https:// 代理地址。"><input className="mono" value={manualProxy} onChange={(event) => setManualProxy(event.target.value)} placeholder="http://127.0.0.1:7890" /></Field>}
        <Field label="NO_PROXY" hint="使用逗号分隔。localhost 和 127.0.0.1 始终绕过代理。"><input className="mono" value={noProxy} onChange={(event) => setNoProxy(event.target.value)} /></Field>
      </div></section>

      <section className="card settings-section"><div className="card-header"><div><h3>任务并发</h3><p>限制同时运行的终端与结构化进程任务数量。</p></div><SlidersHorizontal size={18} /></div><div className="card-body"><Field label="并发任务上限" hint="整数 1-200，默认 20；调整不会终止正在运行的任务。"><input type="number" min={1} max={200} step={1} className="mono" value={maxConcurrentTasks} onChange={(event) => setMaxConcurrentTasks(Number(event.target.value))} /></Field></div></section>

      <section className="card settings-section"><div className="card-header"><div><h3>权限与数据</h3><p>清楚了解应用正在使用的能力。</p></div><ShieldCheck size={18} /></div><div className="card-body"><div className="settings-inline"><div><h4>{runtime.privileged ? '管理员完全访问' : '当前用户访问'}</h4><p>{runtime.privileged ? '应用已获得管理员权限，终端可以执行需要提权的开发命令。' : 'Windows 安装版启动时会请求 UAC；当前进程未检测到管理员令牌。'}</p></div><StatusPill tone={runtime.privileged ? 'success' : 'warning'}>{runtime.privileged ? '管理员模式' : '标准模式'}</StatusPill></div><div className="settings-inline"><div><h4>{runtime.secrets.mode === 'os-protected' ? '操作系统加密密钥存储' : '仅内存保存密钥'}</h4><p>{runtime.secrets.mode === 'os-protected' ? 'Gateway、Tunnel 和下游 MCP 密钥在写入配置前使用当前系统用户密钥加密。' : '系统加密不可用，密钥不会明文写入磁盘，重启后需要重新填写。'}</p></div><StatusPill tone={runtime.secrets.mode === 'os-protected' ? 'success' : 'warning'}>{runtime.secrets.mode === 'os-protected' ? '已加密' : '不持久化'}</StatusPill></div></div></section>

      <div className="page-actions" style={{ justifyContent: 'flex-end' }}><button className="button primary large" disabled={busy}><Save size={16} />{busy ? '正在保存…' : '保存设置'}</button></div>
    </form>

    <section className="card settings-section danger-zone" style={{ marginTop: 22, maxWidth: 900 }}><div className="card-body"><div className="settings-inline"><div><h4>紧急停止</h4><p>立即断开 Tunnel 和本地 MCP，并停止正在运行的所有终端任务。</p></div><button className="button danger" onClick={() => { if (window.confirm('确认断开 ChatGPT 并停止所有任务？')) void window.webCodex.emergencyStop().then(() => notify('已安全停止')) }}><Unplug size={16} /><ShieldAlert size={16} />立即全部停止</button></div></div></section>
  </div>
}