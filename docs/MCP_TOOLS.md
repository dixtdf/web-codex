# MCP tools

The local endpoint is `http://<loopback-host>:<port>/mcp` and requires Bearer authentication. Paths are project-relative unless stated otherwise. Call `project_list`, then `project_context_get` before project work. The current server exposes 58 tools.

Responses normally contain JSON text and `structuredContent.result`. `file_download` also returns an inline MCP resource block. Tool failures return `isError=true` and a machine-readable `structuredContent.error` object with `code`, `message`, and optional `details`, so clients do not need to infer business errors from text alone. Workspace tool input objects are strict: unknown top-level arguments and unknown fields in nested `remoteShell` policies are rejected instead of being silently ignored.

## Projects

### `project_list`

Arguments: none. Returns every registered project with its remote shell policy and live `health` (`accessible`, `status`, and `error`). `enabled` is registration state, not proof that the path is currently accessible.

### `project_context_get`

Arguments: `projectId`. Returns project metadata, instructions, and the selected `AGENTS.md` or `agent.md` filename.

### `project_create`

Arguments: `path`, optional `name`, `enabled` (default `true`), `createDirectory` (default `true`), and `remoteShell` policy. Registers a local folder as a workspace. Registration grants structured file access inside that canonical folder.

### `project_update`

Arguments: `projectId`, optional `name`, `path`, `enabled`, and `remoteShell`. Updates registration metadata; changing the path does not move the old folder.

### `project_remove`

Arguments: `projectId`. Removes only the registration. Files and existing task records remain on disk.

### `project_instructions_update`

Arguments: `projectId`, `content`. Creates `AGENTS.md` or updates an existing `agent.md`.

## Files

### `file_list`

Arguments: `projectId`, optional `path` (default `.`). Returns file, directory, and symlink entries with size and modification time.

### `file_read`

Arguments: `projectId`, `path`, optional `offset` and `maxBytes` (default `200000`, maximum `2000000`). Returns UTF-8 content, `requestedOffset`, `actualOffset`, consumed `bytes`, `nextOffset`, size, truncation state, and SHA-256. The legacy `offset` field remains equal to `actualOffset`. Continue with `nextOffset`; chunks never split a UTF-8 character. Binary files must use `file_read_binary`.

### `file_write`

Arguments: `projectId`, `path`, `content`, optional `expectedSha256`. Atomically replaces UTF-8 content. A matching expected hash prevents overwriting concurrent user changes.

### `file_patch`

Arguments: `projectId`, `path`, `oldText`, `newText`, optional `expectedReplacements` (default `1`), `expectedSha256`, and `dryRun` (default `false`). Returns before/after hashes and whether content changed. Dry run writes nothing.

### `file_search`

Arguments: `projectId`, `query`, optional `path`, `regex`, `caseSensitive`, `maxResults` (default `100`, maximum `1000`), `respectGitignore` (default `true`), `cursor`, `includeGlobs`, and `excludeGlobs`. Glob lists accept up to 100 project-relative POSIX-style patterns each and compose with `.gitignore` and pagination. Dependencies, build outputs, binary files, and files over 1 MB are skipped. Returns `{ matches, nextCursor }`; pass `nextCursor` with unchanged filters until it is `null`.

### `file_mkdir`

Arguments: `projectId`, `path`. Creates a directory and missing parents.

### `file_move`

Arguments: `projectId`, `sourcePath`, `destinationPath`, optional `overwrite` (default `false`), `expectedSourceSha256`, and `expectedDestinationSha256`. Moves an entry inside the project. Existing destinations are rejected by default; regular-file overwrite requires explicit `overwrite=true` and the current destination hash.

### `file_delete`

Arguments: `projectId`, `path`, optional `recursive` (default `false`), `dryRun` (default `false`), and `expectedSha256`. Dry run returns the deletion metadata without moving or removing anything and never creates a trash record. For regular files, an expected hash rejects deletion after concurrent changes. The project root is protected. Actual deletion uses the configured recoverable trash store.

### `file_hash`

Arguments: `projectId`, `path`. Returns path, size, modification time, and SHA-256.

