# Testing

## Commands

Use Node.js 22.16 or newer.

```bash
npm run lint
npm run typecheck
npm test
npm test -- --coverage
npm run test:e2e
npm run test:tunnel
npm run test:ui
npm run build
```

`npm test` runs unit and local integration tests. `npm run test:e2e` exercises the real loopback MCP HTTP transport; it does not require a ChatGPT login. Coverage reports are written to `coverage/` and currently include `src/core`.

## Desktop smoke verification

`scripts/ui-smoke.mjs` connects to a real Electron production window through Chrome DevTools Protocol. It visits all six views, checks horizontal overflow and runtime errors, switches themes, opens primary dialogs, and verifies project and Agent-instruction IPC with a temporary workspace. Screenshots and a JSON report are written to `artifacts/`.

Build and start Electron with `--remote-debugging-port=9222`, then run `npm run test:ui`. The script does not require a ChatGPT account or include connection credentials in its report.

## Official Tunnel integration verification

`npm run test:tunnel` starts an isolated real Web Codex Runtime and the official `openai/tunnel-client` `dev proxy`. It verifies external initialize, discovery of all 17 workspace tools, and `project_list` through the official local control plane. No hosted OpenAI account is required and no secret values are included in the report at `artifacts/official-tunnel-report.json`.

## Coverage

The suite uses Vitest with V8 coverage. Core service tests target more than 90% line coverage and at least 80% branch coverage. Assertions validate returned content, error codes, process state, filesystem effects, MCP structured results, and mock command arguments rather than only checking object existence.

## Local fixtures

- Project and file tests create isolated temporary workspaces.
- Shell tests execute short real commands and terminate long-running process trees.
- Remote command policy tests cover default migration, deny, allowlist boundaries, control-syntax bypass attempts, gateway enforcement, and unaffected local tasks.
- Gateway tests make real HTTP requests for initialize, tools/list, tools/call, health, CORS, and authentication rejection.
- JSONL audit tests verify parsing, credential/content redaction, chronological rotation, reload, retention, export, persistence recovery, and remote request/task correlation.
- Secret-storage tests cover encrypted persistence, legacy plaintext migration, restart decryption, wrong-user failures, and memory-only behavior without plaintext fallback. Real Electron smoke verifies asynchronous `safeStorage` with isolated dummy credentials.
- MCP Hub tests use both a real stdio SDK server and a real Streamable HTTP SDK server.
- Proxy tests mock operating-system detection commands and use a loopback HTTP server for fetch behavior.
- Tunnel tests use child Node processes; they do not invoke an actual OpenAI account session.

Run a single test by name:

```bash
npm test -- -t TestName
```

Run one file:

```bash
npx vitest run tests/core/file-service.test.ts
```

## External validation boundary

The official local protocol chain is covered by `npm run test:tunnel`. A real ChatGPT interactive Connector check additionally needs an authorized account and valid runtime key. Record observed local readiness and interactive checks separately in `docs/TUNNEL.md`; never replace unavailable interactive validation with a simulated success claim.