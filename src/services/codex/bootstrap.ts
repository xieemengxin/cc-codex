import {
  getCodexAccountStatus,
  isCodexWorkspacePlan,
} from '../../utils/codex/auth.js'
import { fetchCodexCloudRequirements } from '../../utils/codex/cloudRequirements.js'
import { fetchCodexModels } from '../../utils/codex/models.js'
import { fetchCodexRateLimits } from '../../utils/codex/rateLimits.js'
import { logForDebugging } from '../../utils/debug.js'

export async function fetchCodexBootstrapData(): Promise<void> {
  const status = getCodexAccountStatus()
  if (!status.loggedIn) {
    logForDebugging('[codex-bootstrap] Skipped: not logged in')
    return
  }

  const isChatgptAuth =
    status.authMode === 'chatgpt' || status.authMode === 'chatgpt_auth_tokens'

  const tasks: Promise<unknown>[] = [fetchCodexModels()]

  if (isChatgptAuth) {
    tasks.push(fetchCodexRateLimits())
    if (isCodexWorkspacePlan(status.planType)) {
      tasks.push(fetchCodexCloudRequirements())
    }
  }

  const results = await Promise.allSettled(tasks)
  for (const result of results) {
    if (result.status === 'rejected') {
      logForDebugging(
        `[codex-bootstrap] prefetch failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        { level: 'warn' },
      )
    }
  }
}