### `file_attributes`

Arguments: `projectId`, `path`. Returns type, size, POSIX mode, uid/gid, read/write/execute flags, and access/modify/change/create timestamps.

### `file_copy`

Arguments: `projectId`, `sourcePath`, `destinationPath`, optional `onConflict` (`fail` default, `overwrite`, or `rename`). Copies a file or directory without deleting the source. Same-path copies are rejected.

### `file_delete_plan`

Arguments: `projectId`, `path`. Returns type, file/directory counts, total bytes, and up to 20 sample paths before deletion.

### `file_backup`

Arguments: `projectId`, `path`. Copies a project entry into the app-owned trash store without changing the source.

### `trash_list`

Arguments: none. Returns recoverable deletion and backup records with `trashId`, original project/path, reason, type, bytes, and time.

### `trash_restore`

Arguments: `trashId`, optional `overwrite` (default `false`). Restores to the original path. Existing destinations require explicit overwrite.

### `file_read_binary`

Arguments: `projectId`, `path`, optional `offset` and `maxBytes` (default `1000000`, maximum `4000000`). Returns Base64, size, `nextOffset`, truncation state, and SHA-256. Continue until `truncated=false`.

### `file_download`

Arguments: `projectId`, `path`, optional `offset` and `maxBytes`. Returns the same chunk metadata plus an inline resource block with MIME type and Base64 blob.

### `file_transfer_status`

Arguments: `projectId`, `path`. Returns size, modification time, SHA-256, and suggested 4 MB chunk count.

### `file_write_binary`

Arguments: `projectId`, `path`, `base64`, optional `offset`, `truncate`, and `expectedSha256`. Chunks are sequential and at most 4 MB. Offset must match the current file size. When `expectedSha256` is supplied, content is verified in a temporary file and atomically renamed; a mismatch preserves the original file. Verify the final hash after the last chunk.

### `file_archive_create`

Arguments: `projectId`, optional `sourcePath` (default `.`) and `destinationPath` (default `web-codex-export.zip`). Creates a ZIP excluding dependency/build directories. Limits: 10000 files and 200 MB uncompressed.

### `file_archive_extract`

Arguments: `projectId`, `archivePath`, optional `destinationPath` (default `.`). Limits: 2000 entries, 50 MB per entry, 200 MB total. Absolute paths, drive paths, `..`, and destination escapes are rejected.

## Attachment inbox

### `upload_list`

Arguments: none. Returns attachment `uploadId`, original filename, size, creation time, and SHA-256.

### `upload_copy`

Arguments: `uploadId`, `projectId`, optional destination directory `destinationPath` (default `./`), and `onConflict` (`fail` default, `overwrite`, `rename`). Copies without Base64 using the original filename.

### `upload_extract`

Arguments: `uploadId`, `projectId`, optional `destinationPath` (default `.`). Safely extracts an uploaded ZIP.

## Shells and processes

### `shell_run`

Arguments: `projectId`, `command`, optional `shell` (`auto`, `cmd`, `powershell`, `bash`, `zsh`), `cwd`, `timeoutMs` (default `120000`, maximum `86400000`), `wait` (default `true`), and `idempotencyKey`. Remote execution is checked against the project policy. Commands have full desktop-user authority and can access outside the project; the working-directory boundary is not a sandbox. Windows cmd commands preserve quoted scripts correctly.

PowerShell 5.1 compatibility: `file_write` creates UTF-8 without BOM, which Windows PowerShell 5.1 may misread with its default file encoding. Use `Get-Content -Raw -Encoding UTF8 -LiteralPath "测试 文件.txt"` for text files. Shell stdout/stderr UTF-8 encoding is configured separately and is not affected by this file-encoding default.

### `process_run`

Arguments: `projectId`, `executable`, optional `args`, `cwd`, `env`, `inheritEnv` (default `true`), `stdin`, `timeoutMs`, `wait`, and `idempotencyKey`. No shell interprets arguments. Remote policy also applies.

### `shell_task_list`

