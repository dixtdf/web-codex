# Testing

## Commands

Use Node.js 22.16 or newer.

```bash
npm run lint
npm run typecheck
npm test
npx vitest run --coverage
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

`npm run test:tunnel` starts an isolated real Web Codex Runtime and the official `openai/tunnel-client` `dev proxy`. It verifies modern `server/discover`, initialize, discovery of 58 tools, and actual `project_list` and `upload_copy` calls with byte-identical attachment content through the official local control plane; it does not invoke every tool individually. No hosted OpenAI account is required and no secret values are included in the report at `artifacts/official-tunnel-report.json`.

## Coverage

The suite uses Vitest with V8 coverage. Core service tests target more than 90% line coverage and at least 80% branch coverage. The current verified baseline is 170 tests total (151 core/service + 19 MCP E2E), with 92.75% line, 81.25% branch, and 89.33% function coverage. Assertions validate returned content, error codes, process state, filesystem effects, MCP structured results, and mock command arguments rather than only checking object existence.

## Local fixtures

- Project and file tests create isolated temporary workspaces.
- Binary and attachment tests use real STEP/STL/KiCad-like binary fixtures, chunked offsets, SHA-256, ZIP round trips, raw Zip Slip archives, and attachment copy/extract/remove flows.
- Desktop QA regressions explicitly cover `中文🙂 café Ω` pagination at 1/2/3-byte chunks, the original `offset=5,maxBytes=9` case, move-overwrite rejection and hash-confirmed overwrite, CMD/PowerShell Unicode output, `.gitignore` filtering, and structured error codes.
- Shell tests execute short real commands and terminate long-running process trees.
- Remote command policy tests cover default migration, deny, allowlist boundaries, control-syntax bypass attempts, gateway enforcement, and unaffected local tasks.
- Gateway tests make real HTTP requests for initialize, tools/list, tools/call, health, CORS, and authentication rejection.
- JSONL audit tests verify parsing, credential/content redaction, chronological rotation, reload, retention, export, persistence recovery, and remote request/task correlation.
- Secret-storage tests cover encrypted persistence, legacy plaintext migration, restart decryption, wrong-user failures, and memory-only behavior without plaintext fallback. Real Electron smoke verifies asynchronous `safeStorage` with isolated dummy credentials.
- MCP Hub tests use both a real stdio SDK server and a real Streamable HTTP SDK server, including tools, resources, prompts, namespacing, disconnect, and recursive-connection rejection.
- Git tests use a real temporary repository for empty-repository status, staging, diff, commit, history, branches, path/ref validation, and unavailable-Git handling.
- Host tests verify bounded OS/resource/tool/project/proxy diagnostics and that environment output is allowlisted.
- Advanced file tests cover version conflicts, dry-run patches, file/directory copies, deletion plans, dry-run/hash-checked deletion, backup, trash listing, restore conflicts, recovery, and cursor-paginated search.
- Advanced shell tests cover structured processes, stdin interaction, idempotency, paginated metadata, UTF-8-safe incremental output, state flushing, and interrupted-task recovery.
- Runtime tests verify redacted diagnostic reports exclude credentials, environment values, and task output bodies.
- Desktop smoke verifies the attachment inbox upload/removal, JSONL log center, and redacted diagnostics through the real typed IPC bridge.
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