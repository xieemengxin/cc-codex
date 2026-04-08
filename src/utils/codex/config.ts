import { mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { logForDebugging } from '../debug.js'

export type CodexServiceTier = 'fast' | 'flex'
export type CodexReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'
export type CodexVerbosity = 'low' | 'medium' | 'high'

export type CodexModelProviderAuth = {
  command?: string
  args?: string[]
  timeout_ms?: number
  refresh_interval_ms?: number
  cwd?: string
}

export type CodexModelProviderInfo = {
  name?: string
  base_url?: string
  env_key?: string
  env_key_instructions?: string
  experimental_bearer_token?: string
  auth?: CodexModelProviderAuth
  wire_api?: 'responses'
  query_params?: Record<string, string>
  http_headers?: Record<string, string>
  env_http_headers?: Record<string, string>
  request_max_retries?: number
  stream_max_retries?: number
  stream_idle_timeout_ms?: number
  websocket_connect_timeout_ms?: number
  requires_openai_auth?: boolean
  supports_websockets?: boolean
  supports_strict_tools?: boolean
}

export type CodexProviderConfig = {
  model?: string
  model_provider?: string
  service_tier?: CodexServiceTier
  model_reasoning_effort?: CodexReasoningEffort
  plan_mode_reasoning_effort?: CodexReasoningEffort
  model_reasoning_summary?: CodexReasoningSummary
  model_verbosity?: CodexVerbosity
  model_context_window?: number
  model_auto_compact_token_limit?: number
  compact_prompt?: string
  model_providers?: Record<string, CodexModelProviderInfo>
  [key: string]: unknown
}

export type CodexAuthJson = {
  auth_mode?: 'api_key' | 'chatgpt' | 'chatgpt_auth_tokens'
  OPENAI_API_KEY?: string
  tokens?: Record<string, unknown>
  last_refresh?: string
  [key: string]: unknown
}

let configCache: CodexProviderConfig | null | undefined
let authCache: CodexAuthJson | null | undefined

export function getCodexConfigDir(): string {
  return join(getClaudeConfigHomeDir(), 'codex')
}

export function getCodexConfigPath(): string {
  return join(getCodexConfigDir(), 'config.toml')
}

export function getCodexAuthPath(): string {
  return join(getCodexConfigDir(), 'auth.json')
}

function ensureCodexConfigDir(): void {
  mkdirSync(getCodexConfigDir(), { recursive: true, mode: 0o700 })
}

function readCodexTomlObject(): Record<string, unknown> | null {
  try {
    const raw = readFileSync(getCodexConfigPath(), 'utf8')
    const parsed = Bun.TOML.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function serializeTomlValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeTomlValue).join(', ')}]`
  }
  throw new Error(`Unsupported TOML value type: ${typeof value}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  )
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function serializeTomlObject(
  object: Record<string, unknown>,
  path: string[] = [],
): string[] {
  const lines: string[] = []
  const nested: Array<[string, Record<string, unknown>]> = []

  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue
    if (isPlainObject(value)) {
      nested.push([key, value])
      continue
    }
    lines.push(`${formatTomlKey(key)} = ${serializeTomlValue(value)}`)
  }

  for (const [key, value] of nested) {
    if (lines.length > 0 || path.length > 0) {
      lines.push('')
    }
    const nextPath = [...path, key]
    lines.push(`[${nextPath.map(formatTomlKey).join('.')}]`)
    lines.push(...serializeTomlObject(value, nextPath))
  }

  while (lines.at(-1) === '') {
    lines.pop()
  }

  return lines
}

function deepMergeObjects(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete result[key]
      continue
    }
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMergeObjects(
        result[key] as Record<string, unknown>,
        value,
      )
      continue
    }
    result[key] = value
  }

  return result
}

function writeCodexTomlObject(object: Record<string, unknown>): void {
  ensureCodexConfigDir()
  const content = serializeTomlObject(object).join('\n')
  writeFileSyncAndFlush_DEPRECATED(
    getCodexConfigPath(),
    content ? `${content}\n` : '',
    { encoding: 'utf8', mode: 0o600 },
  )
}

export function replaceCodexProviderConfig(
  config: CodexProviderConfig,
): { error?: Error; config?: CodexProviderConfig } {
  try {
    writeCodexTomlObject(config as Record<string, unknown>)
    clearCodexProviderConfigCache()
    return { config: getCodexProviderConfig() }
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export function getCodexProviderConfig(): CodexProviderConfig {
  if (configCache !== undefined) {
    return configCache ?? {}
  }

  configCache = (readCodexTomlObject() as CodexProviderConfig | null) ?? {}
  return configCache
}

export function getCodexProviderConfigValue<K extends keyof CodexProviderConfig>(
  key: K,
): CodexProviderConfig[K] {
  return getCodexProviderConfig()[key]
}

export function clearCodexProviderConfigCache(): void {
  configCache = undefined
}

export function updateCodexProviderConfig(
  patch: Partial<CodexProviderConfig>,
): { error?: Error; config?: CodexProviderConfig } {
  try {
    const merged = deepMergeObjects(
      readCodexTomlObject() ?? {},
      patch as Record<string, unknown>,
    )
    writeCodexTomlObject(merged)
    clearCodexProviderConfigCache()
    return { config: getCodexProviderConfig() }
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error))
    logForDebugging(
      `[codex-config] Failed to update ${getCodexConfigPath()}: ${normalized.message}`,
      { level: 'error' },
    )
    return { error: normalized }
  }
}

export function getCodexAuth(): CodexAuthJson | null {
  if (authCache !== undefined) {
    return authCache
  }

  try {
    authCache = JSON.parse(
      readFileSync(getCodexAuthPath(), 'utf8'),
    ) as CodexAuthJson
  } catch {
    authCache = null
  }
  return authCache
}

export function clearCodexAuthCache(): void {
  authCache = undefined
}

export function saveCodexAuth(auth: CodexAuthJson): { error?: Error } {
  try {
    ensureCodexConfigDir()
    writeFileSyncAndFlush_DEPRECATED(
      getCodexAuthPath(),
      JSON.stringify(auth, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    )
    authCache = auth
    return {}
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export function getCodexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}
