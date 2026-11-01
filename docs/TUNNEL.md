# OpenAI Secure Tunnel integration

## User-facing setup

Users configure only two values on the dedicated **Tunnel** page:

- **Tunnel ID** from OpenAI Platform Tunnels management.
- **Runtime API Key** with `Tunnels: Read` and `Tunnels: Use` permissions.

The API key is write-only in the renderer. After saving, the form receives only a configured marker; leaving the field blank preserves the existing key. Commands, profile paths, local routes, and Web Codex credentials are not exposed as user settings.

The key is stored in the current user's application-data configuration and excluded from runtime snapshots, renderer configuration responses, audit logs, and intentional error messages.

## Bundled official client

`npm run tunnel:prepare` downloads the pinned `openai/tunnel-client` release, verifies the archive against the release `SHA256SUMS.txt`, and stores the executable, license file, and manifest under `resources/tunnel-client/`. `predev`, `prebuild`, and packaging hooks prepare the required target. Packaging places the client under the application's `resources/tunnel-client/` directory.

Runtime resolution prefers an existing packaged binary and otherwise uses the development resource directory. It does not depend on a system `openai` command and does not treat the separate Codex CLI as a Tunnel client.

The validated local client is `tunnel-client 0.0.19`. Its public command surface provides `init`, `doctor`, and `run`; there is no `tunnel` subcommand.

## Startup sequence

1. Validate credential presence and the official Tunnel ID format.
2. Run `tunnel-client run --help` without secrets and verify MCP, control-plane, and health options.
3. Create or replace the app-owned `web-codex` profile with `sample_mcp_remote_no_auth`, the Tunnel ID, and the loopback Gateway URL.
4. Run `tunnel-client doctor --profile web-codex --explain` with runtime credentials and static Gateway Bearer headers in the child environment.
5. Start `tunnel-client run` with health listening on `127.0.0.1:0` and an app-owned health URL file.
6. Poll the reported loopback `/readyz` endpoint. Only HTTP success produces the `ready` phase.

The daemon receives `CONTROL_PLANE_API_KEY` and Gateway Bearer values through environment variables, not command-line arguments. The profile stores only `env:CONTROL_PLANE_API_KEY` as the key reference.

A running process is not considered ready. Preflight, spawn, output, readiness timeout, and exit states are distinct. A process that does not report `/readyz` success within 30 seconds enters an explicit error state.

## ChatGPT Connector and OAuth

Use **Tunnel + No Auth** in [ChatGPT Connector settings](https://chatgpt.com/#settings/Connectors). Create or verify the Connector only while the daemon is running, then run a real `project_list` request as final acceptance.

The local target uses `sample_mcp_remote_no_auth`. It does not expose OAuth authorization-server metadata. Gateway Bearer authentication remains enabled. `MCP_AUTHORIZATION` holds the credential only in the child environment, while `MCP_EXTRA_HEADERS` and `MCP_DISCOVERY_EXTRA_HEADERS` reference it using the official `env:` mechanism.

If ChatGPT reports **“无法发现 OAuth 设置”**:

- Select **Tunnel + No Auth**, not **URL + OAuth**.
- Do not paste `127.0.0.1` or another loopback URL into the web page; ChatGPT cannot reach the workstation's loopback interface.
- Do not disable Gateway authentication or invent an OAuth issuer. Web Codex does not provide an OpenAI OAuth login service.
- Run the Tunnel page's startup flow again and inspect `doctor` plus `/readyz` diagnostics. A process being alive is not sufficient for Connector discovery.

Gateway 401 responses use `WWW-Authenticate: Bearer realm="web-codex"`. Unknown OAuth metadata routes return an empty HTTP 404 response, explicitly meaning no metadata is published. HTML error pages and JSON error objects are not returned there because the official client can mistake them for malformed Protected Resource Metadata.

## Diagnostics

Use **任务与日志 → 审计日志 → Tunnel** to inspect client checks, init/doctor failures, spawn events, redacted output, `/readyz` results, exit codes, and stop events. Connector requests share `requestId` across Gateway and tool events. Export retained JSONL for AI-assisted investigation; never include API keys in screenshots or issue reports.

## Validation record

| Date | Check | Result |
| --- | --- | --- |
| 2026-10-31 | System `openai` lookup | Not installed; former `spawn openai ENOENT` reproduced |
| 2026-10-31 | `codex-cli 0.152.1 tunnel --help` | No Tunnel subcommand; not the bundled client |
| 2026-10-31 | Bundled `tunnel-client 0.0.19 run --help` | Official `run`, MCP, control-plane, and health options verified |
| 2026-10-31 | `tunnel-client init --sample sample_mcp_remote_no_auth` | Profile generated with loopback MCP URL and `env:CONTROL_PLANE_API_KEY` |
| 2026-10-31 | Packaged app with authorized saved credentials | `readyz` returned `200 ready` (persisted log evidence); `healthz` returned `200 live` by direct manual observation only, with no persisted log evidence |
| 2026-10-31 | Authenticated local Gateway `tools/list` | HTTP 200, 58 tools, `project_list` present |
| 2026-10-31 | Official `dev proxy` + real Runtime | External initialize, 58-tool discovery, resources/prompts, and `project_list` all passed; `artifacts/official-tunnel-report.json` |
| 2026-10-31 15:18:43 UTC | Interactive ChatGPT `project_list` | HTTP 200 in persisted JSONL, `requestId=0`; project list and context read succeeded |
| 2026-10-31 15:31:39 UTC | Interactive remote `file_write` | HTTP 200 in persisted JSONL, `requestId=0`; README content was written successfully |
| 2026-10-31 | Interactive ChatGPT Desktop plugin overall | Remote workspace connection, project discovery, file listing/reading, PowerShell execution, and text-file write all succeeded |

A live local Tunnel ready state and interactive remote project discovery/text writing are verified from persisted audit evidence. Complete binary transfer was initially unavailable and is now covered by chunked transfer plus the attachment inbox.