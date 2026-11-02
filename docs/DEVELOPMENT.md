# Development guide

## Prerequisites

- Node.js 22.16 or newer.
- npm 10 or newer.
- Platform tools required by Electron and electron-builder.
- An OpenAI Tunnel-compatible CLI and ChatGPT authorization only for live external validation.

## Setup

```bash
git clone https://github.com/dixtdf/web-codex.git
cd web-codex
npm install
npm run dev
```

The development command builds and starts Electron with renderer hot reload. The application creates its configuration in Electron's `userData` directory, not in the source repository.

## Useful commands

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript without emitting files
npm test            # unit and integration tests
npm run test:e2e    # real HTTP/MCP end-to-end tests
npm run build       # production main, preload, and renderer bundles
npm run dist        # current-host installer packages
```

Run lint, typecheck, tests, end-to-end tests, and build before reporting a development task as complete.

## Implementation workflow

1. Read `AGENTS.md` and the relevant documentation.
2. Make focused changes using the existing service boundaries.
3. Update the typed API, preload, and main IPC together for renderer operations.
4. Update `docs/MCP_TOOLS.md` for protocol changes.
5. Add behavior-focused tests without relying on a real ChatGPT account.
6. Run verification and record external blockers rather than inventing validation.
7. Update both README files when setup or supported behavior changes.

## UI development

Pages live under `src/renderer/pages`; shared controls live under `src/renderer/components`. Preserve the current design tokens and responsive layout in `styles.css`. New workflows should have clear empty, loading, success, and failure states.

Common actions belong on the primary surface. Advanced transport, proxy, and Tunnel configuration should remain progressive rather than blocking first-launch onboarding.

## Cross-platform rules

Do not assume the current Windows development host is the only target. Keep path handling in `node:path`, avoid hard-coded separators, and use shell capabilities conditionally. Shell tests must select supported commands per platform.

Windows packaging requests administrator privileges. macOS and Linux currently use the actual process user's privileges and report that status honestly.

## Documentation and decisions

Use `docs/decisions/` for architectural decisions that affect future implementation. Do not rewrite an accepted ADR to hide a change in direction; add a superseding ADR instead.

## Git policy

Commit and push after every completed development task (`AGENTS.md` authorizes this). Do not commit secrets, local configuration, release artifacts, or `node_modules`. A normal push runs only the CI matrix. To trigger the GitHub release matrix, bump the version in `package.json` and push a matching `v*` tag (`release.yml` packages and publishes the three-platform packages from tags).