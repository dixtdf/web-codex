# Security model

## Local Gateway

The Gateway accepts only `127.0.0.1`, `localhost`, or `::1` as its listen host. `/mcp` requires `Authorization: Bearer <token>`; token comparison hashes both values and uses a timing-safe comparison. `/healthz` exposes only service name and health status. The no-auth Tunnel profile does not advertise OAuth authorization-server metadata; the Tunnel client supplies static Gateway Bearer headers and must not bypass Gateway authentication. Do not expose the raw local port through another proxy without preserving authentication.

## Project file boundary

Projects are canonicalized with `realpath`. File operations resolve paths relative to the canonical root, reject traversal, and verify symlink targets. Write operations additionally verify canonical parent directories. Moving or deleting the project root is rejected. Search skips common dependency/build directories, binary extensions, NUL-containing files, and files larger than 1 MB.

These checks are boundary controls, not a sandbox. A caller with project tool access can intentionally modify or delete content inside an enabled project.

## Shell authority

Shell commands execute with the full authority of the desktop user. They are not sandboxed. Working directories must remain inside an enabled project, but commands themselves can perform any operation available to that user. Timeouts and stop actions target the process tree. Emergency stop terminates tracked shells, the Gateway, and Tunnel.

Each project has an optional remote shell policy. `allow` preserves full access and is the default, `deny` rejects every remote `shell_run`, and `allowlist` permits only normalized command-prefix matches. Allowlist mode rejects newlines, command separators, pipes, redirection, command substitution, grouping, and common Windows variable/escape expansion before matching. These controls apply only to the MCP Gateway; local Activity-page tasks and non-shell downstream MCP tools retain their configured authority. An allowed command prefix is trusted authority, not a sandbox: allowed interpreters and scripts can still execute code they are designed to run.

## Secrets and logs

Configuration contains the Gateway token, the OpenAI Tunnel API key, and may contain downstream headers or environment values. Electron asynchronous `safeStorage` encrypts all these fields with the current OS user's key before persistence; plaintext exists only in process memory for authorized services. Legacy plaintext is migrated during configuration load, and decryption failures stop startup instead of silently replacing credentials. If OS encryption is unavailable, secret fields are persisted empty and credentials must be re-entered after restart—plaintext fallback is forbidden. Configuration files are written with owner-only permissions where the platform supports POSIX modes. Renderer configuration and runtime snapshots replace the Tunnel API key with a configured marker; the key is write-only and is preserved when the credential field is left blank. Do not log access tokens, authorization headers, MCP secrets, or sensitive environment variables. Tests use dummy credentials only.

Remote MCP requests and local activity are persisted as `audit-YYYY-MM-DD[-NNNN].jsonl` under `logs/` in Electron's user-data directory. Each line is an independent JSON event with time, level, category, action, origin, status, and optional request/task/project correlation. Files rotate at 10 MB and are retained for 14 days. The Activity page provides filtering and JSONL export.

The logger replaces configured secrets, Bearer values, common token/password/API-key forms, and URL credentials. File content and patch text are replaced by byte count and SHA-256 summary; headers and environment objects are omitted; arbitrary downstream MCP argument values are omitted and only argument keys are retained. Batch requests are redacted per entry. Commands, project paths, and error messages may still be sensitive after best-effort redaction, so protect log directories and exported files as audit data.

Audit logging provides traceability, not a sandbox or a guarantee that every possible secret format is recognized. Review remote commands and use emergency stop when necessary. The Tunnel page accepts only the Tunnel ID and a masked API key. The Tunnel client receives the local Gateway credential internally, while ChatGPT uses Tunnel + No Auth and never receives that credential. Treat copied Tunnel IDs, exported logs, and local configuration as sensitive connection material.

## Downstream MCP and proxying

Downstream tools run with their configured local process or remote service authority. Recursive self-connections are rejected and aliases prevent tool-name collisions. Loopback traffic always bypasses proxies. Auto mode prefers environment proxy configuration, then system detection; manual and direct modes are explicit.

## Platform privileges

Web Codex does not bypass operating-system authentication. Windows packaging requests administrator execution as configured, and the UI reports detected privilege state. Review project registrations, downstream commands, and shell activity before granting access through ChatGPT.