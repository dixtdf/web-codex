# AGENTS.md

## Project mission

Web Codex is an independent, cross-platform desktop MCP application. It gives Web ChatGPT a Codex-grade local workspace through a local MCP Gateway and OpenAI Tunnel. The product must feel understandable on first launch while exposing powerful project, file, shell, task, and downstream MCP capabilities.

## Non-negotiable constraints

- Do not fork, copy, adapt, vendor, or import code from `yyjeqhc/webcodex`. That project is a product idea reference only.
- Use public MCP specifications, the official MCP SDK, and original implementation in this repository.
- Keep the Electron + React + TypeScript stack unless an ADR explicitly records a user-approved change.
- Support Windows, macOS, and Linux. Preserve cmd, PowerShell, and native shell behavior.
- The local MCP listener must remain loopback-only and Bearer-token authenticated.
- Do not log access tokens, authorization headers, MCP secrets, or sensitive environment variables.
- The user allows full-access and administrator operation. Never bypass operating-system authentication or silently weaken platform security.
- After every development task, complete the required validation, commit all completed changes with a clear Git message, build a local Windows package with `npm run dist:win` (publishing is disabled by configuration), and push to `origin`. A normal push runs only the CI matrix. To trigger the GitHub release matrix, bump the version in `package.json` and push a matching `v*` tag, which `release.yml` packages and publishes the three-platform packages for.
- Keep user-facing documentation in English and Simplified Chinese.

## Read before changing behavior

1. `docs/REQUIREMENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/SECURITY.md`
4. `docs/TESTING.md`
5. `docs/LOGGING.md`
6. Relevant ADRs under `docs/decisions/`

## Commands

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run test:tunnel
npm run test:ui
npm run build
npm run dist
```

Use Node.js 22.16 or newer. `npm run dist` creates packages for the current host; GitHub Actions builds the release matrix.

## Source layout

- `src/main`: Electron lifecycle, window management, native dialogs, privileged status, and IPC registration.
- `src/preload`: narrow, typed bridge between Electron and React.
- `src/core`: config, projects, files, shells, MCP Gateway, downstream MCP hub, proxy detection, and Tunnel process management.
- `src/shared`: types shared by main, preload, and renderer.
- `src/renderer`: React pages, visual components, and styles.
- `tests`: unit and integration tests that run without a logged-in ChatGPT account.
- `docs`: product, architecture, security, protocol, development, testing, and decision records.

## Development rules

- Preserve existing naming and formatting conventions. Production code intentionally avoids unnecessary comments.
- Do not expose raw `ipcRenderer` to the renderer. Add typed methods to `src/shared/api.ts`, implement them in preload, and register them in main.
- Keep project file tools inside canonical project roots. Check symlinks and parent directories for write operations.
- Treat shell execution as full user-authority execution, not as a sandbox.
- Keep long-running commands observable through `ShellService` and the activity UI.
- Namespace downstream tools as `alias__tool` and preserve structured MCP results.
- Resolve proxy configuration dynamically. Never proxy loopback traffic.
- Update `docs/MCP_TOOLS.md` whenever tool names, arguments, or results change.
- Preserve JSONL audit coverage for new remote tools, local operations, connection state changes, and failures. Never log raw secrets or file content; update `docs/LOGGING.md` when the schema or redaction changes.
- Add or update tests for behavior changes. Never delete or loosen existing tests to hide a regression.
- Update both README files when setup or supported behavior changes.
- Record significant architectural choices in a new ADR instead of rewriting history.

## Definition of done for the current release

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`, and `npm run build` exit successfully; the real Electron UI smoke check passes with a report in `artifacts/ui-smoke-report.json`.
2. Project registration, native directory selection, project listing, file read/write/patch/search, and AGENTS/agent.md context are covered by tests.
3. cmd, PowerShell, native shell, background tasks, output retrieval, and termination have appropriate platform-aware tests.
4. stdio and Streamable HTTP downstream MCP discovery and forwarding have integration coverage.
5. Local MCP initialize, tools/list, tools/call, authentication rejection, and health checks pass through real HTTP requests.
6. Proxy precedence, NO_PROXY, and runtime refresh behavior are covered without depending on a user's actual proxy.
7. Home, Projects, Tunnel, MCP Connections, Activity, and Settings remain buildable and their primary workflows, plus system tray panel/actions, are documented or tested.
8. Windows, macOS, and Linux GitHub Actions workflows and release packaging configuration are present.
9. Any unverified account-dependent OpenAI Tunnel behavior is explicitly listed in `docs/TUNNEL.md`; never claim live ChatGPT validation without evidence.

## Current external validation boundary

A real ChatGPT Connector session requires OpenAI and ChatGPT authorization. Release packages bundle the checksum-verified official Tunnel client. The product UI accepts only Tunnel ID and API Key; executable and arguments remain internal and must not reappear as user settings. Local development and protocol tests continue without credentials. `npm run test:tunnel` verifies the real Runtime through the official local control plane, while interactive ChatGPT checks are recorded separately instead of being inferred from local readiness.