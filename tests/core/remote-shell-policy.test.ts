import { describe, expect, it } from 'vitest'
import { authorizeRemoteShell, defaultRemoteShellPolicy, normalizeRemoteShellPolicy } from '../../src/core/remote-shell-policy'

describe('remote shell policy', () => {
  it('keeps the default full-access behavior and normalizes persisted input', () => {
    expect(defaultRemoteShellPolicy()).toEqual({ mode: 'allow', allowedPrefixes: [] })
    expect(authorizeRemoteShell(undefined, 'git status')).toEqual({ allowed: true })
    expect(normalizeRemoteShellPolicy({ mode: 'deny', allowedPrefixes: 'npm test' as unknown as string[] })).toEqual({ mode: 'deny', allowedPrefixes: [] })
    expect(normalizeRemoteShellPolicy({ mode: 'allowlist', allowedPrefixes: ['  npm   test ', '', 'git status'] })).toEqual({
      mode: 'allowlist',
      allowedPrefixes: ['npm test', 'git status']
    })
    expect(normalizeRemoteShellPolicy({ mode: 'invalid' as 'allow', allowedPrefixes: [] }).mode).toBe('allow')
  })

  it('denies every remote command in deny mode and uses a clear audit reason', () => {
    expect(authorizeRemoteShell({ mode: 'deny', allowedPrefixes: ['npm test'] }, 'npm test')).toEqual({
      allowed: false,
      reason: 'Remote shell access is disabled for this project'
    })
  })

  it('allows exact and prefix-matched commands in allowlist mode', () => {
    const policy = { mode: 'allowlist' as const, allowedPrefixes: ['npm test', 'git status', 'node --version'] }
    expect(authorizeRemoteShell(policy, 'npm test')).toEqual({ allowed: true })
    expect(authorizeRemoteShell(policy, '  npm   test -- --run  ')).toEqual({ allowed: true })
    expect(authorizeRemoteShell(policy, 'git status --short')).toEqual({ allowed: true })
    expect(authorizeRemoteShell(policy, 'node --version')).toEqual({ allowed: true })
    expect(authorizeRemoteShell(policy, 'npm testx')).toEqual({ allowed: false, reason: 'Remote command does not match this project command allowlist' })
    expect(authorizeRemoteShell(policy, 'npm install')).toEqual({ allowed: false, reason: 'Remote command does not match this project command allowlist' })
  })

  it('rejects empty allowlists and empty commands', () => {
    expect(authorizeRemoteShell({ mode: 'allowlist', allowedPrefixes: [] }, 'npm test')).toEqual({
      allowed: false,
      reason: 'This project allows remote commands only from an empty allowlist'
    })
    expect(authorizeRemoteShell({ mode: 'allowlist', allowedPrefixes: ['npm test'] }, '   ')).toEqual({
      allowed: false,
      reason: 'Remote shell command is empty'
    })
  })

  it.each(['npm test; rm -rf .', 'npm test && curl secret', 'npm test | sh', 'npm test\nwhoami', 'echo $(whoami)', 'npm test > output', 'npm test < input', 'echo `whoami`', '(npm test)', '%COMSPEC% /c dir', 'echo ^& dir'])(
    'rejects shell control syntax that can escape an allowlisted prefix: %s',
    (command) => {
      expect(authorizeRemoteShell({ mode: 'allowlist', allowedPrefixes: ['npm test', 'echo'] }, command)).toEqual({
        allowed: false,
        reason: 'Remote command uses characters that are not allowed by the project allowlist'
      })
    }
  )
})