# Validation record

## 2026-10-31 local release verification

### Static and dependency checks

- `npm run lint`: passed, including `src`, `tests`, and `scripts`.
- `npm run typecheck`: passed with TypeScript strict mode.
- `npm audit --omit=dev`: passed with 0 production dependency vulnerabilities.
- Electron upgraded to 45.2.1, Vitest to 5.0.5, and Zod to 4.6.7; the full suite passed after the upgrades.

### Automated service and protocol tests

- `npm test`: 13 test files, 103 tests passed.
- `npm run test:e2e`: 12 real MCP HTTP end-to-end tests passed, including JSONL remote-operation auditing, secret redaction, and remote command policy checks.
- `npm run test:tunnel`: the real Runtime and official `openai/tunnel-client 0.0.19` local control plane completed initialize, discovery of 17 tools, and `project_list`; evidence is in `artifacts/official-tunnel-report.json`.
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
- Light/dark/system theme controls update the actual document state.
- Project and MCP creation dialogs open and close; the project remote-command policy field renders.
- A temporary project was created and removed through the real typed IPC bridge.
- AGENTS.md content was saved, read back, and displayed in the instruction editor.
- The JSONL log center loaded persisted events and expanded structured event details without runtime errors.

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
- macOS and Linux package jobs are configured in GitHub Actions but were not executed on the Windows development host.

### External validation boundary

The bundled Tunnel reached `/readyz = 200 ready` with real credentials on the installed Windows application, and the independent official local protocol chain completed `project_list`. An interactive ChatGPT page has not been automated for the final project-list call, so no interactive-page success is claimed. Keep the local readiness and interactive acceptance results separate.