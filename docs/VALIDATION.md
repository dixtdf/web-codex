# Validation record

## 2026-10-31/2026-11-01 local release verification (UTC)

### Desktop follow-up hardening (0.5.1)

- `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run --coverage`: 20 test files, 150 tests passed (133 core/service + 17 MCP E2E); 93.46% lines, 81.30% branches, 90.86% functions (90.94% statements).
- `npm run test:e2e`: 17 real MCP HTTP tests passed, including strict schemas for every tool, all QA-highlighted safety parameters, and nested remote-shell policy rejection.
- `npm run test:tunnel`: official local control plane passed with version 0.5.1, 58 tools, `project_list`, and byte-identical `upload_copy`.
- `npm run dist:win`: built unsigned, unpublished Windows x64, arm64, and combined 0.5.1 NSIS installers. Two online Electron download attempts timed out; the successful build reused the existing official Electron 45.2.1 x64/arm64 ZIP cache with `ELECTRON_BUILDER_OFFLINE=true`.
- `npm run test:ui`: passed with `appVersion=0.5.1` against an isolated production Electron instance; all six pages, 58-tool discovery, typed IPC workflows, diagnostics, and runtime-error/layout checks passed.
- Added regression coverage for include/exclude glob search, explicit UTF-8 `actualOffset`/`bytes`, and PowerShell 5.1 encoding documentation.
- This 0.5.1 source is not pushed or published.

### Desktop deep-test follow-up (0.5.0)

- `npm run lint` and `npm run typecheck`: passed.
- `npx vitest run --coverage`: 20 test files, 149 tests passed (132 core/service + 17 MCP E2E); 93.45% lines, 81.11% branches, 90.84% functions (90.92% statements).
- `npm run test:e2e`: 17 real MCP HTTP tests passed, including strict unknown-argument rejection, deletion dry-run/CAS, search cursors, and stale-project health.
- `npm run test:tunnel`: official local control plane passed with 58 tools, `project_list`, and byte-identical `upload_copy`.
- `npm run build`: main, preload, and renderer production bundles passed.
- `npm run dist:win`: built unsigned, unpublished Windows x64, arm64, and combined 0.5.0 NSIS installers in `release/`; SHA-256 values are recorded in `docs/releases/v0.5.0.md` and `release/SHA256SUMS.txt`.
- `npm run test:ui`: passed against an isolated production Electron instance using an ephemeral Gateway port; all six pages, 58-tool discovery, typed IPC workflows, diagnostics, and runtime-error/layout checks passed. Evidence: `artifacts/ui-smoke-report.json`.
- Added regressions for non-mutating deletion previews, stale-hash deletion rejection, strict schemas, UTF-8 task-output chunks, deterministic search pagination, root `*.secret` ignore rules, and live project health.
- These 0.5.0 source changes are not pushed or published. The Windows 0.5.0 packages in `release/` include them.

