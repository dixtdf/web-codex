import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const outputDirectory = 'artifacts'
const cdpPort = process.env.CDP_PORT ?? '9222'
await mkdir(outputDirectory, { recursive: true })
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const target = targets.find((item) => item.title === 'Web Codex' && item.type === 'page')
if (!target) throw new Error('Web Codex CDP target not found')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let sequence = 0
const pending = new Map()
const exceptions = []
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`))
    else request.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args)
})

function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Evaluation failed')
  return response.result.value
}

async function waitFor(expression, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(`Boolean(${expression})`)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

async function navigate(label, expectedTitle) {
  await evaluate(`[...document.querySelectorAll('.main-nav button')].find((button) => button.textContent.includes(${JSON.stringify(label)})).click()`)
  await waitFor(`document.querySelector('.page-header h1')?.textContent === ${JSON.stringify(expectedTitle)}`)
}

async function inspectPage(name) {
  return evaluate(`(() => {
    const overflow = [...document.querySelectorAll('.main-content *')].filter((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.position !== 'fixed' && rect.width > 0 && rect.right > window.innerWidth + 2
    }).slice(0, 8).map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right }))
    return {
      name: ${JSON.stringify(name)},
      title: document.querySelector('.page-header h1')?.textContent ?? document.querySelector('.hero h1')?.textContent,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      overflow
    }
  })()`)
}

async function capture(name) {
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(outputDirectory, `${name}.png`), Buffer.from(screenshot.data, 'base64'))
}

await send('Runtime.enable')
await send('Page.enable')
await waitFor(`window.webCodex && document.querySelector('.main-nav')`)
await evaluate(`[...document.querySelectorAll('.main-nav button')].find((button) => button.textContent.includes('首页')).click()`)
await waitFor(`document.querySelector('.hero')`)
const pages = []
const report = { startedAt: new Date().toISOString(), pages, exceptions, consoleErrors, checks: {} }

try {
  await capture('web-codex-home')
  pages.push(await inspectPage('home'))
  const menuLogs = await evaluate(`window.webCodex.listLogs({ query: 'app.menu_hidden', limit: 10 }).then((items) => items.length)`)
  if (process.platform !== 'darwin') report.checks.menuBarHidden = menuLogs > 0

  await navigate('项目', '你的项目')
  pages.push(await inspectPage('projects'))
  if (!await evaluate(`document.querySelector('.upload-inbox') !== null`)) throw new Error('Attachment inbox is missing')
  report.checks.attachmentInboxVisible = true
  await evaluate(`document.querySelector('.page-actions button').click()`)
  await waitFor(`document.querySelector('.modal')?.textContent.includes('添加工作项目')`)
  if (!await evaluate(`document.querySelector('.modal')?.textContent.includes('远程命令策略')`)) throw new Error('Project remote command policy form is missing')
  report.checks.remoteCommandPolicyForm = true
  await evaluate(`document.querySelector('.modal-header .icon-button').click()`)

  await navigate('Tunnel', 'Tunnel 连接')
  pages.push(await inspectPage('tunnel'))
  await waitFor(`document.querySelector('input[type="password"]') && document.querySelector('.connection-box')`)
  const legacyTunnelFields = await evaluate(`document.body.textContent.includes('Tunnel 启动命令') || document.body.textContent.includes('Tunnel 参数')`)
  if (legacyTunnelFields) throw new Error('Legacy editable Tunnel command fields are visible')
  report.checks.tunnelSimplified = true
  const tunnelClient = await evaluate(`window.webCodex.getRuntime().then((snapshot) => snapshot.tunnel.client)`)
  if (!tunnelClient || typeof tunnelClient.available !== 'boolean') throw new Error('Tunnel client preflight state is missing')
  if (!tunnelClient.available) throw new Error(`Bundled Tunnel client preflight failed: ${tunnelClient.error ?? 'unknown error'}`)
  if (!await evaluate(`document.body.textContent.includes('无法发现 OAuth 设置')`)) throw new Error('OAuth discovery guidance is missing')
  report.checks.tunnelClientDiagnostic = true
  const discovery = await evaluate(`(async () => {
    const connection = await window.webCodex.getConnectionInfo()
    const response = await fetch(connection.localAddress, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + connection.token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ui-discover', method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'ui-smoke', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } })
    })
    return { status: response.status, body: await response.json() }
  })()`)
  if (discovery.status !== 200 || discovery.body.result?.resultType !== 'complete' || !discovery.body.result?.supportedVersions?.includes('2026-07-28')) throw new Error(`Installed server/discover failed: ${JSON.stringify(discovery)}`)
  report.checks.serverDiscover = true
  const trayLogs = await evaluate(`window.webCodex.listLogs({ query: 'tray.created', limit: 10 }).then((items) => items.length)`)
  report.checks.trayIntegrated = trayLogs > 0

  await navigate('MCP 连接', '连接其他 MCP')
  pages.push(await inspectPage('connections'))
  await evaluate(`document.querySelector('.page-actions button').click()`)
  await waitFor(`document.querySelector('.modal')?.textContent.includes('添加 MCP 连接')`)
  await evaluate(`document.querySelector('.modal-header .icon-button').click()`)

  await navigate('任务活动', '任务与日志')
  pages.push(await inspectPage('activity'))
  await evaluate(`document.querySelector('.activity-tabs button:nth-child(2)').click()`)
  await waitFor(`document.querySelector('.log-event-summary')`)
  await evaluate(`document.querySelector('.log-event-summary').click()`)
  await waitFor(`document.querySelector('.log-event-detail')`)
  report.checks.logCenter = true

  await navigate('设置', '设置')
  pages.push(await inspectPage('settings'))
  await evaluate(`[...document.querySelectorAll('.settings-section .segmented button')].find((button) => button.textContent === '深色').click()`)
  await waitFor(`document.documentElement.dataset.theme === 'dark'`)
  await evaluate(`[...document.querySelectorAll('.settings-section .segmented button')].find((button) => button.textContent === '跟随系统').click()`)
  await waitFor(`document.documentElement.dataset.theme === 'system'`)
  report.checks.themeSwitch = true
  const secretStorage = await evaluate(`window.webCodex.getRuntime().then((snapshot) => snapshot.secrets)`)
  if (!secretStorage || secretStorage.mode !== 'os-protected') throw new Error('OS-protected secret storage is not active')
  report.checks.osProtectedSecrets = true
  await capture('web-codex-settings')

  const projectPath = await mkdtemp(join(tmpdir(), 'web-codex-ui-'))
  const projectId = await evaluate(`window.webCodex.createProject({ path: ${JSON.stringify(projectPath)}, name: 'UI Smoke Project' }).then((project) => project.id)`)
  report.checks.projectCreated = Boolean(projectId)
  try {
    await evaluate(`window.webCodex.saveProjectInstructions(${JSON.stringify(projectId)}, '# UI Smoke\\n\\n- Run tests')`)
    const context = await evaluate(`window.webCodex.getProjectContext(${JSON.stringify(projectId)})`)
if (context.instructionFile !== 'AGENTS.md' || !context.instructions.includes('Run tests')) throw new Error('Instruction IPC verification failed')
    report.checks.instructionContext = true
    report.checks.projectWorkflow = true
    const attachmentPath = join(projectPath, 'attachment.stl')
    await writeFile(attachmentPath, Buffer.from([0, 255, 1, 2, 3, 254]))
    const [attachment] = await evaluate(`window.webCodex.addUploadFiles([${JSON.stringify(attachmentPath)}])`)
    if (!attachment || attachment.size !== 6) throw new Error('Binary attachment upload failed')
    await navigate('项目', '你的项目')
    await waitFor(`document.querySelector('.upload-inbox')?.textContent.includes('attachment.stl')`)
    await evaluate(`window.webCodex.removeUpload(${JSON.stringify(attachment.id)})`)
    report.checks.attachmentInbox = true
  } finally {
    await evaluate(`window.webCodex.removeProject(${JSON.stringify(projectId)})`)
  }

  await evaluate(`[...document.querySelectorAll('.main-nav button')].find((button) => button.textContent.includes('首页')).click()`)
  await waitFor(`document.querySelector('.hero')`)
  report.checks.sixPages = pages.length === 6
  report.checks.noHorizontalOverflow = pages.every((page) => page.bodyWidth <= page.viewportWidth && page.overflow.length === 0)
  report.checks.noRuntimeErrors = exceptions.length === 0 && consoleErrors.length === 0
  report.finishedAt = new Date().toISOString()
  report.passed = Object.values(report.checks).every(Boolean)
  await writeFile(join(outputDirectory, 'ui-smoke-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error)
  report.passed = false
  await writeFile(join(outputDirectory, 'ui-smoke-report.json'), JSON.stringify(report, null, 2))
  throw error
} finally {
  socket.close()
}