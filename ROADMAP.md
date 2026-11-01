# Roadmap

## Completed

- Independent Electron desktop runtime with six core views and system tray.
- Project, file, binary/archive, attachment, shell, structured process, task, host diagnostics, downstream MCP Resources/Prompts, proxy, and local Git workflow capabilities including worktrees and conflict resolution.
- Per-project remote shell policies with full-access default.
- OS-backed encrypted secret storage and rotating JSONL audit logs.
- Official OpenAI Tunnel client, no-auth profile, health readiness, and redacted diagnostic export.
- Windows, macOS, and Linux release workflows.
- Local and official-control-plane protocol tests.
- User-observed interactive ChatGPT Desktop connection and remote text-file write.

## Remaining

- Add browser-automated interactive ChatGPT acceptance to CI; persisted evidence already records successful `project_list` and remote `file_write`.
- Add signed and notarized release artifacts when Windows, macOS, and Linux certificates are available. Current packages are unsigned.
- Add full PTY-backed interactive terminal sessions for TUIs and REPLs. Pipe stdin, output pagination, idempotency, persistence, and concurrency limits are implemented, but a full terminal emulator is not.
- Add a privileged helper for macOS and Linux instead of elevating the desktop UI process.
- Add automatic updates. Redacted diagnostic export is implemented; automatic delivery/installation is not.
- Add direct chat-attachment ingestion when the host exposes an attachment API; the native attachment inbox is the current bridge.
- Add OS-level sandbox/quota enforcement, GUI automation, multi-host/SSH/WSL/Docker, multi-step orchestration, event notifications, and per-operation approval UI. These remain unimplemented in `docs/GAPS.md`.

Roadmap entries distinguish implemented behavior from blocked or future work. They are not claims that blocked items are complete.