import { release } from 'os'

export const CODEX_AUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_AUTH_DEFAULT_ISSUER = 'https://auth.openai.com'
export const CODEX_AUTH_DEFAULT_ORIGINATOR = 'codex_cli_rs'
export const CODEX_AUTH_CALLBACK_PATH = '/auth/callback'
export const CODEX_AUTH_CALLBACK_PORT = 1455
export const CODEX_AUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'api.connectors.read',
  'api.connectors.invoke',
] as const

export function getCodexAuthIssuer(): string {
  return (
    process.env.CLAUDE_CODE_CODEX_AUTH_ISSUER?.trim() ||
    CODEX_AUTH_DEFAULT_ISSUER
  ).replace(/\/$/, '')
}

export function getCodexOriginator(): string {
  return (
    process.env.CLAUDE_CODE_CODEX_ORIGINATOR_OVERRIDE?.trim() ||
    CODEX_AUTH_DEFAULT_ORIGINATOR
  )
}

export function getCodexUserAgent(): string {
  const version =
    process.env.CLAUDE_CODE_CODEX_CLIENT_VERSION?.trim() || 'cc-codex-provider'
  const osName =
    process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux'
  const arch = process.arch
  const terminal =
    process.env.TERM_PROGRAM ||
    process.env.TERM ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    'unknown'

  return `${getCodexOriginator()}/${version} (${osName} ${release()}; ${arch}) ${terminal}`
}
