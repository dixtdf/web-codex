# Changelog

## 0.5.2 - 2026-11-01 (unsigned)

### Fixed

- Hardened process, Tunnel, Gateway, and runtime lifecycle handling, including stdin errors, startup failures, concurrent starts, and coordinated emergency shutdown.
- Corrected IPv6 loopback URLs, full IPv4 loopback proxy bypass, disconnected MCP tool discovery, and duplicate downstream connection attempts.
- Strengthened project boundaries, case-sensitive path handling, binary-read validation, transactional ZIP validation, and batch-upload rollback.
- Prevented configuration write failures and legacy MCP fields from breaking startup, redacted correlation identifiers, and blocked audit export over active log files.
- Corrected host uptime reporting, native directory-open errors, task project selection, and renderer IPC error notifications.
- Added regression coverage for malformed MCP JSON, configuration persistence recovery, legacy configuration migration, and real concurrent startup behavior.
- Windows CMD built-in commands consistently execute through a temporary UTF-8 script with explicit `exit /b`, preventing simple commands such as `echo CMD_1453` from remaining open in affected Electron environments. External executables retain direct process-tree execution, and quoted/Unicode commands remain covered.
- Added direct ShellService and real MCP regressions for the four-second CMD timeout case, quoted commands, Unicode output, non-zero exits, and background process-tree termination.
- Documented recovery actions for unavailable project registrations and the precise backward-aligned UTF-8 `requestedOffset`/`actualOffset`/`nextOffset` pagination contract.

## 0.5.1 - 2026-11-01 (local/unreleased; unsigned)

### Added

- File search supports up to 100 project-relative `includeGlobs` and `excludeGlobs`, composed with `.gitignore` handling and cursor pagination.
- UTF-8 file reads explicitly return `actualOffset` and consumed `bytes` alongside the backward-compatible `offset` field.
- MCP E2E schema checks cover every tool's strict input object and all safety/pagination parameters highlighted by Desktop QA, including nested remote-shell policy validation.
- Documented PowerShell 5.1's need for explicit `-Encoding UTF8` when reading UTF-8 files without BOM.

## 0.5.0 - 2026-11-01 (local/unreleased; unsigned)

### Changed

- File search returns deterministic cursor-paginated `{ matches, nextCursor }` results and honors root `.gitignore` rules by default.
- Project listing reports live path health separately from the enabled registration state.
- Shell and structured-process tool descriptions explicitly disclose full desktop-user authority rather than implying project sandboxing.

### Fixed

- File deletion supports non-mutating dry runs and expected-SHA-256 checks; stale versions cannot be deleted.
- Workspace MCP tools reject unknown top-level arguments through strict schemas instead of silently ignoring misspelled safety options.
- Task output pagination advances across UTF-8 boundaries without splitting characters and reports requested/actual offsets.

## 0.3.0 - 2026-11-01 (local/unreleased; not committed, pushed, or published; unsigned)

### Added

- Git status/diff/log/branches, project-contained worktree list/add/remove, conflict discovery and explicit ours/theirs resolution, staging, and local commits.
- Structured process execution, interactive pipe stdin, task persistence, idempotency, output pagination, a user-configurable concurrent-process cap (1-200, default 20), host capabilities, connection health, and redacted diagnostic export.
- Hash/version-aware atomic text writes and patches, dry-run patches, file attributes, copy conflict strategies, deletion impact previews, recoverable trash, and explicit backups.
- Chunked binary download resources, transfer verification status, file hashes, safe archives, and attachment copy conflict handling.
- Project lifecycle and AGENTS/agent instructions tools through MCP.
- Downstream MCP Resources and Prompts forwarding.

### Fixed

- Windows cmd commands now preserve quoted scripts through verbatim argument passing.
- Task state `flush()` now writes the final scheduled state, preventing completed tasks from being misreported as interrupted after restart.
- Empty Git repositories now report the actual branch name.
- Explicit Git commit paths are staged before commit, including new files.
- Hash-verified binary writes now use temporary-file validation and atomic replacement, preserving the original file on mismatch.
- Downstream resource and prompt responses are limited to 4 MB.
- ChatGPT identity, session, organization, location, and timezone metadata are redacted and existing retained JSONL files are scrubbed during initialization.

