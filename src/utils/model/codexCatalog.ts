import type {
  CodexReasoningEffort,
  CodexReasoningSummary,
  CodexVerbosity,
} from '../codex/config.js'
import {
  getCachedCodexModelCatalog,
  getCachedCodexModelDefinition,
} from '../codex/models.js'
import type { ModelOption } from './modelOptions.js'

export type CodexModelDefinition = {
  id: string
  label: string
  description: string
  isDefault?: boolean
  defaultReasoningEffort: CodexReasoningEffort
  supportedReasoningEfforts: CodexReasoningEffort[]
  contextWindow?: number
  autoCompactTokenLimit?: number
  supportsParallelToolCalls?: boolean
  supportsReasoningSummaries?: boolean
  defaultReasoningSummary?: CodexReasoningSummary
  supportsVerbosity?: boolean
  defaultVerbosity?: CodexVerbosity
}

export const DEFAULT_CODEX_MODEL = 'gpt-5.4'
export const DEFAULT_CODEX_CONTEXT_WINDOW = 272_000

const GPT5_REASONING_EFFORTS: CodexReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

export const CODEX_MODELS: readonly CodexModelDefinition[] = [
  {
    id: 'gpt-5.3-codex',
    label: 'gpt-5.3-codex',
    description: 'Latest frontier agentic coding model.',
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT5_REASONING_EFFORTS,
    contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: 'auto',
    supportsVerbosity: true,
    defaultVerbosity: 'low',
  },
  {
    id: 'gpt-5.4',
    label: 'gpt-5.4',
    description: 'Latest frontier agentic coding model.',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT5_REASONING_EFFORTS,
    contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: 'auto',
    supportsVerbosity: true,
    defaultVerbosity: 'low',
  },
  {
    id: 'gpt-5.2-codex',
    label: 'gpt-5.2-codex',
    description: 'Frontier agentic coding model.',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT5_REASONING_EFFORTS,
    contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: 'auto',
    supportsVerbosity: false,
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'gpt-5.1-codex-max',
    description: 'Codex-optimized flagship for deep and fast reasoning.',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT5_REASONING_EFFORTS,
    contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
    supportsParallelToolCalls: false,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: 'auto',
    supportsVerbosity: false,
  },
  {
    id: 'gpt-5.2',
    label: 'gpt-5.2',
    description:
      'Latest frontier model with improvements across knowledge, reasoning and coding',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: GPT5_REASONING_EFFORTS,
    contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: 'auto',
    supportsVerbosity: true,
    defaultVerbosity: 'low',
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'gpt-5.1-codex-mini',
    description: 'Optimized for codex. Cheaper, faster, but less capable.',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['medium', 'high'],
    contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
    supportsParallelToolCalls: false,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: 'auto',
    supportsVerbosity: false,
  },
] as const

export function getCodexModelDefinitions(): CodexModelDefinition[] {
  return [...CODEX_MODELS]
}

export function getCodexModelDefinition(
  model: string | null | undefined,
): CodexModelDefinition | undefined {
  if (!model) return undefined
  const remote = getCachedCodexModelDefinition(model)
  const local = CODEX_MODELS.find(item => item.id === model)

  if (remote && local) {
    return {
      ...local,
      ...remote,
      id: local.id,
      label: remote.label || local.label,
      description: remote.description || local.description,
      supportedReasoningEfforts:
        remote.supportedReasoningEfforts && remote.supportedReasoningEfforts.length > 0
          ? remote.supportedReasoningEfforts
          : local.supportedReasoningEfforts,
    }
  }

  if (remote) {
    return {
      id: remote.id,
      label: remote.label,
      description: remote.description,
      isDefault: remote.isDefault,
      defaultReasoningEffort: remote.defaultReasoningEffort ?? 'medium',
      supportedReasoningEfforts:
        remote.supportedReasoningEfforts ?? GPT5_REASONING_EFFORTS,
      contextWindow: remote.contextWindow,
      autoCompactTokenLimit: remote.autoCompactTokenLimit,
      supportsParallelToolCalls: remote.supportsParallelToolCalls,
      supportsReasoningSummaries: remote.supportsReasoningSummaries,
      defaultReasoningSummary: remote.defaultReasoningSummary,
      supportsVerbosity: remote.supportsVerbosity,
      defaultVerbosity: remote.defaultVerbosity,
    }
  }

  return local
}

export function getCodexModelDisplayName(
  model: string | null | undefined,
): string {
  return getCodexModelDefinition(model)?.label ?? model ?? DEFAULT_CODEX_MODEL
}

export function getCodexDefaultReasoningSummary(
  model: string | null | undefined,
): CodexReasoningSummary | undefined {
  const definition = getCodexModelDefinition(model)
  if (!definition?.supportsReasoningSummaries) {
    return undefined
  }
  return definition.defaultReasoningSummary
}

export function getCodexDefaultVerbosity(
  model: string | null | undefined,
): CodexVerbosity | undefined {
  const definition = getCodexModelDefinition(model)
  if (!definition?.supportsVerbosity) {
    return undefined
  }
  return definition.defaultVerbosity
}

export function getCodexDefaultModel(): string {
  const cachedModels = getCachedCodexModelCatalog()
  const preferredCachedModel =
    cachedModels.find(model => model.isDefault) ??
    cachedModels.find(model => model.id === 'gpt-5.4') ??
    cachedModels[0]

  return (
    preferredCachedModel?.id ??
    CODEX_MODELS.find(model => model.isDefault)?.id ??
    DEFAULT_CODEX_MODEL
  )
}

export function getCodexModelOptions(): ModelOption[] {
  const options = CODEX_MODELS.map(model => ({
    value: model.id,
    label: model.isDefault ? `${model.label} (default)` : model.label,
    description: model.description,
    descriptionForModel: model.description,
  }))

  for (const remote of getCachedCodexModelCatalog()) {
    if (remote.showInPicker === false) {
      continue
    }
    if (options.some(option => option.value === remote.id)) {
      continue
    }
    options.push({
      value: remote.id,
      label: remote.isDefault ? `${remote.label} (default)` : remote.label,
      description: remote.description,
      descriptionForModel: remote.description,
    })
  }

  return options
}
