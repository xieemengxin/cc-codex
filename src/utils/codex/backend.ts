import { getResolvedCodexProvider } from './provider.js'

export function getCodexBackendApiBaseUrl(): string {
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

  return baseUrl.replace(/\/$/, '')
}
