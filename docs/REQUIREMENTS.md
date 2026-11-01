# Product requirements

## Mission

Web Codex provides Web ChatGPT with a Codex-grade local workspace while remaining understandable on first launch. The implementation is original, uses public MCP specifications and the official MCP SDK, and does not vendor code from product-reference repositories.

## Current release scope

1. **Desktop runtime**: Electron lifecycle, single-instance behavior, native project directory selection, external-link restrictions, and typed IPC.
2. **Projects**: register, update, enable/disable, remove, open locally, and read or save `AGENTS.md`/`agent.md` context.
3. **Files**: list, bounded read, UTF-8 write, exact patch, recursive search, directory creation, move, delete, chunked binary transfer, safe ZIP create/extract, and native attachment inbox inside canonical project roots.
4. **Shells and processes**: cmd, PowerShell, bash, and zsh where supported; structured executables, foreground/background execution, paginated output, pipe stdin, idempotency, persistence/recovery, timeout, process-tree termination, and per-project remote policies.
5. **Local Gateway**: stateless Streamable HTTP MCP initialize, modern discovery, calls, resources, prompts, health checks, Bearer authentication, and loopback-only listening.
6. **MCP Hub**: stdio and Streamable HTTP discovery and forwarding for tools, resources, and prompts with `alias__tool` names and preserved structured results.
7. **Git and host diagnostics**: status, diff, history, branches, explicit staging/commit, host capabilities, connection health, and redacted report export.
8. **Network**: automatic environment/system detection, manual and direct modes, NO_PROXY rules, runtime refresh, and mandatory loopback bypass.
9. **Tunnel**: dedicated page accepting only Tunnel ID and API Key, client/subcommand preflight, Windows-compatible launch, explicit connection phases, readiness timeout, ChatGPT No Auth guidance, and termination.
10. **User interface**: Home, Projects, Tunnel, MCP Connections, Activity, and Settings; visible service state, emergency stop, and a branded system tray with left-click panel toggle and right-click actions.
11. **Release engineering**: TypeScript checks, ESLint, unit/integration tests, real HTTP MCP tests, cross-platform CI, and host packaging.

## Acceptance boundary

All local acceptance commands must pass without ChatGPT credentials. A real ChatGPT Connector and OpenAI Tunnel session additionally requires the user's supported CLI, account, and authorization. Unverified live behavior must be recorded in `docs/TUNNEL.md`, never reported as successful by assumption.

## Out of scope for local tests

- Bypassing operating-system authentication or weakening platform security.
- Exposing the local MCP listener on non-loopback interfaces.
- Logging Bearer tokens, authorization headers, MCP secrets, or sensitive environment variables.
- Claiming compatibility with an OpenAI CLI or account flow that has not been exercised live.