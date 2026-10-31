# MCP tools

The local endpoint is `http://<loopback-host>:<port>/mcp` and requires Bearer authentication. Paths are project-relative unless stated otherwise. Call `project_list` and then `project_context_get` before project work. Responses contain JSON text and `structuredContent.result`.

## Projects

### `project_list`

Arguments: none. Returns all registered projects, including each project's `remoteShell` policy mode and allowed command prefixes.

### `project_context_get`

Arguments: `projectId: string`. Returns project metadata, its remote shell policy, instructions, and the selected `AGENTS.md` or `agent.md` filename.

## Files

### `file_list`

Arguments: `projectId`, optional `path` (default `.`). Returns file/directory/symlink entries with size and modification time.

### `file_read`

Arguments: `projectId`, `path`, optional `offset` (default `0`) and `maxBytes` (default `200000`, maximum `2000000`). Returns UTF-8 content, total size, and truncation state. Binary files are rejected.

### `file_write`

Arguments: `projectId`, `path`, `content`. Creates missing parent directories and replaces the UTF-8 file. Returns normalized path and byte count.

### `file_patch`

Arguments: `projectId`, `path`, `oldText`, `newText`, optional `expectedReplacements` (default `1`). Replaces exact text only when the occurrence count matches.

### `file_search`

Arguments: `projectId`, `query`, optional `path`, `regex`, `caseSensitive`, and `maxResults` (default `100`, maximum `1000`). Returns path, line, column, and preview. Dependencies, build outputs, binary files, and files over 1 MB are skipped.

### `file_mkdir`

Arguments: `projectId`, `path`. Creates a directory and missing parents.

### `file_move`

Arguments: `projectId`, `sourcePath`, `destinationPath`. Moves an entry inside the same project.

### `file_delete`

Arguments: `projectId`, `path`, optional `recursive` (default `false`). Deletes an entry; the project root cannot be deleted.

## Shells

### `shell_run`

Arguments: `projectId`, `command`, optional `shell` (`auto`, `cmd`, `powershell`, `bash`, `zsh`), `cwd`, `timeoutMs` (default `120000`, maximum `86400000`), and `wait` (default `true`). Returns a task with status, exit metadata, stdout, stderr, and truncation state. Use `wait=false` for long-running commands. Remote calls are rejected when the project policy is `deny`, when an `allowlist` does not match, or when an allowlisted command contains shell control syntax.

### `shell_task_list`

Arguments: none. Returns running and completed tasks.

### `shell_task_get`

Arguments: `taskId`. Returns current task state and retained output.

### `shell_task_stop`

Arguments: `taskId`. Stops a running command and its process tree.

## Downstream MCP

### `mcp_server_list`

Arguments: none. Returns configured downstream connection states.

### `mcp_tool_list`

Arguments: none. Returns discovered tools namespaced as `alias__tool`, including source server and input schema.

### `mcp_tool_call`

Arguments: `name` and optional `arguments` object (default `{}`). Calls a namespaced downstream tool and preserves its MCP result inside the gateway result.