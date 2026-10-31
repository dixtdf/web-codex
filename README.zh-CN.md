# Web Codex

[English](README.md)

Web Codex 是一个独立的跨平台 Electron 本地工作区，通过经过身份认证的 MCP Gateway 和 OpenAI Tunnel，让 Web ChatGPT 操作本地项目。项目代码不会上传到单独的后端；应用提供项目登记、受限文件工具、原生 Shell 任务和下游 MCP 聚合能力。

## 功能

- 登记本地文件夹，维护 `AGENTS.md` 或 `agent.md` 项目指令。
- 在规范化项目根目录内读取、写入、补丁、搜索、移动和删除文件。
- 运行 cmd、PowerShell、bash 或 zsh 命令，支持实时任务状态、输出上限、超时和进程树终止。
- 支持可选的每项目远程命令策略（全部允许、前缀白名单或禁止），同时保留本机任务的完整访问能力。
- 使用轮转 JSONL 日志审计本机与远程操作，支持请求/任务关联、筛选、导出及凭证和文件内容脱敏。
- 通过 Electron 异步 `safeStorage` 加密 Gateway、Tunnel 和下游 MCP 密钥，系统加密不可用时绝不明文落盘。
- 提供仅监听回环地址、使用 Bearer Token 认证的 Streamable HTTP MCP 端点。
- 聚合 stdio 与 Streamable HTTP MCP 服务，工具统一命名为 `alias__tool`。
- 自动检测环境或系统代理，支持手动/直连模式，并始终绕过回环请求。
- OpenAI Secure Tunnel 只需填写 Tunnel ID 和只写 API Key，安装包内置经过 SHA-256 校验的官方 `openai/tunnel-client`，所有启动细节均由程序管理。
- 通过首页、项目、Tunnel、MCP 连接、任务活动和设置页面管理本地运行时。
- 品牌系统托盘常驻：左键切换应用面板，右键提供运行时快捷操作。

## 环境要求

- Node.js 22.16 或更高版本
- npm
- 仅在真实 Connector 使用时需要已授权 ChatGPT 账号及有效 Tunnel ID/API Key；发布包已内置官方客户端

本地开发、协议测试与打包不需要 ChatGPT 凭证。

## 安装与运行

```bash
npm install
npm run dev
```

常用命令：

```bash
npm run lint
npm run typecheck
npm test
npm test -- --coverage
npm run test:e2e
npm run test:tunnel
npm run test:ui
npm run build
npm run dist
```

运行 `npm run test:ui` 前，先执行 `npm run build`，并在另一个终端启动 `npx electron . --remote-debugging-port=9222`。

`npm run dist` 打包当前操作系统；发布工作流覆盖 Windows、macOS 和 Linux 构建矩阵。

## 连接工作区

1. 在“项目”页面添加本地文件夹，并检查 Agent 指令。
2. 打开独立“Tunnel”页面，只填写 Tunnel ID 和 API Key。
3. 点击“保存并启动”，等待 Tunnel 进入等待 ChatGPT 状态。
4. 在 ChatGPT Plugins 中添加自定义 MCP 服务，连接方式选 **Tunnel**，填入相同 Tunnel ID，Authentication 选择 **No Auth**。
5. 在 ChatGPT 中执行一次真实的 `project_list`，验证完整连接。

本地 MCP 端点默认为 `http://127.0.0.1:32180/mcp`，不会有意绑定局域网或公网接口。本地 Bearer 凭证由 Tunnel 客户端注入，不需要填写到 ChatGPT。

## 文档

- [需求](docs/REQUIREMENTS.md)
- [架构](docs/ARCHITECTURE.md)
- [安全](docs/SECURITY.md)
- [测试](docs/TESTING.md)
- [JSONL 审计日志](docs/LOGGING.md)
- [验证记录](docs/VALIDATION.md)
- [MCP 工具](docs/MCP_TOOLS.md)
- [Tunnel 验证边界](docs/TUNNEL.md)

## 许可证

Apache-2.0