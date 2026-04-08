import type { Command } from '../../commands.js'
import { hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getModelProviderKind } from '../../utils/model/providerMode.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description:
      getModelProviderKind() === 'codex'
        ? 'Sign in with your Codex account'
        : hasAnthropicApiKeyAuth()
          ? 'Switch Anthropic accounts'
          : 'Sign in with your Anthropic account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