### 2026-11-01 verification rerun

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- --coverage`: 20 test files, 143 tests passed (128 core/service + 15 MCP E2E); 93.36% lines, 80.51% branches, 90.76% functions (90.63% statements).
- `npm run test:e2e`: 15 tests passed.
- `npm run test:tunnel`: discovered 58 tools and completed actual `project_list` and `upload_copy` calls; it did not invoke every tool individually.
- Added exact Desktop QA regressions for UTF-8 pagination (`offset=5,maxBytes=9` and 1/2/3-byte chunks), file-move overwrite protection, Chinese/Emoji/Greek Shell output, `.gitignore` filtering, and structured error codes.
- Rebuilt the 0.3.0 Windows x64, arm64, and combined installers after these fixes.

### Static and dependency checks

- `npm run lint`: passed, including `src`, `tests`, and `scripts`.
- `npm run typecheck`: passed with TypeScript strict mode.
- `npm audit --omit=dev`: passed with 0 production dependency vulnerabilities.
- Electron upgraded to 45.2.1, Vitest to 5.0.5, and Zod to 4.6.7; the full suite passed after the upgrades.

### Automated service and protocol tests

- `npm test`: 20 test files, 143 tests passed (128 core/service + 15 MCP E2E in the same run).
- `npm run test:e2e`: 15 real MCP HTTP end-to-end tests passed, including JSONL remote-operation auditing, secret redaction, remote command policy checks, modern `server/discover`, host health, Git staging/commit, trash recovery, file hash/copy/download, and downstream resource/prompt empty states.
- `npm run test:tunnel`: the real Runtime and official `openai/tunnel-client 0.0.19` local control plane completed `server/discover`, initialize, discovery of 58 tools, `project_list`, and a binary `upload_copy` with byte-identical content; evidence is in `artifacts/official-tunnel-report.json`.
- Coverage includes projects, files, shells, downstream MCP, proxy handling, Tunnel credentials/process behavior, runtime orchestration, JSONL persistence/rotation/export, OS-protected secret storage, and error branches.

### Real Electron UI smoke test

`node scripts/ui-smoke.mjs` passed against a production Electron window over Chrome DevTools Protocol.

Verified:

- Home, Projects, Tunnel, MCP Connections, Activity, and Settings render and navigate successfully.
- No horizontal overflow was detected at the tested 1426-pixel viewport.
- No renderer exceptions or console errors were reported.
- The dedicated Tunnel page exposes only Tunnel ID and password-style API Key fields; no command, argument, MCP URL, or Bearer-token input is present.
- The system tray was created by the real main process, verified through persisted runtime audit logs.
- The bundled official client passed the Tunnel diagnostic and the runtime reported `readyz = 200 ready` with the user's real credentials; no credential values are included in this record.
- OS-protected secret storage passed in the real packaged application.
- Windows/Linux native File/Edit menu bar is removed and hidden; the main process records an `app.menu_hidden` audit event.
- Light/dark/system theme controls update the actual document state.
- The final UI report records `appVersion=0.3.0` and `concurrencySetting=true`; the settings-page 1–200 input and config IPC update were exercised.
- Project and MCP creation dialogs open and close; the project remote-command policy field renders.
- A temporary project was created and removed through the real typed IPC bridge.
- AGENTS.md content was saved, read back, and displayed in the instruction editor.
- The JSONL log center loaded persisted events and expanded structured event details without runtime errors.
- The attachment inbox uploaded and removed a real binary STL through typed IPC.
- Git, structured-process, interactive stdin, host diagnostics, trash recovery, and downstream Resources/Prompts services are covered by automated tests.
- Redacted diagnostics can be generated through typed IPC and exported as JSON; credentials, environment values, and task output bodies are excluded.
- ChatGPT identity/session/organization/location/timezone metadata is removed from new events, and retained historical JSONL was scrubbed once during initialization; no exact retained-event count is claimed. Tunnel IDs are now redacted from both new and retained records.
- Installed `server/discover` returned HTTP 200 with `resultType=complete` and `2026-07-28` support; the installed log records the `ui-discover` request and successful response.
- Installed 0.3.0 was re-run against the original QA inputs: 58 tools discovered; `file_read` returned `文🙂 c` with `offset=3,nextOffset=12` and no U+FFFD; default CMD/PowerShell and `shell_task_output` returned `中文🙂 café Ω`; moving onto a different existing destination returned structured `FILE_ALREADY_EXISTS`.

### Installed application and branding

- Packaged Windows builds disable Electron's RunAsNode fuse, so a host-level `ELECTRON_RUN_AS_NODE=1` cannot force the installed application into Node.js mode.
- Development and installed builds use separate user-data directories, preventing administrator-created cache permissions from blocking development.
- A second launch restores an empty or hidden main window instead of leaving a lock-owning process without UI.
- Closing the main window hides it to the tray; quitting from the tray stops owned processes.
- The branded Bot icon is generated as PNG, ICO, and ICNS and is used by the window, favicon, executable, installer, uninstaller, shortcuts, and tray.

Artifacts:

- `artifacts/ui-smoke-report.json`
- `artifacts/web-codex-home.png`
- `artifacts/web-codex-settings.png`

The local model's generic image-description result was not used as acceptance evidence because it described nonexistent UI text. DOM, IPC, runtime-error, and layout checks are the authoritative UI verification.

### Build and packaging

- `npm run build`: main, preload, and renderer production bundles passed.
- `npm run dist -- --publish never`: Windows x64 and arm64 NSIS packages built with Electron 45.2.1.
- Packages are unsigned because no code-signing certificate was configured.
- GitHub Release `v0.2.1` completed successfully with nine assets: Windows x64/arm64/universal, macOS x64/arm64 DMG, and Linux x64/arm64 AppImage/deb.
- macOS and Linux packages were produced by their native GitHub Actions runners; they were not executed on the Windows development host.
- Final local test artifacts are in `release-local/` with checksums in `release-local/SHA256SUMS.txt`:
  - `Web Codex-0.3.0-Windows-x64.exe` (SHA-256 `ab11ca5d225e74637c2f6657bd0871286f61995c979d5ed802e60761cf997ca4`).
  - `Web Codex-0.3.0-Windows-arm64.exe` (SHA-256 `ea4c076a5a10ab97d5a15c9d00d69a0719b7e90a773e03eb93aa37a4991fc657`).
  - `Web Codex-0.3.0-Windows.exe` combined installer (SHA-256 `d3177b988541ff0a479d3d7f58f87dfc11827dc6ae4363e505668942e8d17b22`).
- These are unsigned local test packages, not published releases. They contain the final 0.3.0 source and the QA regression fixes listed above.

### External validation boundary

The bundled Tunnel reached `/readyz = 200 ready` with real credentials on the installed Windows application. Persisted interactive JSONL evidence records successful ChatGPT `project_list` at `2026-10-31T15:18:43Z` and remote `file_write` at `2026-10-31T15:31:39Z`, both with `requestId=0` and HTTP 200. The independent official local protocol chain also completed `project_list`. Interactive automation is still not part of CI; the interactive acceptance evidence is persisted runtime audit data rather than a browser-automation test.