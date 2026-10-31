# ADR 0001: Independent single-machine Electron architecture

- Status: accepted
- Date: 2026-10-31

## Context

The product should give Web ChatGPT a powerful local workspace without the setup and conceptual overhead of a multi-machine Server/Runner product. The user accepts the reference project's idea but explicitly prohibits reuse of its code. MCP server and client capabilities, process management, proxy handling, and desktop integration need one coherent implementation.

## Decision

Build an original Electron + React + TypeScript application. Compose all local capabilities in a Node.js main-process runtime and expose them through a typed preload bridge. Use the official MCP TypeScript SDK for both the local gateway and downstream clients. Keep OpenAI Tunnel as a managed external process adapter.

Do not fork, copy, adapt, vendor, or import code from `yyjeqhc/webcodex`. Only public protocol concepts and independent implementation are permitted.

## Consequences

- One language covers MCP, shell, IPC, and UI integration, reducing protocol and packaging complexity.
- Users do not deploy a separate central server or Runner.
- Electron increases installer size and baseline memory use compared with a native-shell alternative.
- Tunnel credentials are isolated to a dedicated user-facing page while its launcher and local routing remain internal compatibility code.
- Local protocol and service tests can run without ChatGPT credentials, while live Connector validation remains an explicit external check.