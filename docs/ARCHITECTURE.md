# Architecture

## Process model

- `src/main`: Electron lifecycle, native dialogs, privileged status, IPC registration, and shutdown coordination.
- `src/preload`: a narrow `window.webCodex` bridge. Raw `ipcRenderer` is not exposed to the renderer.
- `src/shared`: API input/output contracts and runtime types shared by all processes.
- `src/core`: configuration, projects, files, shells, proxy detection, downstream MCP, local Gateway, Tunnel, and runtime orchestration.
- `src/renderer`: React pages and visual components.

## Runtime composition

`Runtime` owns one `ConfigStore` and constructs the domain services. `ProjectService` supplies canonical, enabled project roots to `FileService` and `ShellService`. `UploadService` keeps native attachments in an app-owned inbox and delegates bounded binary copy and safe ZIP extraction to `FileService`. `ProxyManager` supplies dynamic network behavior to `McpHub` and `TunnelManager`. `McpGateway` exposes project, file, shell, and downstream tools over local Streamable HTTP.

`ActivityLogger` records local and remote events as JSONL under `logs/` in Electron's user-data directory. `AsyncLocalStorage` propagates the remote request ID and origin into shell and downstream MCP events. Writes are serialized, rotated by size, retained for 14 days, and can be exported as one JSONL file.

Runtime, configuration, shell, MCP connection, proxy, and Tunnel changes are emitted as snapshots. Electron main forwards those snapshots and audit events to React through typed IPC subscriptions.

## MCP request flow

1. ChatGPT connects to the public Tunnel URL when a live Tunnel is configured.
2. The Tunnel forwards to the loopback Gateway.
3. Express validates the Bearer token before parsing MCP requests.
4. Each stateless request receives an SDK `McpServer` and `StreamableHTTPServerTransport`.
5. Workspace tools call domain services directly; `shell_run` evaluates the selected project's remote command policy before starting a process. `mcp_tool_call` resolves a namespaced downstream tool through `McpHub`.
6. Tool responses include text JSON and `structuredContent` so structured MCP results remain available.

## Persistence and process ownership

Configuration is stored as JSON in Electron's user-data directory. Writes use a temporary file, rename, and serialized queue; snapshots returned to callers are cloned. `ConfigStore` encrypts Gateway, Tunnel, and downstream MCP secret fields through the asynchronous `SecretProtector` interface implemented by Electron `safeStorage`. If OS encryption is unavailable, secrets remain memory-only and are persisted empty. Shell and Tunnel processes are owned by their services and terminated during emergency stop or application shutdown.

## Validation architecture

Tests use temporary directories and loopback servers. stdio tests start an SDK MCP fixture in a child Node process; Streamable HTTP tests start real SDK servers. Proxy system commands are mocked, while proxy network behavior uses only a local HTTP fixture. No test requires a logged-in ChatGPT account.