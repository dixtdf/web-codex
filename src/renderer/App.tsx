import { useCallback, useEffect, useState } from 'react'
import { Activity, Blocks, Bot, FolderKanban, Home, RadioTower, Settings, ShieldAlert, Sparkles, Wifi, X } from 'lucide-react'
import packageJson from '../../package.json'
import type { AppConfig, RuntimeSnapshot } from '../shared/types'
import { errorText } from './components/ui'
import { HomePage } from './pages/home'
import { ProjectsPage } from './pages/projects'
import { ConnectionsPage } from './pages/connections'
import { TunnelPage } from './pages/tunnel'
import { ActivityPage } from './pages/activity'
import { SettingsPage } from './pages/settings'

export type Page = 'home' | 'projects' | 'tunnel' | 'connections' | 'activity' | 'settings'
export type Notify = (message: string, tone?: 'success' | 'error') => void

const navigation = [
  { id: 'home' as const, label: '首页', icon: Home },
  { id: 'projects' as const, label: '项目', icon: FolderKanban },
  { id: 'tunnel' as const, label: 'Tunnel', icon: RadioTower },
  { id: 'connections' as const, label: 'MCP 连接', icon: Blocks },
  { id: 'activity' as const, label: '任务活动', icon: Activity },
  { id: 'settings' as const, label: '设置', icon: Settings }
]

export default function App() {
  const [page, setPage] = useState<Page>('home')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null)

  const notify = useCallback<Notify>((message, tone = 'success') => {
    setToast({ message, tone })
    window.setTimeout(() => setToast(null), tone === 'error' ? 6000 : 3000)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextRuntime] = await Promise.all([window.webCodex.getConfig(), window.webCodex.getRuntime()])
      setConfig(nextConfig)
      setRuntime(nextRuntime)
      setLoadError('')
    } catch (error) {
      setLoadError(errorText(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const removeRuntime = window.webCodex.onRuntimeChange(setRuntime)
    const removeConfig = window.webCodex.onConfigChange(setConfig)
    const removeNavigate = window.webCodex.onNavigate(setPage)
    return () => {
      removeRuntime()
      removeConfig()
      removeNavigate()
    }
  }, [refresh])

  useEffect(() => {
    document.documentElement.dataset.theme = config?.ui.theme ?? 'system'
  }, [config?.ui.theme])

  if (!config || !runtime) {
    return <div className="app-loading"><div className="brand-mark large"><Bot size={30} /></div><h1>Web Codex</h1><p>{loadError || '正在准备你的本地工作区…'}</p>{loadError && <button className="button primary" onClick={() => void refresh()}>重新加载</button>}</div>
  }

  const runningTasks = runtime.tasks.filter((task) => task.status === 'running').length
  const pageProps = { config, runtime, notify, refresh }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Bot size={23} /></div><div><strong>Web Codex</strong><span>LOCAL AI WORKSPACE</span></div></div>
      <nav className="main-nav" aria-label="主导航">
        {navigation.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}><item.icon size={19} /><span>{item.label}</span>{item.id === 'activity' && runningTasks > 0 && <b>{runningTasks}</b>}</button>)}
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-status">
        <div className="sidebar-status-title"><Sparkles size={15} /><span>ChatGPT 工作区</span></div>
        <div className="sidebar-status-line"><span className={`status-dot ${runtime.gateway.running ? 'online' : ''}`} />{runtime.gateway.running ? '本地服务已就绪' : '本地服务未启动'}</div>
        <div className="sidebar-status-line"><Wifi size={13} />{runtime.tunnel.phase === 'ready' ? 'Tunnel 已就绪' : runtime.tunnel.phase === 'checking' || runtime.tunnel.phase === 'starting' ? 'Tunnel 正在连接' : runtime.tunnel.phase === 'error' ? 'Tunnel 连接异常' : 'Tunnel 未连接'}</div>
      </div>
      <button className="emergency-button" onClick={() => { if (window.confirm('立即断开 ChatGPT 并停止正在运行的命令？')) void window.webCodex.emergencyStop().then(() => notify('已断开连接并停止任务')) }}><ShieldAlert size={17} />紧急停止</button>
      <div className="sidebar-footer"><span className={`permission-dot ${runtime.privileged ? 'admin' : ''}`} />{runtime.privileged ? '管理员模式' : '标准权限'}<span>v{packageJson.version}</span></div>
    </aside>
    <main className="main-content">
      {page === 'home' && <HomePage {...pageProps} onNavigate={setPage} />}
      {page === 'projects' && <ProjectsPage {...pageProps} />}
      {page === 'tunnel' && <TunnelPage {...pageProps} onNavigate={setPage} />}
      {page === 'connections' && <ConnectionsPage {...pageProps} />}
      {page === 'activity' && <ActivityPage {...pageProps} />}
      {page === 'settings' && <SettingsPage {...pageProps} />}
    </main>
    {toast && <div className={`toast ${toast.tone}`}><span>{toast.message}</span><button onClick={() => setToast(null)} aria-label="关闭通知"><X size={16} /></button></div>}
  </div>
}