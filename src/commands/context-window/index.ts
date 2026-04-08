import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const contextWindow = {
  type: 'local-jsx',
  name: 'context-window',
  description: 'Set Codex context window override',
  availability: ['codex'],
  argumentHint: '[default|token_count]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./context-window.js'),
} satisfies Command

export default contextWindow
