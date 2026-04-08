import { mkdirSync, readFileSync } from 'fs'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { logForDebugging } from '../debug.js'
import { getCodexConfigDir } from './config.js'
import { getCodexRequestHeaders, getResolvedCodexProvider } from './provider.js'
import {
  type CodexReasoningEffort,
  type CodexReasoningSummary,
  type CodexVerbosity,
} from './config.js'
import type { ModelOption } from '../model/modelOptions.js'

export type CachedCodexModelDefinition = {
  id: string
  label: string
  description: string
  isDefault?: boolean
  defaultReasoningEffort?: CodexReasoningEffort
  supportedReasoningEfforts?: CodexReasoningEffort[]
  contextWindow?: number
  autoCompactTokenLimit?: number
  supportsParallelToolCalls?: boolean
  supportsReasoningSummaries?: boolean
  defaultReasoningSummary?: CodexReasoningSummary
  supportsVerbosity?: boolean
  defaultVerbosity?: CodexVerbosity
  showInPicker?: boolean
}

type CachedCodexModelsFile = {
  models: CachedCodexModelDefinition[]
  fetchedAt: number
  etag?: string | null
}

type RemoteModelInfo = {
  slug?: string
  id?: string
  model?: string
  display_name?: string
  name?: string
  description?: string | null
  default_reasoning_level?: CodexReasoningEffort
  supported_reasoning_levels?: Array<{
    effort?: CodexReasoningEffort
  }>
  context_window?: number
  auto_compact_token_limit?: number | null
  supports_parallel_tool_calls?: boolean
  supports_reasoning_summaries?: boolean
  default_reasoning_summary?: CodexReasoningSummary
  support_verbosity?: boolean
  default_verbosity?: CodexVerbosity | null
  is_default?: boolean
  show_in_picker?: boolean
  visibility?: string
}

let cachedCodexModelsFile: CachedCodexModelsFile | null | undefined

function getCodexClientVersion(): string {
  const raw = String(
    (typeof MACRO !== 'undefined' ? MACRO.VERSION : undefined) ??
      process.env.npm_package_version ??
      process.env.CLAUDE_CODE_CODEX_CLIENT_VERSION ??
      '999.0.0',
  )
  const match = raw.match(/\d+\.\d+\.\d+/)
  return match?.[0] ?? '999.0.0'
}

function getCodexModelsCachePath(): string {
  return `${getCodexConfigDir()}/models.json`
}

function readCachedModelsFile(): CachedCodexModelsFile | null {
  try {
    const raw = readFileSync(getCodexModelsCachePath(), 'utf8')
    const parsed = JSON.parse(raw) as CachedCodexModelsFile
    if (!Array.isArray(parsed.models)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeCachedModelsFile(file: CachedCodexModelsFile): void {
  mkdirSync(getCodexConfigDir(), { recursive: true, mode: 0o700 })
  writeFileSyncAndFlush_DEPRECATED(
    getCodexModelsCachePath(),
    `${JSON.stringify(file, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

function normalizeRemoteModelInfo(
  model: RemoteModelInfo,
): CachedCodexModelDefinition | null {
  const id = model.slug ?? model.model ?? model.id
  if (!id || typeof id !== 'string') {
    return null
  }

  const supportedReasoningEfforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
        .map(level => level.effort)
        .filter(
          (effort): effort is CodexReasoningEffort =>
            typeof effort === 'string',
        )
    : undefined

  return {
    id,
    label:
      model.display_name ??
      model.name ??
      model.model ??
      model.slug ??
      model.id ??
      id,
    description: model.description ?? 'Remote Codex model',
    isDefault: model.is_default === true,
    defaultReasoningEffort: model.default_reasoning_level,
    supportedReasoningEfforts,
    contextWindow:
      typeof model.context_window === 'number' ? model.context_window : undefined,
    autoCompactTokenLimit:
      typeof model.auto_compact_token_limit === 'number'
        ? model.auto_compact_token_limit
        : undefined,
    supportsParallelToolCalls:
      typeof model.supports_parallel_tool_calls === 'boolean'
        ? model.supports_parallel_tool_calls
        : undefined,
    supportsReasoningSummaries:
      typeof model.supports_reasoning_summaries === 'boolean'
        ? model.supports_reasoning_summaries
        : undefined,
    defaultReasoningSummary: model.default_reasoning_summary,
    supportsVerbosity:
      typeof model.support_verbosity === 'boolean'
        ? model.support_verbosity
        : undefined,
    defaultVerbosity: model.default_verbosity ?? undefined,
    showInPicker:
      typeof model.show_in_picker === 'boolean'
        ? model.show_in_picker
        : model.visibility === 'list' || model.visibility === undefined,
  }
}

function parseRemoteModelsPayload(payload: unknown): CachedCodexModelDefinition[] {
  const models = (() => {
    if (
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { models?: unknown[] }).models)
    ) {
      return (payload as { models: RemoteModelInfo[] }).models
    }

    if (
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { data?: unknown[] }).data)
    ) {
      return (payload as { data: RemoteModelInfo[] }).data
    }

    return []
  })()

  return models
    .map(normalizeRemoteModelInfo)
    .filter((model): model is CachedCodexModelDefinition => model !== null)
}

export function getCachedCodexModelCatalog(): CachedCodexModelDefinition[] {
  if (cachedCodexModelsFile !== undefined) {
    return cachedCodexModelsFile?.models ?? []
  }

  cachedCodexModelsFile = readCachedModelsFile()
  return cachedCodexModelsFile?.models ?? []
}

export function clearCachedCodexModels(): void {
  cachedCodexModelsFile = undefined
}

export function getCachedCodexModelDefinition(
  model: string | null | undefined,
): CachedCodexModelDefinition | undefined {
  if (!model) return undefined
  return getCachedCodexModelCatalog().find(item => item.id === model)
}

export function getCachedCodexModelOptions(): ModelOption[] {
  return getCachedCodexModelCatalog()
    .filter(model => model.showInPicker !== false)
    .map(model => ({
      value: model.id,
      label: model.isDefault ? `${model.label} (default)` : model.label,
      description: model.description,
      descriptionForModel: model.description,
    }))
}

export async function fetchCodexModels(): Promise<CachedCodexModelsFile> {
  const headers = await getCodexRequestHeaders()
  const provider = getResolvedCodexProvider()
  const modelsUrl = `${provider.baseUrl.replace(/\/$/, '')}/models?client_version=${encodeURIComponent(getCodexClientVersion())}`

  const response = await fetch(modelsUrl, {
    method: 'GET',
    headers,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Failed to fetch Codex models (${response.status}): ${body || response.statusText}`,
    )
  }

  const payload = (await response.json()) as unknown
  const file: CachedCodexModelsFile = {
    models: parseRemoteModelsPayload(payload),
    fetchedAt: Date.now(),
    etag: response.headers.get('etag'),
  }

  writeCachedModelsFile(file)
  cachedCodexModelsFile = file

  logForDebugging(
    `[codex-models] fetched ${file.models.length} remote models from backend`,
  )

  return file
}
