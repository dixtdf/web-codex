export type ShellKind = 'auto' | 'cmd' | 'powershell' | 'bash' | 'zsh'

export type RemoteShellMode = 'allow' | 'allowlist' | 'deny'

export interface RemoteShellPolicy {
  mode: RemoteShellMode
  allowedPrefixes: string[]
}

export interface Project {
  id: string
  name: string
  path: string
  enabled: boolean
  remoteShell?: RemoteShellPolicy
  createdAt: string
  updatedAt: string
}

export interface ProjectContext {
  project: Project
  instructions: string
  instructionFile: string | null
}

export interface StdioMcpServerConfig {
  id: string
  name: string
  alias: string
  enabled: boolean
  transport: 'stdio'
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
}

export interface HttpMcpServerConfig {
  id: string
  name: string
  alias: string
  enabled: boolean
  transport: 'streamable-http'
  url: string
  headers: Record<string, string>
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig

export interface NetworkSettings {
  mode: 'auto' | 'manual' | 'direct'
  manualProxy?: string
  noProxy: string
  refreshIntervalMs: number
}

export interface GatewaySettings {
  host: string
  port: number
  autoStart: boolean
  authToken: string
}

export interface TunnelSettings {
  autoStart: boolean
  tunnelId: string
  apiKey: string
  publicUrl: string
  command?: string
  args?: string[]
}

export interface UiSettings {
  theme: 'system' | 'light' | 'dark'
  startMinimized: boolean
}

export interface AppConfig {
  version: 1
  projects: Project[]
  mcpServers: McpServerConfig[]
  network: NetworkSettings
  gateway: GatewaySettings
  tunnel: TunnelSettings
  ui: UiSettings
}

export interface ProxyState {
  mode: NetworkSettings['mode']
  source: 'environment' | 'system' | 'manual' | 'direct'
  proxy: string | null
  noProxy: string
  checkedAt: string
  error?: string
}

export interface ServiceState {
  running: boolean
  detail: string
  address?: string
  publicUrl?: string
  error?: string
}

export type TunnelPhase = 'disconnected' | 'checking' | 'starting' | 'ready' | 'error'

export interface TunnelClientState {
  available: boolean
  detail?: string
  error?: string
}

export interface TunnelState extends ServiceState {
  phase: TunnelPhase
  client?: TunnelClientState
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifiedAt: string
}

export interface ShellTask {
  id: string
  projectId: string
  command: string
  shell: Exclude<ShellKind, 'auto'>
  cwd: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  pid?: number
  exitCode: number | null
  signal: string | null
  startedAt: string
  endedAt: string | null
  stdout: string
  stderr: string
  truncated: boolean
}

export interface McpConnectionState {
  id: string
  name: string
  alias: string
  enabled: boolean
  connected: boolean
  toolCount: number
  error?: string
}

export interface SecretStorageState {
  mode: 'os-protected' | 'memory-only'
  persistent: boolean
  detail: string
}

export interface RuntimeSnapshot {
  gateway: ServiceState
  tunnel: TunnelState
  proxy: ProxyState
  tasks: ShellTask[]
  mcpConnections: McpConnectionState[]
  secrets: SecretStorageState
  privileged: boolean
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogCategory = 'app' | 'gateway' | 'tunnel' | 'mcp' | 'project' | 'file' | 'shell' | 'network' | 'config' | 'security'
export type LogOrigin = 'remote' | 'local' | 'system'
export type LogStatus = 'started' | 'success' | 'error' | 'info' | 'stopped'

export interface AuditLogEvent {
  id: string
  timestamp: string
  level: LogLevel
  category: LogCategory
  action: string
  message: string
  origin: LogOrigin
  status: LogStatus
  requestId?: string
  projectId?: string
  taskId?: string
  durationMs?: number
  data?: unknown
}

export interface AuditLogFilter {
  category?: LogCategory | 'all'
  level?: LogLevel | 'all'
  origin?: LogOrigin | 'all'
  query?: string
  limit?: number
}

export interface LogServiceState {
  directory: string
  persistent: boolean
  retentionDays: number
  lastError?: string
}