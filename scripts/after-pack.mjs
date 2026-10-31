import { join } from 'node:path'
import { copyFile, mkdir } from 'node:fs/promises'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'
import { prepareTunnelClient } from './prepare-tunnel-client.mjs'

export function executablePathForPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const productFilename = packager.appInfo.productFilename
  const executableName = electronPlatformName === 'linux' ? packager.appInfo.name : packager.appInfo.executableName ?? productFilename
  return electronPlatformName === 'win32'
    ? join(appOutDir, `${productFilename}.exe`)
    : electronPlatformName === 'darwin'
      ? join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
      : join(appOutDir, executableName)
}

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context
  const executablePath = executablePathForPack(context)
  const targetArch = context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : context.arch
  const tunnel = await prepareTunnelClient({ platform: electronPlatformName, arch: targetArch })
  const tunnelResources = join(appOutDir, 'resources', 'tunnel-client')
  await mkdir(tunnelResources, { recursive: true })
  await copyFile(tunnel.binaryPath, join(tunnelResources, tunnel.target.executable))
  await copyFile(join(tunnel.binaryPath, '..', 'manifest.json'), join(tunnelResources, 'manifest.json'))
  await copyFile(join(tunnel.binaryPath, '..', 'LICENSES.txt'), join(tunnelResources, 'LICENSES.txt'))
  console.log(`OpenAI Tunnel client bundled: ${tunnel.manifest.version} ${tunnel.target.key}`)
  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false
  })
  console.log(`RunAsNode fuse disabled: ${executablePath}`)
}