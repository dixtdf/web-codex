import { useEffect, useState, type FormEvent } from 'react'
import { FileText, Folder, FolderOpen, FolderPlus, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type { Project } from '../../shared/types'
import type { Notify } from '../App'
import { EmptyState, Field, Modal, PageHeader, StatusPill, Toggle, errorText } from '../components/ui'
import type { PageProps } from './types'
import { UploadInbox } from '../components/upload-inbox'

function ProjectForm({ project, onClose, notify, refresh }: { project?: Project; onClose: () => void; notify: Notify; refresh: () => Promise<void> }) {
  const [name, setName] = useState(project?.name ?? '')
  const [path, setPath] = useState(project?.path ?? '')
  const [remoteShellMode, setRemoteShellMode] = useState(project?.remoteShell?.mode ?? 'allow')
  const [allowedPrefixes, setAllowedPrefixes] = useState((project?.remoteShell?.allowedPrefixes ?? []).join('\n'))
  const [busy, setBusy] = useState(false)

  const chooseFolder = async (): Promise<void> => {
    try {
      const selected = await window.webCodex.selectDirectory()
      if (selected) setPath(selected)
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      const remoteShell = {
        mode: remoteShellMode,
        allowedPrefixes: allowedPrefixes.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      }
      if (project) await window.webCodex.updateProject(project.id, { name, path, remoteShell })
      else await window.webCodex.createProject({ name, path, remoteShell, createDirectory: true })
      await refresh()
      notify(project ? '项目已更新' : '项目已添加，现在可以让 ChatGPT 使用')
      onClose()
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={project ? '编辑项目' : '添加工作项目'} description="项目文件仍保留在原位置，不会被上传或复制。" onClose={onClose}>
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <Field label="项目文件夹" hint={project ? '更改路径不会移动原文件夹。' : '可以选择已有目录，也可以输入一个新目录路径。'}>
        <div className="input-with-button"><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="例如：D:\\Projects\\my-app" required /><button type="button" className="button secondary" onClick={() => void chooseFolder()}><FolderOpen size={16} />选择</button></div>
      </Field>
      <Field label="显示名称" hint="留空时自动使用文件夹名称。"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="我的项目" /></Field>
      <Field label="远程命令策略" hint="只限制 ChatGPT 通过 MCP 发起的命令，本机任务页面始终保留完整访问。">
        <select value={remoteShellMode} onChange={(event) => setRemoteShellMode(event.target.value as typeof remoteShellMode)}>
          <option value="allow">允许全部远程命令（默认）</option>
          <option value="allowlist">仅允许指定命令前缀</option>
          <option value="deny">禁止远程命令</option>
        </select>
      </Field>
      {remoteShellMode === 'allowlist' && <Field label="允许的命令前缀" hint="每行一个命令前缀，例如 npm test。包含管道、重定向、串联或变量展开的命令会被拒绝。"><textarea className="code mono" value={allowedPrefixes} onChange={(event) => setAllowedPrefixes(event.target.value)} placeholder={'npm test\nnpm run build\ngit status'} /></Field>}
      <div className="form-footer"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !path.trim()}>{busy ? '正在保存…' : project ? '保存修改' : '添加项目'}</button></div>
    </form>
  </Modal>
}

function InstructionsEditor({ project, onClose, notify }: { project: Project; onClose: () => void; notify: Notify }) {
  const [content, setContent] = useState('')
  const [filename, setFilename] = useState('AGENTS.md')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.webCodex.getProjectContext(project.id).then((context) => {
      setContent(context.instructions)
      setFilename(context.instructionFile ?? 'AGENTS.md')
      setLoading(false)
    }).catch((error) => {
      notify(errorText(error), 'error')
      onClose()
    })
  }, [project.id, notify])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.webCodex.saveProjectInstructions(project.id, content)
      notify(`已保存 ${filename}`)
      onClose()
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={`${project.name} · Agent 指令`} description="ChatGPT 开始项目工作前会读取这些约定。" onClose={onClose} wide>
    <Field label={filename} hint="可填写技术栈、常用命令、代码风格、禁止修改的目录和验收要求。">
      <textarea className="code" value={loading ? '正在读取…' : content} onChange={(event) => setContent(event.target.value)} disabled={loading} placeholder={'# 项目约定\n\n- 使用 TypeScript\n- 修改后运行 npm test\n- 不要提交 Git'} />
    </Field>
    <div className="form-footer"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || loading} onClick={() => void save()}>{busy ? '正在保存…' : '保存指令'}</button></div>
  </Modal>
}

