import axios from 'axios'
import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from '../oauth/auth-code-listener.js'
import * as crypto from '../oauth/crypto.js'
import {
  CODEX_AUTH_CALLBACK_PATH,
  CODEX_AUTH_CALLBACK_PORT,
  CODEX_AUTH_CLIENT_ID,
  CODEX_AUTH_SCOPES,
  getCodexAuthIssuer,
  getCodexOriginator,
} from '../../constants/codex.js'
import { saveCodexChatgptTokens } from '../../utils/codex/auth.js'

type CodexTokenExchangeResponse = {
  id_token: string
  access_token: string
  refresh_token: string
}

function buildCodexAuthorizeUrl(params: {
  codeChallenge: string
  state: string
  port: number
  allowedWorkspaceId?: string
}): string {
  const authUrl = new URL(`${getCodexAuthIssuer()}/oauth/authorize`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', CODEX_AUTH_CLIENT_ID)
  authUrl.searchParams.set(
    'redirect_uri',
    `http://localhost:${params.port}${CODEX_AUTH_CALLBACK_PATH}`,
  )
  authUrl.searchParams.set('scope', CODEX_AUTH_SCOPES.join(' '))
  authUrl.searchParams.set('code_challenge', params.codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('state', params.state)
  authUrl.searchParams.set('originator', getCodexOriginator())
  if (params.allowedWorkspaceId) {
    authUrl.searchParams.set(
      'allowed_workspace_id',
      params.allowedWorkspaceId,
    )
  }
  return authUrl.toString()
}

async function exchangeCodexCodeForTokens(params: {
  authorizationCode: string
  codeVerifier: string
  redirectUri: string
}): Promise<CodexTokenExchangeResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.authorizationCode,
    redirect_uri: params.redirectUri,
    client_id: CODEX_AUTH_CLIENT_ID,
    code_verifier: params.codeVerifier,
  })

  const response = await axios.post<CodexTokenExchangeResponse>(
    `${getCodexAuthIssuer()}/oauth/token`,
    body.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    },
  )
  return response.data
}

function handleCodexSuccessPage(res: Parameters<
  NonNullable<
    Parameters<AuthCodeListener['handleSuccessRedirect']>[1]
  >
>[0]): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    '<!doctype html><html><body><h1>Authorization received</h1><p>Claude Code is finalizing your Codex login. You can return to the terminal.</p></body></html>',
  )
}

export class CodexOAuthService {
  private codeVerifier: string
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null

  constructor() {
    this.codeVerifier = crypto.generateCodeVerifier()
  }

  async startOAuthFlow(
    authURLHandler: (url: string) => Promise<void>,
    options?: {
      skipBrowserOpen?: boolean
      allowedWorkspaceId?: string
    },
  ): Promise<void> {
    this.authCodeListener = new AuthCodeListener(CODEX_AUTH_CALLBACK_PATH)
    this.port = await this.authCodeListener.start(CODEX_AUTH_CALLBACK_PORT)

    const codeChallenge = crypto.generateCodeChallenge(this.codeVerifier)
    const state = crypto.generateState()
    const redirectUri = `http://localhost:${this.port}${CODEX_AUTH_CALLBACK_PATH}`
    const authUrl = buildCodexAuthorizeUrl({
      codeChallenge,
      state,
      port: this.port,
      allowedWorkspaceId: options?.allowedWorkspaceId,
    })

    const authorizationCode = await this.authCodeListener.waitForAuthorization(
      state,
      async () => {
        await authURLHandler(authUrl)
        if (!options?.skipBrowserOpen) {
          await openBrowser(authUrl)
        }
      },
    )

    this.authCodeListener.handleSuccessRedirect(
      [],
      handleCodexSuccessPage,
    )

    try {
      const tokens = await exchangeCodexCodeForTokens({
        authorizationCode,
        codeVerifier: this.codeVerifier,
        redirectUri,
      })

      const result = saveCodexChatgptTokens({
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      })
      if (result.error) {
        throw result.error
      }
    } catch (error) {
      this.authCodeListener.handleErrorRedirect()
      throw error
    } finally {
      this.cleanup()
    }
  }

  cleanup(): void {
    this.authCodeListener?.close()
    this.authCodeListener = null
  }
}
