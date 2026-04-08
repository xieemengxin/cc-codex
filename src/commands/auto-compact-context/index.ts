import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const autoCompactContext = {
  type: 'local-jsx',
  name: 'auto-compact-context',
  description: 'Set Codex auto-compact token limit override',
  availability: ['codex'],
  argumentHint: '[default|token_count]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./auto-compact-context.js'),
} satisfies Command

export default autoCompactContext
