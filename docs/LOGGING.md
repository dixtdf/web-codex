# JSONL audit logging

## Purpose

Web Codex writes structured connection and operation logs for troubleshooting and AI-assisted audit. They record what the remote MCP client requested, what the local application actually did, how long it took, and whether it failed.

Audit logs are an accountability feature, not a sandbox or tamper-proof security boundary.

## Location and retention

Use **任务与日志 → 审计日志 → 打开目录** to locate the log directory. Files are stored below the application's Electron `userData` directory:

```text
logs/audit-YYYY-MM-DD.jsonl
logs/audit-YYYY-MM-DD-0001.jsonl
```

- One complete JSON object per line, UTF-8.
- Rotate when the current file exceeds 10 MB.
- Retain files for 14 days; expired files are removed during initialization.
- Keep up to 1500 recent events in memory and display up to 500 matching events.
- Export concatenates every retained file in chronological file order, not only the recent in-memory subset.
- The log center displays persistence errors and recovery state.

## Event schema

```json
{
  "id": "event-uuid",
  "timestamp": "2026-10-31T12:00:00.000Z",
  "level": "info",
  "category": "shell",
  "action": "shell.closed",
  "message": "Shell command completed",
  "origin": "remote",
  "status": "success",
  "requestId": "json-rpc-request-id",
  "projectId": "project-uuid",
  "taskId": "shell-task-uuid",
  "durationMs": 125,
  "data": {
    "command": "npm test",
    "exitCode": 0
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique event ID. |
| `timestamp` | ISO 8601 UTC time. |
| `level` | `debug`, `info`, `warn`, or `error`. |
| `category` | `app`, `gateway`, `tunnel`, `mcp`, `project`, `file`, `shell`, `network`, `config`, or `security`. |
| `action` | Stable machine-readable operation name. |
| `message` | Human-readable, redacted detail. |
| `origin` | `remote` for ChatGPT/MCP requests, `local` for desktop operations, `system` for service/process events. |
| `status` | `started`, `success`, `error`, `info`, or `stopped`. |
| `requestId` | Correlates one remote request with its tool and service events. |
| `projectId` | Project involved in the operation, when available. |
| `taskId` | Shell task involved in the operation, when available. |
| `durationMs` | Operation duration, when available. |
| `data` | Redacted structured arguments or result metadata. |

## What is recorded

- Gateway start, listen address, stop, authentication rejection, HTTP methods, remote requests, responses, tool outcomes, and errors.
- Tunnel credential-presence checks, internal launcher start, PID, stdout, stderr, readiness/error lines, exit code/signal, and stop operations. Tunnel ID is recorded only when operationally necessary; API keys are always redacted.
- Downstream MCP configuration changes, connect/disconnect, transport errors, stdio stderr, tool names, argument keys, outcomes, and durations.
- Shell command text after redaction, shell type, working directory, task ID, timeout, stop, exit status, output byte counts, and truncation state.
- Desktop IPC operation inputs after redaction, success, failure, and duration.
- Configuration section names, privilege state, emergency stop, and proxy changes.

High-frequency configuration/runtime reads and log-center queries are deliberately excluded to avoid feedback loops and unusable noise. Batch MCP requests are audited per entry. Remote tool outcomes are categorized as project, file, shell, MCP, or gateway operations and retain the same `requestId` as the original request.

## Redaction rules

Before an event is emitted or persisted:

- Gateway tokens, configured downstream secrets, Bearer credentials, common API keys, passwords, JWTs, OAuth URL codes, and URL userinfo are replaced with `[REDACTED]`.
- Sensitive object keys, request headers, and environment-variable objects are redacted.
- `content`, `oldText`, and `newText` are replaced by byte length and SHA-256; raw file and patch content is not written.
- Downstream MCP argument values are not persisted; tool name and argument keys are retained.
- Strings are bounded, deeply nested/circular structures are summarized, and buffers become byte/hash summaries.

Shell command text and project paths remain in the audit trail because they are necessary to investigate unsafe or unintended operations. Treat the JSONL files as sensitive local data. Redaction is best-effort for unknown secret formats, so do not place credentials directly in commands when an environment or protected credential mechanism is available.

Shell stdout/stderr remains available in the in-memory task view but is not copied into persistent audit events. Tunnel and downstream MCP connection output is persisted after redaction because it is required for protocol troubleshooting.

## Manual OpenAI Tunnel test

1. Open the **Tunnel** page.
2. Enter the Tunnel ID and API Key. No command or argument fields are exposed.
3. Select **Save and Start** and wait for the local Tunnel status.
4. Open **任务与日志 → 审计日志** and select **Tunnel**.
5. Inspect `tunnel.start`, `tunnel.spawned`, `tunnel.stdout`, `tunnel.stderr`, `tunnel.credentials_missing`, and `tunnel.closed` in time order.
6. In ChatGPT Plugins, choose Tunnel and No Auth, then run a real `project_list`. Search the tool name or `requestId`: `gateway.request`, categorized tool outcomes, Shell/file events, and `gateway.response` should share that ID.
7. Export JSONL after a failure. The export contains all retained logs and is suitable for later AI analysis.

Do not share an exported file publicly without reviewing command text, local paths, public URLs, and any credentials that use an unrecognized format.

## AI audit example

PowerShell can filter a JSONL file without changing it:

```powershell
Get-Content audit-YYYY-MM-DD.jsonl |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.origin -eq 'remote' -and $_.level -eq 'error' } |
  Select-Object timestamp, requestId, action, message
```

For a complete investigation, group events by `requestId`, then inspect `taskId` and `projectId` before reviewing the corresponding command in the UI.