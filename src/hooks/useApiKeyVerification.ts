import { useCallback, useEffect, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { verifyApiKey } from '../services/api/claude.js'
import { useAppState } from '../state/AppState.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
} from '../utils/auth.js'
import {
  getCodexBearerToken,
  refreshCodexAuthIfNeeded,
} from '../utils/codex/auth.js'
import {
  getAPIProvider,
  getAPIProviderForModelType,
} from '../utils/model/providers.js'

export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

export function useApiKeyVerification(): ApiKeyVerificationResult {
  const authVersion = useAppState(s => s.authVersion)
  const modelType = useAppState(s => s.settings.modelType)
  const [status, setStatus] = useState<VerificationStatus>(() => {
    const provider =
      getAPIProviderForModelType(modelType) ?? getAPIProvider()
    if (provider === 'codex') {
      return getCodexBearerToken() ? 'valid' : 'missing'
    }
    if (provider === 'openai') {
      return process.env.OPENAI_API_KEY?.trim() ? 'valid' : 'missing'
    }
    if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) {
      return 'valid'
    }
    // Use skipRetrievingKeyFromApiKeyHelper to avoid executing apiKeyHelper
    // before trust dialog is shown (security: prevents RCE via settings.json)
    const { key, source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    // If apiKeyHelper is configured, we have a key source even though we
    // haven't executed it yet - return 'loading' to indicate we'll verify later
    if (key || source === 'apiKeyHelper') {
      return 'loading'
    }
    return 'missing'
  })
  const [error, setError] = useState<Error | null>(null)

  const verify = useCallback(async (): Promise<void> => {
    const provider =
      getAPIProviderForModelType(modelType) ?? getAPIProvider()
    if (provider === 'codex') {
      try {
        await refreshCodexAuthIfNeeded()
        setStatus(getCodexBearerToken() ? 'valid' : 'missing')
        setError(null)
        return
      } catch (error) {
        setError(error as Error)
        setStatus('error')
        return
      }
    }
    if (provider === 'openai') {
      setStatus(process.env.OPENAI_API_KEY?.trim() ? 'valid' : 'missing')
      setError(null)
      return
    }

    if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) {
      setStatus('valid')
      return
    }
    // Warm the apiKeyHelper cache (no-op if not configured), then read from
    // all sources. getAnthropicApiKeyWithSource() reads the now-warm cache.
    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    const { key: apiKey, source } = getAnthropicApiKeyWithSource()
    if (!apiKey) {
      if (source === 'apiKeyHelper') {
        setStatus('error')
        setError(new Error('API key helper did not return a valid key'))
        return
      }
      const newStatus = 'missing'
      setStatus(newStatus)
      return
    }

    try {
      const isValid = await verifyApiKey(apiKey, false)
      const newStatus = isValid ? 'valid' : 'invalid'
      setStatus(newStatus)
      return
    } catch (error) {
      // This happens when there an error response from the API but it's not an invalid API key error
      // In this case, we still mark the API key as invalid - but we also log the error so we can
      // display it to the user to be more helpful
      setError(error as Error)
      const newStatus = 'error'
      setStatus(newStatus)
      return
    }
  }, [modelType])

  useEffect(() => {
    void verify()
  }, [authVersion, modelType, verify])

  return {
    status,
    reverify: verify,
    error,
  }
}
