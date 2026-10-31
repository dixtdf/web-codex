# ADR 0002: OS-protected secret storage

- Status: Accepted
- Date: 2026-10-31

## Context

Gateway tokens, the Tunnel runtime key, and downstream MCP headers/environment values were persisted as plaintext JSON. File permissions alone do not protect these values from offline reads by the same user or from accidental disclosure in support archives.

## Decision

Use Electron `safeStorage` through a small `SecretProtector` port. `ConfigStore` keeps plaintext only in process memory for authorized services and writes versioned encrypted values to disk. Windows uses DPAPI; macOS and Linux use the system facilities exposed by Electron. Existing plaintext values are migrated during configuration load.

If OS encryption is unavailable, the application uses memory-only secrets and writes empty secret fields instead of falling back to plaintext. Protected values that cannot be decrypted fail explicitly rather than being replaced or silently regenerated.

## Consequences

Configuration remains a single JSON file for non-secret settings. Backups cannot be moved to another OS user with the expectation that protected fields will decrypt. Users on memory-only systems must re-enter credentials after restart. Tests use a deterministic fake protector; live Electron verification checks encrypted disk format and restart decryption.