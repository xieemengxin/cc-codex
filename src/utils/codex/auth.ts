import axios from 'axios'
import { readFileSync, rmSync } from 'fs'
import { CODEX_AUTH_CLIENT_ID, getCodexAuthIssuer } from '../../constants/codex.js'
import {
  type CodexAuthJson,
  clearCodexAuthCache,
  getCodexAuth,
  getCodexAuthPath,
  saveCodexAuth,
} from './config.js'

export type CodexAuthMode = 'api_key' | 'chatgpt' | 'chatgpt_auth_tokens'

export type CodexIdTokenInfo = {
  email?: string
  chatgptPlanType?: string | null
  chatgptUserId?: string | null
  chatgptAccountId?: string | null
  rawJwt: string
  exp?: number | null
}

export type CodexTokenData = {
  id_token?: string | CodexIdTokenInfo
  access_token?: string
  refresh_token?: string
  account_id?: string | null
}

export type CodexAccountStatus = {
  loggedIn: boolean
  authMode: CodexAuthMode | 'none'
  token: string | null
  email: string | null
  accountId: string | null
  planType: string | null
  apiKeySource: string | null
  authPath: string
}

type JwtAuthClaims = {
  chatgpt_plan_type?: string
  chatgpt_user_id?: string
  user_id?: string
  chatgpt_account_id?: string
}

type JwtPayload = {
  email?: string
  exp?: number
  ['https://api.openai.com/profile']?: {
    email?: string
  }
  ['https://api.openai.com/auth']?: JwtAuthClaims
}

type CodexRefreshResponse = {
  id_token?: string
  access_token?: string
  refresh_token?: string
}

const TOKEN_REFRESH_INTERVAL_DAYS = 8

const WORKSPACE_PLAN_TYPES = new Set([
  'team',
  'self_serve_business_usage_based',
  'business',
  'enterprise_cbp_usage_based',
  'enterprise',
  'hc',
  'education',
  'edu',
])

function decodeJwtPayload(jwt: string): JwtPayload {
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('Invalid JWT format')
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
  return JSON.parse(payload) as JwtPayload
}

export function parseCodexIdToken(jwt: string): CodexIdTokenInfo {
  const payload = decodeJwtPayload(jwt)
  const auth = payload['https://api.openai.com/auth']

  return {
    email: payload.email ?? payload['https://api.openai.com/profile']?.email,
    chatgptPlanType: auth?.chatgpt_plan_type ?? null,
    chatgptUserId: auth?.chatgpt_user_id ?? auth?.user_id ?? null,
    chatgptAccountId: auth?.chatgpt_account_id ?? null,
    rawJwt: jwt,
    exp: payload.exp ?? null,
  }
}

function getStoredCodexTokens(auth: CodexAuthJson | null): CodexTokenData | null {
  if (!auth?.tokens || typeof auth.tokens !== 'object') {
    return null
  }
  return auth.tokens as CodexTokenData
}

export function getCodexIdTokenInfo(
  auth: CodexAuthJson | null = getCodexAuth(),
): CodexIdTokenInfo | null {
  const idToken = getStoredCodexTokens(auth)?.id_token
  if (!idToken) {
    return null
  }
  if (typeof idToken === 'string') {
    try {
      return parseCodexIdToken(idToken)
    } catch {
      return null
    }
  }
  if (
    typeof idToken === 'object' &&
    idToken !== null &&
    'rawJwt' in idToken &&
    typeof idToken.rawJwt === 'string'
  ) {
    return idToken as CodexIdTokenInfo
  }
  return null
}

export function getCodexAuthMode(
  auth: CodexAuthJson | null = getCodexAuth(),
): CodexAuthMode | 'none' {
  const mode = auth?.auth_mode
  if (
    mode === 'api_key' ||
    mode === 'chatgpt' ||
    mode === 'chatgpt_auth_tokens'
  ) {
    return mode
  }
  return auth?.OPENAI_API_KEY ? 'api_key' : 'none'
}

export function getCodexBearerToken(
  auth: CodexAuthJson | null = getCodexAuth(),
): string | null {
  const envToken = process.env.CODEX_API_KEY?.trim()
  if (envToken) {
    return envToken
  }
  const accessToken = getStoredCodexTokens(auth)?.access_token
  if (typeof accessToken === 'string' && accessToken.length > 0) {
    return accessToken
  }
  if (auth?.OPENAI_API_KEY) {
    return auth.OPENAI_API_KEY
  }
  return null
}

export function getCodexAccountId(
  auth: CodexAuthJson | null = getCodexAuth(),
): string | null {
  const tokenInfo = getCodexIdTokenInfo(auth)
  return (
    tokenInfo?.chatgptAccountId ??
    getStoredCodexTokens(auth)?.account_id ??
    null
  )
}

