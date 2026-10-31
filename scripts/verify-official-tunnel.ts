import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Runtime } from '../src/core/runtime'
import { resolveTunnelClientPath } from '../src/core/tunnel-manager'

const tunnelId = 'tunnel_22222222222222222222222222222222'
let output = ''
let proxyChild: ChildProcess | undefined
let runtime: Runtime | undefined

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 45_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}\n${output.slice(-8000)}`)
    if (proxyChild?.exitCode !== null && proxyChild?.exitCode !== undefined) throw new Error(`Official dev proxy exited with ${proxyChild.exitCode}\n${output.slice(-8000)}`)
    await delay(100)
  }
}

async function callMcp(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`MCP returned non-JSON response ${response.status}: ${text.slice(0, 1000)}`)
  }
  if (!response.ok || json.error) throw new Error(`MCP call failed ${response.status}: ${JSON.stringify(json).slice(0, 1500)}`)
  return json
}

try {
  const directory = await mkdtemp(join(tmpdir(), 'web-codex-official-tunnel-'))
  runtime = new Runtime(join(directory, 'config.json'))
  await runtime.initialize()
  const current = runtime.store.get()
  runtime.store.update({
    network: { ...current.network, mode: 'direct' },
    gateway: { ...current.gateway, port: 0, autoStart: true },
    tunnel: { ...current.tunnel, autoStart: false }
  })
  await runtime.start()
  const gateway = runtime.gateway.getState()
  if (!gateway.address) throw new Error('Gateway did not expose an address')
  const token = runtime.store.get().gateway.authToken
  output = ''
  proxyChild = spawn(resolveTunnelClientPath(), ['dev', 'proxy', '--mcp-server-url', gateway.address], {
    env: {
      ...process.env,
      CONTROL_PLANE_API_KEY: 'local-development-only',
      MCP_AUTHORIZATION: `Bearer ${token}`,
      MCP_EXTRA_HEADERS: 'Authorization: env:MCP_AUTHORIZATION',
      MCP_DISCOVERY_EXTRA_HEADERS: 'Authorization: env:MCP_AUTHORIZATION'
    },
    windowsHide: true
  })
  proxyChild.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  proxyChild.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  await waitFor(() => /control-plane route resolved.*target_host=127\.0\.0\.1:\d+/.test(output) && output.includes('mcp session initialized'), 'official MCP startup')
  const port = output.match(/control-plane route resolved.*target_host=127\.0\.0\.1:(\d+)/)?.[1]
  if (!port) throw new Error(`Local control-plane port not found\n${output.slice(-4000)}`)
  const mcpUrl = `http://127.0.0.1:${port}/v1/mcp/${tunnelId}`
  const initialize = await callMcp(mcpUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'web-codex-verifier', version: '1.0' } } })
  const tools = await callMcp(mcpUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const projectList = await callMcp(mcpUrl, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_list', arguments: {} } })
  const report = {
    passed: true,
    clientVersion: '0.0.19',
    gatewayMcpUrl: gateway.address,
    initializeServer: initialize.result && typeof initialize.result === 'object' ? (initialize.result as Record<string, unknown>).serverInfo : undefined,
    toolCount: tools.result && typeof tools.result === 'object' && Array.isArray((tools.result as Record<string, unknown>).tools) ? ((tools.result as Record<string, unknown>).tools as unknown[]).length : 0,
    projectListReturned: Boolean(projectList.result),
    note: 'Verified with the official tunnel-client dev proxy and the real Web Codex Runtime; no hosted OpenAI account was used.'
  }
  await writeFile('artifacts/official-tunnel-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(error)
  console.error(output.slice(-8000))
  process.exitCode = 1
} finally {
  if (proxyChild) {
    if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(proxyChild.pid), '/t', '/f'], { windowsHide: true })
    else proxyChild.kill('SIGTERM')
  }
  await runtime?.stop()
}