import { getCodexAccountStatus } from './auth.js'
import {
  getCodexRequestHeaders,
  getResolvedCodexProvider,
} from './provider.js'

export type CodexRateLimitWindow = {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export type CodexCreditsSnapshot = {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export type CodexRateLimitSnapshot = {
  limitId: string
  limitName: string | null
  primary: CodexRateLimitWindow | null
  secondary: CodexRateLimitWindow | null
  credits: CodexCreditsSnapshot | null
  planType: string | null
}

export type CodexRateLimitsState = {
  primary: CodexRateLimitSnapshot | null
  byLimitId: Record<string, CodexRateLimitSnapshot>
  capturedAt: number
}

type RawRateLimitWindowSnapshot = {
  used_percent?: number | null
  limit_window_seconds?: number | null
  reset_at?: number | null
}

type RawRateLimitStatusDetails = {
  primary_window?: RawRateLimitWindowSnapshot | null
  secondary_window?: RawRateLimitWindowSnapshot | null
}

type RawCreditStatusDetails = {
  has_credits?: boolean | null
  unlimited?: boolean | null
  balance?: string | null
}

type RawAdditionalRateLimitDetails = {
  limit_name?: string | null
  metered_feature?: string | null
  rate_limit?: RawRateLimitStatusDetails | null
}

type RawRateLimitStatusPayload = {
  plan_type?: string | null
  rate_limit?: RawRateLimitStatusDetails | null
  credits?: RawCreditStatusDetails | null
  additional_rate_limits?: RawAdditionalRateLimitDetails[] | null
}

let cachedRateLimits: CodexRateLimitsState | null = null

function normalizeLimitId(name: string): string {
  return name.trim().toLowerCase().replaceAll('-', '_')
}

function mapWindow(
  window: RawRateLimitWindowSnapshot | null | undefined,
): CodexRateLimitWindow | null {
  if (!window || typeof window.used_percent !== 'number') {
    return null
  }

  return {
    usedPercent: window.used_percent,
    windowDurationMins:
      typeof window.limit_window_seconds === 'number'
        ? Math.round(window.limit_window_seconds / 60)
        : null,
    resetsAt:
      typeof window.reset_at === 'number' ? window.reset_at : null,
  }
}

function mapCredits(
  credits: RawCreditStatusDetails | null | undefined,
): CodexCreditsSnapshot | null {
  if (!credits || typeof credits.has_credits !== 'boolean') {
    return null
  }

  return {
    hasCredits: credits.has_credits,
    unlimited: credits.unlimited === true,
    balance: credits.balance ?? null,
  }
}

function makeSnapshot(params: {
  limitId: string
  limitName?: string | null
  rateLimit?: RawRateLimitStatusDetails | null
  credits?: RawCreditStatusDetails | null
  planType?: string | null
}): CodexRateLimitSnapshot {
  return {
    limitId: normalizeLimitId(params.limitId),
    limitName: params.limitName ?? null,
    primary: mapWindow(params.rateLimit?.primary_window),
    secondary: mapWindow(params.rateLimit?.secondary_window),
    credits: mapCredits(params.credits),
    planType: params.planType ?? null,
  }
}

function hasRateLimitData(snapshot: CodexRateLimitSnapshot): boolean {
  return (
    snapshot.primary !== null ||
    snapshot.secondary !== null ||
    snapshot.credits !== null
  )
}

function buildStateFromPayload(
  payload: RawRateLimitStatusPayload,
): CodexRateLimitsState {
  const primarySnapshot = makeSnapshot({
    limitId: 'codex',
    rateLimit: payload.rate_limit,
    credits: payload.credits,
    planType: payload.plan_type ?? null,
  })

  const snapshots: CodexRateLimitSnapshot[] = [primarySnapshot]

  for (const additional of payload.additional_rate_limits ?? []) {
    const limitId =
      additional.metered_feature ??
      additional.limit_name ??
      `limit_${snapshots.length}`

    snapshots.push(
      makeSnapshot({
        limitId,
        limitName: additional.limit_name ?? null,
        rateLimit: additional.rate_limit,
        planType: payload.plan_type ?? null,
      }),
    )
  }

  const byLimitId = Object.fromEntries(
    snapshots
      .filter(hasRateLimitData)
      .map(snapshot => [snapshot.limitId, snapshot] as const),
  )

  return {
    primary: byLimitId.codex ?? primarySnapshot,
    byLimitId,
    capturedAt: Date.now(),
  }
}

function parseHeaderString(
  headers: Headers,
  name: string,
): string | null {
  const value = headers.get(name)
  if (!value) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseHeaderNumber(
  headers: Headers,
  name: string,
): number | null {
  const value = parseHeaderString(headers, name)
  if (!value) {
    return null
  }
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseHeaderBoolean(
  headers: Headers,
  name: string,
): boolean | null {
  const value = parseHeaderString(headers, name)
  if (!value) {
    return null
  }
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function parseRateLimitWindowFromHeaders(
  headers: Headers,
  prefix: string,
): CodexRateLimitWindow | null {
  const usedPercent = parseHeaderNumber(headers, `${prefix}-used-percent`)
  if (usedPercent === null) {
    return null
  }

  return {
    usedPercent,
    windowDurationMins: parseHeaderNumber(
      headers,
      `${prefix}-window-minutes`,
    ),
    resetsAt: parseHeaderNumber(headers, `${prefix}-reset-at`),
  }
}

function parseCreditsFromHeaders(headers: Headers): CodexCreditsSnapshot | null {
  const hasCredits = parseHeaderBoolean(headers, 'x-codex-credits-has-credits')
  if (hasCredits === null) {
    return null
  }

  return {
    hasCredits,
    unlimited: parseHeaderBoolean(headers, 'x-codex-credits-unlimited') === true,
    balance: parseHeaderString(headers, 'x-codex-credits-balance'),
  }
}

export function mergeCodexRateLimitsFromHeaders(
  headers: Headers,
): CodexRateLimitsState | null {
  const limitIds = new Set<string>()

  for (const key of headers.keys()) {
    const normalized = key.toLowerCase()
    const suffix = '-primary-used-percent'
    if (!normalized.endsWith(suffix)) {
      continue
    }
    const raw = normalized.slice(2, -suffix.length)
    if (raw.length > 0) {
      limitIds.add(normalizeLimitId(raw))
    }
  }

  if (limitIds.size === 0 && parseCreditsFromHeaders(headers) === null) {
    return null
  }

  if (!limitIds.has('codex')) {
    limitIds.add('codex')
  }

  const byLimitId: Record<string, CodexRateLimitSnapshot> = {}

  for (const limitId of limitIds) {
    const prefix = `x-${limitId.replaceAll('_', '-')}`
    const snapshot: CodexRateLimitSnapshot = {
      limitId,
      limitName: parseHeaderString(headers, `${prefix}-limit-name`),
      primary: parseRateLimitWindowFromHeaders(headers, `${prefix}-primary`),
      secondary: parseRateLimitWindowFromHeaders(headers, `${prefix}-secondary`),
      credits: limitId === 'codex' ? parseCreditsFromHeaders(headers) : null,
      planType: null,
    }

    if (hasRateLimitData(snapshot)) {
      byLimitId[limitId] = snapshot
    }
  }

  const state: CodexRateLimitsState = {
    primary: byLimitId.codex ?? null,
    byLimitId,
    capturedAt: Date.now(),
  }

  cachedRateLimits = state
  return state
}

export function getCachedCodexRateLimits(): CodexRateLimitsState | null {
  return cachedRateLimits
}

export function clearCachedCodexRateLimits(): void {
  cachedRateLimits = null
}

function getCodexUsageUrl(): string {
  const provider = getResolvedCodexProvider()
  const baseUrl =
    process.env.CLAUDE_CODE_CODEX_CHATGPT_BASE_URL?.trim() ||
    (provider.baseUrl.includes('/backend-api/codex')
      ? provider.baseUrl.replace(/\/codex$/, '')
      : provider.baseUrl.includes('/backend-api')
        ? provider.baseUrl
        : provider.baseUrl.includes('chatgpt.com') ||
            provider.baseUrl.includes('chat.openai.com')
          ? `${provider.baseUrl.replace(/\/$/, '')}/backend-api`
          : 'https://chatgpt.com/backend-api')

  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  if (normalizedBaseUrl.includes('/backend-api')) {
    return `${normalizedBaseUrl}/wham/usage`
  }
  return `${normalizedBaseUrl}/api/codex/usage`
}

export async function fetchCodexRateLimits(): Promise<CodexRateLimitsState> {
  const accountStatus = getCodexAccountStatus()
  if (!accountStatus.loggedIn) {
    throw new Error('Codex login required to read usage information')
  }
  if (
    accountStatus.authMode !== 'chatgpt' &&
    accountStatus.authMode !== 'chatgpt_auth_tokens'
  ) {
    throw new Error('ChatGPT authentication is required to read Codex usage')
  }

  const headers = await getCodexRequestHeaders()
  if (!headers.Authorization) {
    throw new Error('Missing Codex bearer token')
  }

  const response = await fetch(getCodexUsageUrl(), {
    method: 'GET',
    headers,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Failed to fetch Codex usage (${response.status}): ${body || response.statusText}`,
    )
  }

  const payload = (await response.json()) as RawRateLimitStatusPayload
  const state = buildStateFromPayload(payload)
  cachedRateLimits = state
  return state
}