export function ProjectsPage({ config, notify, refresh }: PageProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Project | undefined>()
  const [instructions, setInstructions] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)

  const remove = async (): Promise<void> => {
    if (!deleting) return
    try {
      await window.webCodex.removeProject(deleting.id)
      await refresh()
      notify('项目已移除，原文件没有改动')
      setDeleting(null)
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  const toggle = async (project: Project, enabled: boolean): Promise<void> => {
    try {
      await window.webCodex.updateProject(project.id, { enabled })
      await refresh()
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  return <div className="page-container">
    <PageHeader eyebrow="WORKSPACES" title="你的项目" description="把需要 AI 工作的文件夹放在这里。每个项目都有独立的文件边界和 Agent 指令。" actions={<button className="button primary" onClick={() => { setEditing(undefined); setFormOpen(true) }}><Plus size={16} />添加项目</button>} />
    <UploadInbox notify={notify} />
    {config.projects.length === 0 ? <EmptyState icon={<FolderPlus size={27} />} title="添加第一个项目" description="选择一个代码目录，ChatGPT 就能像在本机使用 Codex 一样读取、修改和运行它。" action={<button className="button primary" onClick={() => setFormOpen(true)}><FolderOpen size={16} />选择项目文件夹</button>} /> : <div className="grid-cards">
      {config.projects.map((project) => <article className="card project-card" key={project.id}>
        <div className="resource-card-top"><div className="resource-icon"><Folder size={21} /></div><div className="resource-title"><h3>{project.name}</h3><p title={project.path}>{project.path}</p></div><StatusPill tone={project.enabled ? 'success' : 'neutral'}>{project.enabled ? '可用' : '已停用'}</StatusPill></div>
        <div className="resource-meta"><span><FileText size={14} />AGENTS.md / agent.md</span><span><ShieldCheck size={14} />{project.remoteShell?.mode === 'deny' ? '远程命令已禁止' : project.remoteShell?.mode === 'allowlist' ? `远程命令允许 ${project.remoteShell.allowedPrefixes.length} 个前缀` : '远程命令默认允许'}</span><span>ID · {project.id.slice(0, 8)}</span></div>
        <div className="resource-actions"><Toggle checked={project.enabled} onChange={(enabled) => void toggle(project, enabled)} label={project.enabled ? '允许访问' : '已停用'} /><span className="spacer" /><button className="icon-button" title="打开文件夹" onClick={() => void window.webCodex.openProject(project.id).catch((error) => notify(errorText(error), 'error'))}><FolderOpen size={17} /></button><button className="icon-button" title="Agent 指令" onClick={() => setInstructions(project)}><FileText size={17} /></button><button className="icon-button" title="编辑项目" onClick={() => { setEditing(project); setFormOpen(true) }}><Pencil size={16} /></button><button className="icon-button danger" title="移除项目" onClick={() => setDeleting(project)}><Trash2 size={16} /></button></div>
      </article>)}
    </div>}
    {formOpen && <ProjectForm project={editing} onClose={() => setFormOpen(false)} notify={notify} refresh={refresh} />}
    {instructions && <InstructionsEditor project={instructions} onClose={() => setInstructions(null)} notify={notify} />}
    {deleting && <Modal title="移除这个项目？" description="只会从 Web Codex 移除登记，不会删除电脑上的任何文件。" onClose={() => setDeleting(null)}><div className="connection-box"><strong>{deleting.name}</strong><div className="connection-value">{deleting.path}</div></div><div className="form-footer"><button className="button secondary" onClick={() => setDeleting(null)}>取消</button><button className="button danger" onClick={() => void remove()}><Trash2 size={15} />移除项目</button></div></Modal>}
  </div>
}