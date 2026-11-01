import { spawn, type ChildProcess } from 'node:child_process'

function hasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined) || (child.signalCode !== null && child.signalCode !== undefined)
}

function delay(milliseconds: number): { promise: Promise<boolean>; cancel: () => void } {
  let timer: NodeJS.Timeout
  const promise = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds)
    timer.unref()
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

async function waitForTaskkill(child: ChildProcess): Promise<void> {
  let killer: ChildProcess
  try {
    killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
  } catch {
    child.kill()
    return
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5000)
    timeout.unref()
    const finish = (): void => {
      clearTimeout(timeout)
      resolve()
    }
    killer.once('close', finish)
    killer.once('error', () => {
      child.kill()
      finish()
    })
  })
}

export async function terminateProcessTree(child: ChildProcess, gracePeriodMs = 2000): Promise<boolean> {
  if (hasExited(child)) return true
  let closed = false
  let resolveExited: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })
  const onClose = (): void => {
    closed = true
    resolveExited()
  }
  child.once('close', onClose)
  const wait = async (milliseconds: number): Promise<boolean> => {
    if (closed || hasExited(child)) return true
    const timeout = delay(milliseconds)
    const result = await Promise.race([exited.then(() => true), timeout.promise])
    timeout.cancel()
    return result
  }
  try {
    if (process.platform === 'win32') await waitForTaskkill(child)
    else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    } else child.kill('SIGTERM')
    if (await wait(gracePeriodMs)) return true
    if (process.platform !== 'win32') {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      } else child.kill('SIGKILL')
    }
    return await wait(gracePeriodMs)
  } finally {
    child.off('close', onClose)
  }
}
