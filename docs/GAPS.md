# Issue-list gap audit

This matrix maps the Desktop capability assessment in the user's `问题.md` to the current implementation. A feature is only marked **Complete** when it has a tool/API, tests, and documented behavior.

## P0

| Item | Status | Current implementation | Remaining limitation |
| --- | --- | --- | --- |
| Binary upload/download | **Partial** | Chunked binary read/write with offsets and SHA-256, safe ZIP create/extract, attachment inbox, binary copy into projects with fail/overwrite/rename conflict handling, inline MCP resource download, transfer hash/status | ChatGPT cannot pass an arbitrary chat attachment reference directly to an MCP server. The user must place the attachment in the Attachment Inbox. Inline MCP resources depend on host support; `file_read_binary` remains the guaranteed path. No dedicated persistent upload-session registry beyond offset/hash checks. |
| Project and host security isolation | **Partial** | Canonical project paths, symlink/path escape rejection, per-project remote shell allow/allowlist/deny policy, project disable/removal, emergency stop, explicit `sandboxed:false` capability report, loopback-only Gateway auth | No OS-level sandbox, NTFS ACL policy, mount namespace, container isolation, network egress policy, CPU/RAM quota, or approval UI for Workspace Only/Developer/Host Control modes. Shell commands still have full desktop-user authority by design. |
| Disconnect recovery | **Partial** | Official Tunnel reconnect behavior, task state persisted to app data, idempotency keys deduplicate shell/process launches, task status/output retrieval after ChatGPT reconnect, interrupted tasks marked unknown/failed after app restart | A local process cannot be resurrected after the desktop process/host itself restarts. The record is preserved as failed with an unknown-final-state reason; no live process reattachment. |
| Large log handling | **Complete** | `shell_task_list` returns metadata only with status/project filters and pagination; `shell_task_output` returns byte-offset chunks for stdout/stderr; JSONL audit logs are separately filterable/exportable | No push subscription/streaming notification channel; clients poll output offsets. |
| File concurrency protection | **Complete** for file operations | `file_read` returns SHA-256; `file_write` accepts expected hash and writes atomically; `file_patch` accepts expected hash and supports dry-run/hash preview; recoverable trash and explicit backup exist | Multi-file transactional commits are not implemented. Textual diff preview is represented by before/after hashes, not a rendered patch preview. |
| Binary download resource return | **Partial** | `file_download` returns chunk metadata plus an MCP inline resource with MIME and Base64 | ChatGPT host support for inline resources is not guaranteed; large files still require repeated chunks. |

## P1

