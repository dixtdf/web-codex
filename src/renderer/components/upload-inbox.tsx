import { useEffect, useState, type DragEvent } from 'react'
import { FileArchive, Paperclip, Plus, Trash2, UploadCloud } from 'lucide-react'
import type { UploadItem } from '../../shared/types'
import type { Notify } from '../App'
import { errorText } from './ui'

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function UploadInbox({ notify }: { notify: Notify }) {
  const [items, setItems] = useState<UploadItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      setItems(await window.webCodex.listUploads())
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const add = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    setBusy(true)
    try {
      await window.webCodex.addUploadFiles(paths)
      await refresh()
      notify('附件已放入收件箱，现在可以让 ChatGPT 复制或解压到项目')
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
      setDragging(false)
    }
  }

  const select = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.webCodex.selectUploadFiles()
      await refresh()
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const drop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    setDragging(false)
    const paths = Array.from(event.dataTransfer.files).map((file) => {
      try {
        return window.webCodex.getPathForFile(file)
      } catch {
        return ''
      }
    }).filter(Boolean)
    await add(paths)
  }

  const remove = async (item: UploadItem): Promise<void> => {
    try {
      await window.webCodex.removeUpload(item.id)
      await refresh()
      notify(`已移除 ${item.originalName}`)
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  return <section className="card upload-inbox">
    <div className="card-header"><div><h3><Paperclip size={16} />附件收件箱</h3><p>把聊天附件、STEP、STL、KiCad 或 ZIP 拖到这里，再让 ChatGPT 复制或解压到项目。</p></div><button className="button secondary small" disabled={busy} onClick={() => void select()}><Plus size={14} />选择文件</button></div>
    <div className={`upload-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => void drop(event)}>
      <UploadCloud size={23} /><div><strong>{busy ? '正在读取附件…' : dragging ? '松开以放入收件箱' : '拖放文件到这里'}</strong><span>单个文件不超过 200 MB；ZIP 在本地传输，无需 base64。</span></div>
    </div>
    {items.length > 0 && <div className="upload-list">{items.map((item) => <div className="upload-item" key={item.id}><FileArchive size={17} /><div><strong title={item.originalName}>{item.originalName}</strong><span>{formatBytes(item.size)} · {new Date(item.createdAt).toLocaleString()}</span></div><button className="icon-button danger" title="移除附件" onClick={() => void remove(item)}><Trash2 size={15} /></button></div>)}</div>}
  </section>
}