- Tunnel IDs are redacted from new audit events and from retained JSONL files during initialization.
- Desktop QA regressions: UTF-8 pagination aligns to code points, file moves reject overwrite by default unless hash-confirmed, Windows CMD/PowerShell output is UTF-8, process stop waits for close, and tool failures expose structured error codes.

## 0.2.1 - 2026-11-01

### Fixed

- Added the package author email and maintainer metadata required by Linux deb packaging, completing the three-platform release matrix.

## 0.2.0 - 2026-11-01

### Added

- Chunked binary read/write with SHA-256, safe ZIP creation/extraction, and a native attachment inbox for STEP, STL, KiCad, and ZIP files.
- Official `server/discover` compatibility and Base64 redaction in JSONL audit logs.
- Automatic binary copy/extract from the attachment inbox without Base64 transfer.

### Changed

- Windows and Linux desktop windows hide the native File/Edit application menu bar.

### Fixed

- Linux release artifact naming no longer uses the unsupported `${target}` macro, allowing AppImage and deb packages to be published alongside Windows and macOS assets.

## 0.1.4 - 2026-10-31

### Fixed

- Removed the GitHub API dependency from Tunnel client preparation; release assets and SHA-256 checksums now download directly, avoiding CI rate-limit failures.

## 0.1.3 - 2026-10-31

### Fixed

- Resolved the Linux after-pack executable path from the package name, allowing Fuse hardening and AppImage/deb packaging to complete.

## 0.1.2 - 2026-10-31

### Fixed

- Made duplicate-project tests correct on case-sensitive Linux filesystems.
- Replaced npm argument forwarding with direct `electron-builder --publish never` invocation in Windows release runners.
- Made official Tunnel verification create its artifact directory and recognize the cross-platform `MCP URL` startup format.
- Synchronized the UI, MCP Gateway, and downstream MCP client versions with `package.json`.

## 0.1.1 - 2026-10-31

### Fixed

- Regenerated `package-lock.json` with all platform-specific esbuild optional dependencies so `npm ci` succeeds on Windows, macOS, and Linux release runners.
- Updated the displayed application version to 0.1.1.

## 0.1.0 - 2026-10-31

### Added

- Independent Electron, React, and TypeScript desktop application.
- Versioned configuration and canonical project registration.
- Project-aware file listing, reading, writing, patching, searching, moving, and deletion.
- AGENTS.md and agent.md context reading and editing.
- cmd, PowerShell, bash, and zsh execution with observable background tasks.
- Optional per-project remote command policies with allow, prefix allowlist, and deny modes.
- Loopback-only authenticated Streamable HTTP MCP Gateway.
- stdio and Streamable HTTP downstream MCP aggregation with namespaced tools.
- Dynamic environment and operating-system proxy detection with NO_PROXY handling.
- Dedicated OpenAI Tunnel page with write-only API Key, Tunnel ID, hidden internal startup, ChatGPT No Auth guidance, and connection logs.
- Rotating JSONL audit logs with remote request/task correlation, filtering, export, and sensitive-data redaction.
- OS-protected encrypted storage for Gateway, Tunnel, and downstream MCP secrets, with plaintext migration and memory-only secure fallback.
- Home, Projects, Tunnel, MCP Connections, Activity, and Settings views with light and dark themes.
- Branded Bot application icons for window, installer, favicon, shortcuts, and system tray.
- System tray with left-click panel toggle, right-click runtime actions, close-to-tray behavior, and emergency stop.
- RunAsNode fuse hardening, development/installed data isolation, and safe single-instance window recovery.
- Windows UAC elevation packaging and three-platform release configuration.
- English and Simplified Chinese documentation, contributor guidance, and architectural decisions.
### Fixed

- Replaced the nonexistent `openai` command with the checksum-verified bundled official `openai/tunnel-client 0.0.19`, including no-auth profile initialization, doctor preflight, environment-referenced Bearer injection, and `/readyz` health verification.
- OAuth metadata routes now return empty 404 responses instead of HTML/JSON error bodies that the official client can mistake for malformed metadata.
- Added official local control-plane verification covering initialize, 17-tool discovery, and `project_list`.
- ChatGPT OAuth guidance now follows the official Tunnel + No Auth flow without inventing an OAuth service.