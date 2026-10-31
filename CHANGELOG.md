# Changelog

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