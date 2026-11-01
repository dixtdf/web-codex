# Web Codex

[简体中文](README.zh-CN.md)

Web Codex is an independent, cross-platform Electron workspace that lets Web ChatGPT work with local projects through an authenticated MCP Gateway and OpenAI Tunnel. It provides project registration, bounded file tools, native shell tasks, and downstream MCP aggregation without uploading a project to a separate backend.

## Features

- Register local folders and maintain `AGENTS.md` or `agent.md` instructions.
- Read, write, patch, search, move, and delete files inside canonical project roots, with UTF-8/output cursors, SHA-256 conflict checks, deletion dry runs, and recoverable trash.
- Transfer STEP, STL, KiCad, and other binary files with chunked Base64/SHA-256, ZIP create/extract, and a drag-and-drop attachment inbox.
- Run cmd, PowerShell, bash, or zsh commands and structured executables with live output, pipe stdin, idempotency keys, timeouts, persisted tasks, pagination, concurrency limits, and process-tree termination.
- Inspect Git status, diffs, history, branches, staged paths, project-contained worktrees, explicit conflict resolution, and create local commits.
- Inspect host capabilities and export a redacted JSON connection-diagnostics report.
- Apply optional per-project remote command policies (`allow`, prefix `allowlist`, or `deny`) without restricting local full-access tasks.
- Audit local and remote activity with rotating JSONL logs, request/task correlation, filtering, export, and credential/content redaction.
- Encrypt Gateway, Tunnel, and downstream MCP secrets with Electron async `safeStorage`; never fall back to plaintext persistence.
- Expose a loopback-only, Bearer-authenticated Streamable HTTP MCP endpoint.
- Aggregate stdio and Streamable HTTP MCP servers as `alias__tool` tools and forward tools, resources, and prompts.
- Detect environment or system proxy settings with explicit manual/direct modes and loopback bypass.
- Configure OpenAI Secure Tunnel with only a Tunnel ID and write-only API Key; the checksum-verified official `openai/tunnel-client` is bundled and all startup details stay internal.
- Manage the local runtime through Home, Projects, Tunnel, MCP Connections, Activity, and Settings pages with a hidden Windows/Linux native menu bar.
- Keep the app available from a branded system tray: left-click toggles the panel, right-click opens runtime actions.

## Requirements

- Node.js 22.16 or newer
- npm
- An authorized ChatGPT account and valid Tunnel ID/API Key only for live Connector use; the official client is bundled in release packages.

Local development, protocol tests, and packaging do not require ChatGPT credentials.

## Install and run

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run lint
npm run typecheck
npm test
npm test -- --coverage
npm run test:e2e
npm run test:tunnel
npm run test:ui
npm run build
npm run dist
```

For `npm run test:ui`, first run `npm run build` and start `npx electron . --remote-debugging-port=9222` in another terminal.

`npm run dist` packages the current host. The release workflow builds the Windows, macOS, and Linux matrix.

## Connect a workspace

1. Add a project folder on the Projects page and review its Agent instructions.
2. Open the Tunnel page and enter only the Tunnel ID and API Key.
3. Select **Save and Start** and wait for the Tunnel-ready state.
4. In ChatGPT Plugins, add a custom MCP server, choose **Tunnel**, enter the same Tunnel ID, and select **No Auth**.
5. Run a real `project_list` request from ChatGPT to verify the complete connection.

The local MCP endpoint defaults to `http://127.0.0.1:32180/mcp` and is never intentionally bound to a LAN or public interface. Local Bearer credentials are injected by the Tunnel client and are not entered into ChatGPT.

## Binary files and attachments

- Drag chat attachments, STEP, STL, KiCad, or ZIP files into **Projects → Attachment Inbox**.
- Ask ChatGPT to list attachments, copy an attachment into a project, or extract an uploaded ZIP.
- For local project output, use `file_archive_create` to package a directory and `file_read_binary` for chunked transfer.
- Binary chunks include SHA-256 verification; raw Base64 and file contents are not written to audit logs.

## Documentation

- [Requirements](docs/REQUIREMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [JSONL audit logging](docs/LOGGING.md)
- [Validation record](docs/VALIDATION.md)
- [Capability gap audit](docs/GAPS.md)
- [MCP tools](docs/MCP_TOOLS.md)
- [Tunnel validation boundary](docs/TUNNEL.md)

## License

Apache-2.0