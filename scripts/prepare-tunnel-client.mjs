import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'

const execFileAsync = promisify(execFile)

export const TUNNEL_CLIENT_VERSION = '0.0.19'
const releaseBase = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_CLIENT_VERSION}`


function platformAsset(platform, arch) {
  const platformName = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform]
  const architecture = { x64: 'amd64', arm64: 'arm64' }[arch]
  if (!platformName || !architecture) throw new Error(`Unsupported Tunnel client target: ${platform}/${arch}`)
  return {
    key: `${platformName}-${architecture}`,
    asset: `tunnel-client-v${TUNNEL_CLIENT_VERSION}-${platformName}-${architecture}.zip`,
    executable: platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'
  }
}

async function download(url, accept = 'application/octet-stream') {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'web-codex', Accept: accept }, redirect: 'follow' })
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`)
    return Buffer.from(await response.arrayBuffer())
  } catch {
    const { stdout } = await execFileAsync('curl', ['-L', '--fail', '--silent', '--show-error', '--max-time', '180', '-H', 'User-Agent: web-codex', '-H', `Accept: ${accept}`, url], { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024, windowsHide: true })
    return stdout
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function validCachedClient(directory, executable) {
  const binaryPath = join(directory, executable)
  const manifestPath = join(directory, 'manifest.json')
  if (!existsSync(binaryPath) || !existsSync(manifestPath) || !existsSync(join(directory, 'LICENSES.txt'))) return null
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.version !== TUNNEL_CLIENT_VERSION || manifest.binarySha256 !== sha256(await readFile(binaryPath))) return null
    return { binaryPath, manifest }
  } catch {
    return null
  }
}

export async function prepareTunnelClient({ platform = process.platform, arch = process.arch, rootDirectory = process.cwd() } = {}) {
  const target = platformAsset(platform, arch)
  const directory = join(rootDirectory, 'resources', 'tunnel-client', target.key)
  const cached = await validCachedClient(directory, target.executable)
  let expected
  try {
    const sums = (await download(`${releaseBase}/SHA256SUMS.txt`)).toString('utf8')
    expected = sums.split(/\r?\n/).map((line) => line.trim()).find((line) => line.endsWith(` ${target.asset}`) || line.endsWith(`*${target.asset}`))?.split(/\s+/)[0]
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error(`Official checksum not found for ${target.asset}`)
    if (cached && cached.manifest.archiveSha256 === expected) return { ...cached, cached: true, target }
  } catch (error) {
    if (cached) return { ...cached, cached: true, target }
    throw error
  }
  if (cached && !expected) return { ...cached, cached: true, target }

  const assetUrl = `${releaseBase}/${target.asset}`
  const archive = await download(assetUrl)
  const archiveSha256 = sha256(archive)
  if (archiveSha256 !== expected) throw new Error(`Tunnel client checksum mismatch: expected ${expected}, received ${archiveSha256}`)
  const zip = new AdmZip(archive)
  const entry = zip.getEntries().find((item) => !item.isDirectory && basename(item.entryName) === target.executable)
  if (!entry) throw new Error(`Official archive does not contain ${target.executable}`)
  const binary = entry.getData()
  const license = await download(`${releaseBase}/${target.asset.replace(/\.zip$/, '-licenses.txt')}`)
  await mkdir(directory, { recursive: true })
  const binaryPath = join(directory, target.executable)
  const binarySha256 = sha256(binary)
  const manifest = {
    name: 'OpenAI Secure MCP Tunnel Client',
    repository: 'https://github.com/openai/tunnel-client',
    version: TUNNEL_CLIENT_VERSION,
    asset: target.asset,
    assetUrl,
    archiveSha256,
    binarySha256,
    platform,
    arch
  }
  await writeFile(binaryPath, binary, { mode: 0o755 })
  if (platform !== 'win32') await chmod(binaryPath, 0o755)
  await writeFile(join(directory, 'LICENSES.txt'), license)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { binaryPath, manifest, cached: false, target }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const platform = process.argv.includes('--platform') ? process.argv[process.argv.indexOf('--platform') + 1] : process.platform
  const arch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch
  const result = await prepareTunnelClient({ platform, arch })
  console.log(JSON.stringify({ version: result.manifest.version, platform: result.manifest.platform, arch: result.manifest.arch, binary: result.binaryPath, cached: result.cached, archiveSha256: result.manifest.archiveSha256 }))
}