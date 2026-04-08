import { getAPIProvider } from './providers.js'

export const MODEL_PROVIDER_KINDS = ['anthropic', 'codex'] as const

export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number]

export function isModelProviderKind(
  value: unknown,
): value is ModelProviderKind {
  return (
    typeof value === 'string' &&
    (MODEL_PROVIDER_KINDS as readonly string[]).includes(value)
  )
}

export function getModelProviderKind(): ModelProviderKind {
  const envOverride = process.env.CLAUDE_CODE_MODEL_PROVIDER?.trim()
  if (isModelProviderKind(envOverride)) {
    return envOverride
  }

  return getAPIProvider() === 'codex' ? 'codex' : 'anthropic'
}

export function isCodexProviderEnabled(): boolean {
  return getModelProviderKind() === 'codex'
}

export function getModelProviderLabel(
  provider: ModelProviderKind = getModelProviderKind(),
): string {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic'
    case 'codex':
      return 'Codex'
  }
}
