import { getSessionId } from '../../bootstrap/state.js'
import {
  getCodexOriginator,
  getCodexUserAgent,
} from '../../constants/codex.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import {
  getCodexAccountId,
  getCodexBearerToken,
  getCodexAuthMode,
  refreshCodexAuthIfNeeded,
} from './auth.js'
import {
  getCodexProviderConfig,
  type CodexModelProviderInfo,
} from './config.js'

export type ResolvedCodexProvider = {
  id: string
  info: CodexModelProviderInfo
  baseUrl: string
  authMode: ReturnType<typeof getCodexAuthMode>
}

type CachedProviderToken = {
  token: string
  expiresAt: number
}

const providerTokenCache = new Map<string, CachedProviderToken>()

function getDefaultCodexProviderBaseUrl(): string {
  const authMode = getCodexAuthMode()
  return authMode === 'chatgpt' || authMode === 'chatgpt_auth_tokens'
    ? 'https://chatgpt.com/backend-api/codex'
    : 'https://api.openai.com/v1'
}

export function getResolvedCodexProvider(): ResolvedCodexProvider {
  const config = getCodexProviderConfig()
  const providerId = config.model_provider ?? 'openai'
  const configured = config.model_providers?.[providerId] ?? {}
  const authMode = getCodexAuthMode()
  const info: CodexModelProviderInfo = {
    supports_websockets:
      configured.supports_websockets ?? providerId === 'openai',
    supports_strict_tools:
      configured.supports_strict_tools ?? providerId === 'openai',
    websocket_connect_timeout_ms:
      configured.websocket_connect_timeout_ms ?? 15_000,
    ...configured,
  }

  return {
    id: providerId,
    info,
    baseUrl: (info.base_url ?? getDefaultCodexProviderBaseUrl()).replace(
      /\/$/,
      '',
    ),
    authMode,
  }
}

async function resolveProviderBearerToken(
  provider: ResolvedCodexProvider,
): Promise<string | null> {
  if (provider.info.experimental_bearer_token) {
    return provider.info.experimental_bearer_token
  }

  if (provider.info.env_key) {
    const envValue = process.env[provider.info.env_key]?.trim()
    if (envValue) {
      return envValue
    }
  }

  if (provider.info.auth?.command) {
    const cacheKey = `${provider.id}:${provider.info.auth.command}:${(provider.info.auth.args ?? []).join('\u0000')}`
    const cached = providerTokenCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token
    }

    const result = await execFileNoThrowWithCwd(
      provider.info.auth.command,
      provider.info.auth.args ?? [],
      {
        cwd: provider.info.auth.cwd,
        timeout: provider.info.auth.timeout_ms ?? 5000,
      },
    )
    if (result.code === 0) {
      const token = result.stdout.trim()
      if (token) {
        providerTokenCache.set(cacheKey, {
          token,
          expiresAt:
            Date.now() +
            (provider.info.auth.refresh_interval_ms ?? 300_000),
        })
        return token
      }
    }
  }

  await refreshCodexAuthIfNeeded()
  return getCodexBearerToken()
}

export async function getCodexRequestHeaders(extra?: {
  subagent?: string
}): Promise<Record<string, string>> {
  const provider = getResolvedCodexProvider()
  const bearerToken = await resolveProviderBearerToken(provider)
  const sessionId = getSessionId()
  const headers: Record<string, string> = {
    originator: getCodexOriginator(),
    'User-Agent': getCodexUserAgent(),
    session_id: sessionId,
    'x-client-request-id': sessionId,
  }

  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`
  }

  const accountId = getCodexAccountId()
  if (
    accountId &&
    (provider.authMode === 'chatgpt' ||
      provider.authMode === 'chatgpt_auth_tokens')
  ) {
    headers['ChatGPT-Account-ID'] = accountId
  }

  if (extra?.subagent) {
    headers['x-openai-subagent'] = extra.subagent
  }

  for (const [key, value] of Object.entries(provider.info.http_headers ?? {})) {
    if (value?.trim()) {
      headers[key] = value
    }
  }

  for (const [key, envName] of Object.entries(
    provider.info.env_http_headers ?? {},
  )) {
    const envValue = process.env[envName]?.trim()
    if (envValue) {
      headers[key] = envValue
    }
  }

  if (process.env.OPENAI_ORGANIZATION) {
    headers['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION
  }
  if (process.env.OPENAI_PROJECT) {
    headers['OpenAI-Project'] = process.env.OPENAI_PROJECT
  }

  return headers
}

export function getCodexResponsesUrl(): string {
  const provider = getResolvedCodexProvider()
  const params = new URLSearchParams(provider.info.query_params ?? {})
  const url = `${provider.baseUrl}/responses`
  const query = params.toString()
  return query ? `${url}?${query}` : url
}
