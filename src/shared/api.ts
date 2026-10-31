import type { AppConfig, AuditLogEvent, AuditLogFilter, LogServiceState, McpServerConfig, Project, ProjectContext, RemoteShellPolicy, RuntimeSnapshot, ShellKind, ShellTask, UploadItem } from './types'

export interface ProjectInput {
  name?: string
  path: string
  enabled?: boolean
  remoteShell?: RemoteShellPolicy
  createDirectory?: boolean
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type McpServerInput = DistributiveOmit<McpServerConfig, 'id'> & { id?: string }

export interface ShellRunInput {
  projectId: string
  command: string
  shell?: ShellKind
  cwd?: string
  timeoutMs?: number
  wait?: boolean
}

export interface ConnectionInfo {
  localAddress: string
  publicUrl: string
  token: string
  tunnelId: string
}

export type NavigationPage = 'home' | 'projects' | 'tunnel' | 'connections' | 'activity' | 'settings'
export const TUNNEL_API_KEY_CONFIGURED = '__configured__'

export interface WebCodexApi {
  getConfig(): Promise<AppConfig>
  getRuntime(): Promise<RuntimeSnapshot>
  updateConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  selectDirectory(): Promise<string | null>
  createProject(input: ProjectInput): Promise<Project>
  updateProject(id: string, patch: Partial<ProjectInput>): Promise<Project>
  removeProject(id: string): Promise<void>
  getProjectContext(id: string): Promise<ProjectContext>
  saveProjectInstructions(id: string, content: string): Promise<ProjectContext>
  openProject(id: string): Promise<void>
  startGateway(): Promise<void>
  stopGateway(): Promise<void>
  startTunnel(): Promise<void>
  stopTunnel(): Promise<void>
  saveMcpServer(input: McpServerInput): Promise<McpServerConfig>
  removeMcpServer(id: string): Promise<void>
  connectMcpServer(id: string): Promise<void>
  disconnectMcpServer(id: string): Promise<void>
  runShell(input: ShellRunInput): Promise<ShellTask>
  stopShell(id: string): Promise<ShellTask>
  getConnectionInfo(): Promise<ConnectionInfo>
  emergencyStop(): Promise<void>
  listLogs(filter?: AuditLogFilter): Promise<AuditLogEvent[]>
  getLogState(): Promise<LogServiceState>
  exportLogs(): Promise<{ files: number; destination: string } | null>
  openLogDirectory(): Promise<void>
  listUploads(): Promise<UploadItem[]>
  selectUploadFiles(): Promise<UploadItem[]>
  addUploadFiles(paths: string[]): Promise<UploadItem[]>
  removeUpload(id: string): Promise<void>
  getPathForFile(file: File): string
  openExternal(url: string): Promise<void>
  onLogEvent(callback: (event: AuditLogEvent) => void): () => void
  onLogState(callback: (state: LogServiceState) => void): () => void
  onNavigate(callback: (page: NavigationPage) => void): () => void
  onRuntimeChange(callback: (snapshot: RuntimeSnapshot) => void): () => void
  onConfigChange(callback: (config: AppConfig) => void): () => void
}

declare global {
  interface Window {
    webCodex: WebCodexApi
  }
}