Arguments: optional `projectId`, `status`, `limit` (default `20`, maximum `100`), and `cursor`. Returns metadata only, without output bodies.

### `shell_task_get`

Arguments: `taskId`. Returns status, exit metadata, timestamps, output byte counts, and error state.

### `shell_task_output`

Arguments: `taskId`, optional `stream` (`stdout`/`stderr`), `offset`, and `maxBytes` (default `65536`, maximum `1000000`). Returns complete UTF-8 characters with `requestedOffset`, actual `offset`, `nextOffset`, `totalBytes`, and `eof`. Continue with `nextOffset` until `eof=true`.

### `shell_task_input`

Arguments: `taskId`, `data`, optional `appendNewline` (default `true`). Writes to pipe stdin for a running task. This is not a full PTY/TUI emulator.

### `shell_task_close_input`

Arguments: `taskId`. Closes stdin so a process waiting for EOF can continue.

### `shell_task_stop`

Arguments: `taskId`. Stops a running command and its process tree.

## Git

### `git_status`

Arguments: `projectId`. Returns branch, upstream, ahead/behind, clean state, changed paths, and porcelain output.

### `git_diff`

Arguments: `projectId`, optional `staged`, `base`, and `path`. Base revisions and paths are validated; output is bounded to 2 MB.

### `git_log`

Arguments: `projectId`, optional `limit` (default `20`, maximum `100`). Returns hash, short hash, author, ISO date, and subject.

### `git_branch_list`

Arguments: `projectId`. Lists local and remote branches with abbreviated commit and current marker.

### `git_worktree_list`

Arguments: `projectId`. Lists worktree paths, HEAD commits, branches, bare markers, and prunable markers without modifying worktrees.

### `git_worktree_add`

Arguments: `projectId`, `path` below `.worktrees/`, `branch`, optional `base` (default `HEAD`). Creates a new-branch worktree inside the registered project. Branch, base revision, destination existence, and project boundary are validated.

### `git_worktree_remove`

Arguments: `projectId`, `path`, optional `force` (default `false`). Removes only a registered worktree below `.worktrees/`; the main worktree and unregistered paths are protected.

### `git_conflict_list`

Arguments: `projectId`. Returns unmerged project-relative paths from the current Git index.

### `git_resolve_conflicts`

Arguments: `projectId`, `paths` (1–200), `strategy` (`ours` or `theirs`). Every path must currently be unmerged. Applies the explicit strategy and stages only those paths; no implicit strategy or force option exists.

### `git_stage`

Arguments: `projectId`, `paths` (1–200). Stages only validated project-relative paths.

### `git_commit`

Arguments: `projectId`, `message` (maximum 4000), optional `paths` (maximum 200). Explicit paths are staged first. It does not amend, push, or bypass hooks.

## Diagnostics

### `host_capabilities`

Arguments: optional `projectId`. Returns OS, CPU/memory/disk, Node/Electron runtimes, detected tools, safe environment fields, proxy state, project permissions, and truthful execution boundaries.

### `connection_health`

Arguments: none. Returns Gateway uptime, protocol versions, Bearer authentication mode, service readiness, and `sandboxed:false`.

## Downstream MCP tools

### `mcp_server_list`

Arguments: none. Returns configured downstream connection states.

### `mcp_tool_list`

Arguments: none. Returns discovered tools namespaced as `alias__tool`, with source server and input schema.

### `mcp_tool_call`

Arguments: `name`, optional `arguments` object. Calls a namespaced tool and preserves its MCP result.

### `mcp_resource_list`

Arguments: optional `serverId`. Returns resource URI, name, description, MIME type, size, and source server.

### `mcp_resource_read`

Arguments: `serverId`, `uri`. Reads one downstream resource. Responses over 4 MB are rejected; resource bodies are not copied into audit logs.

### `mcp_prompt_list`

Arguments: optional `serverId`. Returns prompt names, descriptions, argument metadata, and source server.

### `mcp_prompt_get`

Arguments: `serverId`, `name`, optional string `arguments` object. Returns the downstream prompt messages. Responses over 4 MB are rejected; only argument keys are audited.