export function isCodexWorkspacePlan(
  planType: string | null | undefined,
): boolean {
  return (
    typeof planType === 'string' &&
    WORKSPACE_PLAN_TYPES.has(planType.trim().toLowerCase())
  )
}

export function isCodexWorkspaceAccount(
  auth: CodexAuthJson | null = getCodexAuth(),
): boolean {
  return isCodexWorkspacePlan(getCodexIdTokenInfo(auth)?.chatgptPlanType)
}

function shouldRefreshCodexToken(auth: CodexAuthJson | null): boolean {
  if (getCodexAuthMode(auth) !== 'chatgpt') {
    return false
  }

  const lastRefresh = auth?.last_refresh ? Date.parse(auth.last_refresh) : NaN
  if (!Number.isNaN(lastRefresh)) {
    const ageMs = Date.now() - lastRefresh
    if (ageMs > TOKEN_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000) {
      return true
    }
  }

  const exp = getCodexIdTokenInfo(auth)?.exp
  if (typeof exp === 'number') {
    return Date.now() >= exp * 1000 - 5 * 60 * 1000
  }

  return false
}

export async function refreshCodexAuthIfNeeded(
  force = false,
): Promise<CodexAuthJson | null> {
  const auth = getCodexAuth()
  if (!auth) return null

  const mode = getCodexAuthMode(auth)
  if (mode !== 'chatgpt') {
    return auth
  }

  const tokens = getStoredCodexTokens(auth)
  if (!tokens?.refresh_token) {
    return auth
  }

  if (!force && !shouldRefreshCodexToken(auth)) {
    return auth
  }

  const response = await axios.post<CodexRefreshResponse>(
    `${getCodexAuthIssuer()}/oauth/token`,
    {
      client_id: CODEX_AUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    },
  )

  const nextIdToken = response.data.id_token ?? tokens.id_token
  const nextAccessToken = response.data.access_token ?? tokens.access_token
  const nextRefreshToken = response.data.refresh_token ?? tokens.refresh_token
  const nextInfo =
    typeof nextIdToken === 'string' ? parseCodexIdToken(nextIdToken) : null

  const nextAuth: CodexAuthJson = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: auth.OPENAI_API_KEY,
    tokens: {
      id_token:
        typeof nextIdToken === 'string' ? nextIdToken : nextInfo?.rawJwt,
      access_token: nextAccessToken,
      refresh_token: nextRefreshToken,
      account_id:
        nextInfo?.chatgptAccountId ?? tokens.account_id ?? null,
    },
    last_refresh: new Date().toISOString(),
  }

  const saved = saveCodexAuth(nextAuth)
  if (saved.error) {
    throw saved.error
  }
  return nextAuth
}

export function saveCodexApiKey(apiKey: string): { error?: Error } {
  return saveCodexAuth({
    auth_mode: 'api_key',
    OPENAI_API_KEY: apiKey,
    tokens: undefined,
    last_refresh: undefined,
  })
}

export function saveCodexChatgptTokens(tokens: {
  idToken: string
  accessToken: string
  refreshToken: string
  openAiApiKey?: string
}): { error?: Error } {
  const idInfo = parseCodexIdToken(tokens.idToken)
  return saveCodexAuth({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: tokens.openAiApiKey,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: idInfo.chatgptAccountId ?? null,
    },
    last_refresh: new Date().toISOString(),
  })
}

export function removeCodexAuth(): void {
  rmSync(getCodexAuthPath(), { force: true })
  clearCodexAuthCache()
}

export function getCodexAccountStatus(): CodexAccountStatus {
  const auth = getCodexAuth()
  const idTokenInfo = getCodexIdTokenInfo(auth)
  const token = getCodexBearerToken(auth)
  const envApiKey = process.env.CODEX_API_KEY?.trim()

  return {
    loggedIn: token !== null,
    authMode: getCodexAuthMode(auth),
    token,
    email: idTokenInfo?.email ?? null,
    accountId: getCodexAccountId(auth),
    planType: idTokenInfo?.chatgptPlanType ?? null,
    apiKeySource:
      envApiKey
        ? 'env:CODEX_API_KEY'
        : auth?.OPENAI_API_KEY != null
        ? 'auth.json:OPENAI_API_KEY'
        : null,
    authPath: getCodexAuthPath(),
  }
}

export function readCodexAuthFileRaw(): string | null {
  try {
    return readFileSync(getCodexAuthPath(), 'utf8')
  } catch {
    return null
  }
}