| Item | Status | Current implementation | Remaining limitation |
| --- | --- | --- | --- |
| Structured process execution | **Complete** | `process_run` uses executable + argv + environment + optional stdin without shell interpolation; project remote policy applies; structured result and logs | No PTY terminal semantics. |
| Interactive terminal | **Partial** | Running processes expose pipe stdin write/close tools; long-running processes remain observable and stoppable | No PTY, terminal resize, ANSI screen buffer, or reliable TUI interaction (`vim`, full-screen installers, some REPLs). |
| Git workflow | **Complete for local workflow** | Native `git_status`, `git_diff`, `git_log`, `git_branch_list`, project-contained `git_worktree_list/add/remove`, `git_conflict_list`, explicit `git_resolve_conflicts`, `git_stage`, `git_commit`; paths, branches, bases, worktree registration, and unmerged state validated; no push/history rewrite/hook bypass | Push, amend/history rewrite, and hook bypass remain intentionally unavailable. |
| System capability discovery | **Complete** | `host_capabilities` returns OS, CPU, memory, disk (the disk field may be omitted when `statfs` fails), runtimes, detected tools, proxy, project policy, and execution boundaries; `connection_health` reports Gateway/protocol/service status | Tool probing is PATH-based and cached for 30 seconds; it does not diagnose every installed dependency version. |
| Project management | **Complete** | MCP create/update/remove/instructions plus desktop UI; enable/disable and remote policy fields; registration validates directory existence and `project_list` reports live path health separately from `enabled` | Project removal is registration-only by design; it does not delete source files. |
| File copy/attributes/hash/backup/rollback | **Complete** | `file_copy`, `file_attributes`, `file_hash`, `file_backup`, `trash_list`, `trash_restore`, deletion impact plan, conflict strategies | No transactional multi-file edit/rollback group. |
| MCP resources and prompts | **Complete** for forwarding | Downstream `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, `mcp_prompt_get` with 4 MB limits and audit | Depends on downstream capability negotiation and host support. |
| Resource limits | **Partial** | Per-task timeout, output cap, archive/file/request limits, and a configurable concurrent-process cap (default 20) exist | No CPU, RAM, network, disk I/O quotas or OS-level resource enforcement. |

## P2 and operational items

| Item | Status | Notes |
| --- | --- | --- |
| GUI automation/screenshots | **Not implemented** | No window launch, screenshot, UI inspection, or desktop input tools. This remains necessary for final KiCad visual validation. |
| Multi-host / SSH / WSL / Docker | **Not implemented** | Single local desktop host only. No remote host identity or key-management model. |
| Multi-step task orchestration | **Not implemented** | Individual tasks, idempotency, persistence, and output cursors exist; no dependency graph, retry policy, checkpoints, or compensation. |
| Event notifications / subscriptions | **Not implemented** | Clients poll task metadata/output. No file-change, task-complete, or failure push notifications. |
| Sensitive-operation approval | **Partial** | Deletion impact preview, non-mutating deletion dry-run and file hash checks, patch dry-run, strict tool argument schemas, explicit Git staging, project shell policies, and emergency stop exist | No interactive approval prompt or dry-run for every write/shell operation. Full authority remains the default per product decision. |
| Extension management | **Partial** | Desktop UI can add, update, remove, connect, and disconnect downstream MCP servers; MCP tools can only list and call already-configured servers, and forward resources/prompts | No MCP-side server management, automatic package installation, update manager, or per-tool permission UI. |
| macOS/Linux privileged helper | **Not implemented** | Windows installer requests UAC; macOS/Linux use current-process privileges and report that truthfully | A separate least-privilege helper would require platform-specific packaging/signing. |
| Code signing/notarization | **Not implemented** | Release packaging is configured and unsigned | Requires Windows/macOS certificates and notarization credentials. |
| Automatic updates | **Not implemented** | Manual release downloads only | Requires an update feed, signature verification, rollout and rollback policy. |
| Automated interactive ChatGPT acceptance | **Not in CI** | Real JSONL evidence records successful `project_list`, remote `file_write`, file reads, and PowerShell calls | No browser-automation login in CI; account-bound interactive checks remain manual. |
| Full PTY | **Not implemented** | Pipe stdin exists; no terminal emulator | Requires `node-pty` or a per-platform terminal helper and corresponding native packaging validation. |

## Architectural boundary statements

- The structured file tools are project-contained; shell and structured process tools are **not sandboxed** and run with desktop-user authority.
- `No Auth` applies to ChatGPT-to-Tunnel authentication. Gateway Bearer authentication remains mandatory, and Tunnel/API-key secrets are OS-protected.
- Direct chat-attachment ingestion requires a host attachment API that this plugin cannot invent. The attachment inbox is the supported bridge.
- Inline MCP download resources are protocol-native, but actual ChatGPT rendering/download behavior must be verified against the live host.

## Current verification snapshot

- 150 tests total (133 core/service + 17 MCP E2E).
- Total coverage: 93.46% lines, 81.30% branches, 90.86% functions (90.94% statements).
- Official Tunnel local control plane: `server/discover`, 58 tools, `project_list`, binary attachment copy.
- Real packaged Electron UI smoke (`appVersion=0.3.0`): six pages, tray, attachment inbox, log center, redacted diagnostics, concurrency-setting IPC, menu hidden, installed `server/discover` 200.
- Installed 0.3.0 Desktop QA: `tools/list` returned 58 tools; UTF-8 `offset=5,maxBytes=9` returned `文🙂 c` with `offset=3,nextOffset=12` and no replacement character; default CMD/PowerShell and `shell_task_output` returned `中文🙂 café Ω`; moving onto an existing destination returned `FILE_ALREADY_EXISTS`.
- Historical retained JSONL was scrubbed for ChatGPT subject/session/organization/location/timezone metadata.
- Local unsigned Windows test packages, not published: `release-local/Web Codex-0.3.0-Windows-x64.exe` (SHA-256 `ab11ca5d225e74637c2f6657bd0871286f61995c979d5ed802e60761cf997ca4`), `release-local/Web Codex-0.3.0-Windows-arm64.exe` (SHA-256 `ea4c076a5a10ab97d5a15c9d00d69a0719b7e90a773e03eb93aa37a4991fc657`), and `release-local/Web Codex-0.3.0-Windows.exe` combined installer (SHA-256 `d3177b988541ff0a479d3d7f58f87dfc11827dc6ae4363e505668942e8d17b22`). Rebuilt after all QA fixes including UTF-8 reads, move-overwrite protection, shell Unicode output, and structured errors.
- Production dependency audit: 0 reported vulnerabilities.
- Automated `security_audit` full-repository deep and normal runs timed out in phase 1 after 300 seconds; no audit-pass result is claimed. Manual repository review and targeted security tests passed, but the automated audit must be rerun in a longer-running environment.
- Published 0.2.1 release packages are unsigned.
- The 0.5.1 package is a local, unsigned, unreleased test build; it is not pushed or published.

This file must be updated whenever a partial or unimplemented item changes.