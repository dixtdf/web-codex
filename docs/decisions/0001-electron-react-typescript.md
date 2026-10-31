# ADR 0001: Electron, React, and TypeScript

- Status: Accepted
- Date: 2026-10-31

## Context

Web Codex needs a cross-platform desktop shell, native directory/process integration, a typed MCP boundary, and a responsive local management interface. Windows, macOS, and Linux must retain their native shell behavior.

## Decision

Use Electron for desktop/process integration, React for the renderer, and strict TypeScript throughout main, preload, shared contracts, core services, and renderer code. Use the official MCP SDK for protocol transports.

## Consequences

Electron main and preload remain separate from the renderer, with context isolation and a typed bridge. Node services are testable without a logged-in ChatGPT account. Packaging must cover all three desktop operating systems. Changing this stack requires a new user-approved ADR rather than rewriting this record.