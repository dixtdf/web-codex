import type { RemoteShellPolicy } from '../shared/types'

export interface RemoteShellDecision {
  allowed: boolean
  reason?: string
}

const shellControlPattern = /[\r\n;&|`<>()]|\$\(|%\w+%|\^/i

export function defaultRemoteShellPolicy(): RemoteShellPolicy {
  return { mode: 'allow', allowedPrefixes: [] }
}

export function normalizeRemoteShellPolicy(policy?: RemoteShellPolicy): RemoteShellPolicy {
  if (!policy) return defaultRemoteShellPolicy()
  return {
    mode: policy.mode === 'allowlist' || policy.mode === 'deny' ? policy.mode : 'allow',
    allowedPrefixes: Array.isArray(policy.allowedPrefixes)
      ? policy.allowedPrefixes.map((prefix) => prefix.trim().replace(/\s+/g, ' ')).filter(Boolean)
      : []
  }
}

export function authorizeRemoteShell(policy: RemoteShellPolicy | undefined, command: string): RemoteShellDecision {
  const effective = normalizeRemoteShellPolicy(policy)
  if (effective.mode === 'allow') return { allowed: true }
  if (effective.mode === 'deny') return { allowed: false, reason: 'Remote shell access is disabled for this project' }

  const trimmed = command.trim()
  if (!trimmed) return { allowed: false, reason: 'Remote shell command is empty' }
  if (shellControlPattern.test(trimmed)) {
    return { allowed: false, reason: 'Remote command uses characters that are not allowed by the project allowlist' }
  }
  const normalized = trimmed.replace(/\s+/g, ' ')
  if (effective.allowedPrefixes.length === 0) {
    return { allowed: false, reason: 'This project allows remote commands only from an empty allowlist' }
  }
  if (effective.allowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))) {
    return { allowed: true }
  }
  return { allowed: false, reason: 'Remote command does not match this project command allowlist' }
}