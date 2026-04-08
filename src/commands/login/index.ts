import type { Command } from '../../commands.js'
import { hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getAPIProvider } from '../../utils/model/providers.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description:
      getAPIProvider() === 'codex'
        ? 'Sign in with your Codex account'
        : getAPIProvider() === 'openai'
          ? 'Configure your OpenAI-compatible provider'
        : hasAnthropicApiKeyAuth()
          ? 'Switch Anthropic accounts'
          : 'Sign in with your Anthropic account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
