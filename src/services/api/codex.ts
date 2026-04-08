import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolUnion,
  BetaUsage as Usage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { randomUUID } from 'crypto'
import type WsWebSocket from 'ws'
import { getSessionId } from '../../bootstrap/state.js'
import type { StreamEvent } from '../../types/message.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'
import { toolToAPISchema } from '../../utils/api.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type {
  Message,
  AssistantMessage,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type { Options as ClaudeOptions } from './claude.js'
import {
  getCodexResponsesUrl,
  getCodexRequestHeaders,
  getResolvedCodexProvider,
} from '../../utils/codex/provider.js'
import { sanitizeJsonSchema } from './openai/convertTools.js'
import { logForDebugging } from '../../utils/debug.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import {
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from '../../utils/proxy.js'
import { getCodexProviderConfigValue } from '../../utils/codex/config.js'
import {
  getCodexAuthMode,
  refreshCodexAuthIfNeeded,
} from '../../utils/codex/auth.js'
import {
  getCodexDefaultReasoningSummary,
  getCodexDefaultVerbosity,
  getCodexModelDefinition,
} from '../../utils/model/codexCatalog.js'
import { mergeCodexRateLimitsFromHeaders } from '../../utils/codex/rateLimits.js'

type ResponsesTextContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

type ResponsesFunctionCallOutputItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

type ResponsesInputItem =
  | {
      type: 'message'
      role: 'user' | 'assistant' | 'developer'
      content: ResponsesTextContent[]
    }
  | {
      type: 'function_call'
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string | ResponsesFunctionCallOutputItem[]
    }

type ResponsesApiRequest = {
  model: string
  instructions: string
  input: ResponsesInputItem[]
  tools: Array<Record<string, unknown>>
  tool_choice: string
  parallel_tool_calls: boolean
  reasoning?: {
    effort?: string
    summary?: string
  }
  stream: boolean
  store: boolean
  include: string[]
  service_tier?: 'priority' | 'flex'
  prompt_cache_key?: string
  text?: {
    verbosity?: 'low' | 'medium' | 'high'
    format?: {
      type: 'json_schema'
      strict: boolean
      schema: unknown
      name: string
    }
  }
}

type ResponsesWebSocketRequest = {
  type: 'response.create'
} & ResponsesApiRequest

type ResponsesStreamEvent = {
  type?: string
  item?: Record<string, unknown>
  delta?: string
  response?: Record<string, unknown>
  summary_index?: number
  content_index?: number
}

type ResponsesErrorPayload = {
  error?: {
    code?: string
    message?: string
  }
}

type ResponsesWrappedWebSocketErrorEvent = {
  type?: string
  status?: number
  status_code?: number
  error?: {
    code?: string
    message?: string
  }
}

type ResponsesCompletedUsage = {
  input_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens?: number
  output_tokens_details?: {
    reasoning_tokens?: number
  }
  total_tokens?: number
}

const TEXT_BLOCK_INDEX = 0
const TOOL_BLOCK_INDEX_BASE = 100
const REASONING_SUMMARY_BLOCK_INDEX_BASE = 1_000
const REASONING_CONTENT_BLOCK_INDEX_BASE = 2_000
const RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE =
  'responses_websockets=2026-02-06'
const RESPONSES_INCLUDE_TIMING_METRICS_HEADER =
  'x-responsesapi-include-timing-metrics'

type WebSocketLike = {
  close(): void
  send(data: string): void
}

type CodexWebSocketQueueItem =
  | { type: 'message'; data: string }
  | { type: 'error'; error: Error }
  | { type: 'close'; code?: number; reason?: string }

function wrapCodexWebSocketRequest(
  request: ResponsesApiRequest,
): ResponsesWebSocketRequest {
  return {
    type: 'response.create',
    ...request,
  }
}

function parseCodexWrappedWebSocketError(
  payload: string,
): Error | null {
  let parsed: ResponsesWrappedWebSocketErrorEvent
  try {
    parsed = JSON.parse(payload) as ResponsesWrappedWebSocketErrorEvent
  } catch {
    return null
  }

  if (parsed.type !== 'error') {
    return null
  }

  const code = parsed.error?.code
  const message =
    parsed.error?.message?.trim() ||
    (typeof parsed.status === 'number'
      ? `Codex websocket error (${parsed.status})`
      : typeof parsed.status_code === 'number'
        ? `Codex websocket error (${parsed.status_code})`
        : 'Codex websocket error')

  return new Error(code ? `${message} [${code}]` : message)
}

function getSubagentHeader(querySource: string): string | undefined {
  if (querySource === 'compact') return 'compact'
  if (querySource === 'review') return 'review'
  if (querySource.startsWith('agent:')) return 'collab_spawn'
  return undefined
}

function toDataUrl(
  block: Extract<BetaContentBlockParam, { type: 'image' }>,
): string | null {
  if (block.source.type !== 'base64') {
    return null
  }
  return `data:${block.source.media_type};base64,${block.source.data}`
}

function stringifyToolResultContent(
  content:
    | string
    | Array<{ type: string; text?: string; [key: string]: unknown }>,
): string {
  if (typeof content === 'string') {
    return content
  }

  const text = content
    .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')

  return text
}

function convertToolResultContent(
  content:
    | string
    | Array<{ type: string; text?: string; [key: string]: unknown }>
    | undefined,
): string | ResponsesFunctionCallOutputItem[] {
  if (typeof content === 'string' || content === undefined) {
    return content ?? ''
  }

  const structured: ResponsesFunctionCallOutputItem[] = []
  let sawImage = false

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      structured.push({
        type: 'input_text',
        text: block.text,
      })
      continue
    }

    if (block.type === 'image') {
      const imageUrl = toDataUrl(
        block as Extract<BetaContentBlockParam, { type: 'image' }>,
      )
      if (imageUrl) {
        sawImage = true
        structured.push({
          type: 'input_image',
          image_url: imageUrl,
        })
      }
      continue
    }

    if (typeof block.text === 'string' && block.text) {
      structured.push({
        type: 'input_text',
        text: block.text,
      })
    }
  }

  if (sawImage) {
    return structured
  }

  const text = structured
    .filter(
      (item): item is Extract<ResponsesFunctionCallOutputItem, { type: 'input_text' }> =>
        item.type === 'input_text',
    )
    .map(item => item.text)
    .join('\n')

  return text || stringifyToolResultContent(content)
}

function convertMessageToResponsesInput(message: Message): ResponsesInputItem[] {
  if (message.type === 'assistant') {
    const content = message.message.content
    if (!Array.isArray(content)) {
      return [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: String(content ?? '') }],
        },
      ]
    }

    const items: ResponsesInputItem[] = []
    const assistantText: Array<{ type: 'output_text'; text: string }> = []

    for (const block of content) {
      if (block.type === 'text') {
        assistantText.push({ type: 'output_text', text: block.text })
        continue
      }

      if (block.type === 'tool_use') {
        if (assistantText.length > 0) {
          items.push({
            type: 'message',
            role: 'assistant',
            content: [...assistantText],
          })
          assistantText.length = 0
        }

        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        })
      }
    }

    if (assistantText.length > 0) {
      items.push({
        type: 'message',
        role: 'assistant',
        content: assistantText,
      })
    }

    return items
  }

  if (message.type !== 'user') {
    return []
  }

  const content = message.message.content
  if (!Array.isArray(content)) {
    return [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: String(content ?? '') }],
      },
    ]
  }

  const items: ResponsesInputItem[] = []
  const userBlocks: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string }
  > = []

  for (const block of content) {
    if (block.type === 'tool_result') {
      if (userBlocks.length > 0) {
        items.push({
          type: 'message',
          role: 'user',
          content: [...userBlocks],
        })
        userBlocks.length = 0
      }

      items.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: convertToolResultContent(
          block.content as ToolResultBlockParam['content'],
        ),
      })
      continue
    }

    if (block.type === 'text') {
      userBlocks.push({ type: 'input_text', text: block.text })
      continue
    }

    if (block.type === 'image') {
      const imageUrl = toDataUrl(block)
      if (imageUrl) {
        userBlocks.push({ type: 'input_image', image_url: imageUrl })
      }
    }
  }

  if (userBlocks.length > 0) {
    items.push({
      type: 'message',
      role: 'user',
      content: userBlocks,
    })
  }

  return items
}

async function buildResponsesTools(
  tools: Tools,
  options: ClaudeOptions,
): Promise<Array<Record<string, unknown>>> {
  const provider = getResolvedCodexProvider()

  return Promise.all(
    tools.map(async tool => {
      const schema = (await toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
      })) as BetaToolUnion & {
        name: string
        description: string
        input_schema: unknown
        strict?: boolean
      }
      const useStrictSchema =
        schema.strict === true ||
        (tool.strict === true && provider.info.supports_strict_tools === true)

      return {
        type: 'function',
        name: schema.name,
        description: schema.description,
        parameters: sanitizeJsonSchema(
          (schema.input_schema as Record<string, unknown>) ?? {
            type: 'object',
            properties: {},
          },
          { strict: useStrictSchema },
        ),
        ...(useStrictSchema ? { strict: true } : {}),
      }
    }),
  )
}

function resolveReasoningSummary(model: string): string | undefined {
  const definition = getCodexModelDefinition(model)
  if (definition && !definition.supportsReasoningSummaries) {
    return undefined
  }

  const configured = getCodexProviderConfigValue('model_reasoning_summary')
  if (configured === 'none') {
    return undefined
  }

  const resolved = configured ?? getCodexDefaultReasoningSummary(model)
  return resolved === 'none' ? undefined : resolved
}

function resolveReasoningEffort(
  model: string,
  effortValue: ClaudeOptions['effortValue'],
): string {
  if (typeof effortValue === 'string') {
    return effortValue
  }

  return (
    getCodexProviderConfigValue('model_reasoning_effort') ??
    getCodexModelDefinition(model)?.defaultReasoningEffort ??
    'medium'
  )
}

function resolveVerbosity(model: string): 'low' | 'medium' | 'high' | undefined {
  const definition = getCodexModelDefinition(model)
  if (definition && !definition.supportsVerbosity) {
    return undefined
  }

  const configured = getCodexProviderConfigValue('model_verbosity')
  return configured ?? getCodexDefaultVerbosity(model)
}

function resolveParallelToolCalls(
  model: string,
  toolChoice: ClaudeOptions['toolChoice'],
): boolean {
  const modelSupportsParallel =
    getCodexModelDefinition(model)?.supportsParallelToolCalls ?? true

  if (!modelSupportsParallel) {
    return false
  }

  return !(
    'disable_parallel_tool_use' in (toolChoice ?? {}) &&
    toolChoice?.disable_parallel_tool_use === true
  )
}

function resolveServiceTier(
  options: ClaudeOptions,
): 'priority' | 'flex' | undefined {
  if (options.fastMode) {
    return 'priority'
  }

  const configured = getCodexProviderConfigValue('service_tier')
  if (configured === 'fast') {
    return 'priority'
  }
  if (configured === 'flex') {
    return 'flex'
  }

  return undefined
}

function buildResponsesRequest(params: {
  messages: Message[]
  systemPrompt: SystemPrompt
  tools: Tools
  options: ClaudeOptions
}): Promise<ResponsesApiRequest> {
  const { messages, systemPrompt, tools, options } = params

  return buildResponsesTools(tools, options).then(toolSchemas => {
    const effort = resolveReasoningEffort(options.model, options.effortValue)
    const summary = resolveReasoningSummary(options.model)
    const verbosity = resolveVerbosity(options.model)
    const serviceTier = resolveServiceTier(options)
    const parallelToolCalls = resolveParallelToolCalls(
      options.model,
      options.toolChoice,
    )
    const reasoning =
      typeof effort === 'string' || typeof summary === 'string'
        ? {
            ...(typeof effort === 'string' ? { effort } : {}),
            ...(typeof summary === 'string' ? { summary } : {}),
          }
        : undefined

    return {
      model: options.model,
      instructions: systemPrompt.join('\n\n'),
      input: messages.flatMap(convertMessageToResponsesInput),
      tools: toolSchemas,
      tool_choice:
        options.toolChoice &&
        (options.toolChoice as BetaToolChoiceTool | BetaToolChoiceAuto).type ===
          'tool'
          ? (options.toolChoice as BetaToolChoiceTool).name
          : 'auto',
      parallel_tool_calls: parallelToolCalls,
      ...(reasoning ? { reasoning } : {}),
      stream: true,
      store: false,
      include: reasoning ? ['reasoning.encrypted_content'] : [],
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      prompt_cache_key: getSessionId(),
      ...(verbosity
        ? {
            text: {
              verbosity,
            },
          }
        : {}),
    }
  })
}

async function* iterateSse(
  response: Response,
): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) {
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const emitChunk = async function* (
    chunk: string,
  ): AsyncGenerator<{ event: string; data: string }> {
    const lines = chunk.split(/\r?\n/)
    let event = ''
    const dataLines: string[] = []

    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    if (event && dataLines.length > 0) {
      yield { event, data: dataLines.join('\n') }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')

    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      yield* emitChunk(chunk)

      boundary = buffer.indexOf('\n\n')
    }
  }

  if (buffer.trim().length > 0) {
    yield* emitChunk(buffer)
  }
}

function getCodexResponsesWebSocketUrl(): string {
  const url = new URL(getCodexResponsesUrl())
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  }
  return url.toString()
}

function shouldUseCodexWebSocketTransport(): boolean {
  const provider = getResolvedCodexProvider()
  return provider.info.supports_websockets === true
}

async function connectCodexWebSocket(
  url: string,
  headers: Record<string, string>,
): Promise<WebSocketLike> {
  const websocketHeaders: Record<string, string> = {
    ...headers,
    'OpenAI-Beta': RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE,
    [RESPONSES_INCLUDE_TIMING_METRICS_HEADER]: 'true',
  }

  if (typeof Bun !== 'undefined') {
    return await new Promise<WebSocketLike>((resolve, reject) => {
      const ws = new globalThis.WebSocket(url, {
        headers: websocketHeaders,
        proxy: getWebSocketProxyUrl(url),
        tls: getWebSocketTLSOptions() || undefined,
      } as unknown as string[])

      const handleOpen = () => {
        ws.removeEventListener('open', handleOpen)
        ws.removeEventListener('error', handleError)
        resolve(ws as unknown as WebSocketLike)
      }

      const handleError = () => {
        ws.removeEventListener('open', handleOpen)
        ws.removeEventListener('error', handleError)
        reject(new Error('Codex websocket connection failed'))
      }

      ws.addEventListener('open', handleOpen)
      ws.addEventListener('error', handleError)
    })
  }

  const { default: WS } = await import('ws')

  return await new Promise<WebSocketLike>((resolve, reject) => {
    const ws = new WS(url, {
      headers: websocketHeaders,
      agent: getWebSocketProxyAgent(url),
      perMessageDeflate: true,
      ...getWebSocketTLSOptions(),
    })

    const handleOpen = () => {
      ws.off('open', handleOpen)
      ws.off('error', handleError)
      resolve(ws as unknown as WebSocketLike)
    }

    const handleError = (error: unknown) => {
      ws.off('open', handleOpen)
      ws.off('error', handleError)
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    ws.on('open', handleOpen)
    ws.on('error', handleError)
  })
}

async function* iterateWebSocket(
  request: ResponsesApiRequest,
  headers: Record<string, string>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const provider = getResolvedCodexProvider()
  const timeoutMs = provider.info.websocket_connect_timeout_ms ?? 15_000
  const queue: CodexWebSocketQueueItem[] = []
  let resolveNext:
    | ((item: CodexWebSocketQueueItem | null) => void)
    | null = null
  let ws: WebSocketLike | null = null
  let closed = false

  const push = (item: CodexWebSocketQueueItem | null) => {
    if (resolveNext) {
      const currentResolve = resolveNext
      resolveNext = null
      currentResolve(item)
      return
    }
    if (item) {
      queue.push(item)
    }
  }

  const nextItem = async (): Promise<CodexWebSocketQueueItem | null> => {
    if (queue.length > 0) {
      return queue.shift() ?? null
    }

    return await new Promise(resolve => {
      resolveNext = resolve
    })
  }

  const connectPromise = connectCodexWebSocket(
    getCodexResponsesWebSocketUrl(),
    headers,
  )

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Codex websocket connect timeout'))
    }, timeoutMs)
    connectPromise.finally(() => clearTimeout(timer)).catch(() => {})
  })

  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Codex websocket aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    connectPromise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {})
  })

  try {
    ws = await Promise.race([connectPromise, timeoutPromise, abortPromise])

    if (typeof Bun !== 'undefined') {
      const bunWs = ws as unknown as globalThis.WebSocket
      bunWs.addEventListener('message', event => {
        const data =
          typeof event.data === 'string' ? event.data : String(event.data)
        push({ type: 'message', data })
      })
      bunWs.addEventListener('error', () => {
        push({ type: 'error', error: new Error('Codex websocket error') })
      })
      bunWs.addEventListener('close', event => {
        closed = true
        push({ type: 'close', code: event.code, reason: event.reason })
        push(null)
      })
    } else {
      const nodeWs = ws as unknown as WsWebSocket
      nodeWs.on('message', data => {
        const text =
          typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
        push({ type: 'message', data: text })
      })
      nodeWs.on('error', error => {
        push({
          type: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      })
      nodeWs.on('close', (code, reason) => {
        closed = true
        push({
          type: 'close',
          code,
          reason: typeof reason === 'string' ? reason : Buffer.from(reason).toString('utf8'),
        })
        push(null)
      })
    }

    ws.send(JSON.stringify(wrapCodexWebSocketRequest(request)))

    while (!signal.aborted) {
      const item = await nextItem()
      if (!item) {
        break
      }

      if (item.type === 'error') {
        throw item.error
      }

      if (item.type === 'close') {
        if (!closed) {
          continue
        }
        throw new Error(
          `Codex websocket closed before response completion (${item.code ?? 'unknown'}${item.reason ? `: ${item.reason}` : ''})`,
        )
      }

      const wrappedError = parseCodexWrappedWebSocketError(item.data)
      if (wrappedError) {
        throw wrappedError
      }

      let parsed: { type?: unknown }
      try {
        parsed = JSON.parse(item.data) as { type?: unknown }
      } catch {
        continue
      }

      if (typeof parsed.type !== 'string') {
        continue
      }

      yield {
        event: parsed.type,
        data: item.data,
      }

      if (parsed.type === 'response.completed') {
        return
      }
    }
  } finally {
    ws?.close()
  }
}

function extractOutputTextBlocks(
  item: Record<string, unknown>,
): BetaContentBlock[] {
  const content = Array.isArray(item.content) ? item.content : []

  return content
    .map(block => {
      if (
        block &&
        typeof block === 'object' &&
        block.type === 'output_text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return {
          type: 'text' as const,
          text: String((block as { text: string }).text),
        } as BetaContentBlock
      }

      return null
    })
    .filter(Boolean) as BetaContentBlock[]
}

function extractOutputText(item: Record<string, unknown>): string {
  return extractOutputTextBlocks(item)
    .map(block => ('text' in block ? String(block.text ?? '') : ''))
    .join('')
}

function createToolUseBlock(item: Record<string, unknown>): ToolUseBlock {
  const rawArguments = String(item.arguments ?? '{}')
  let parsedArguments: Record<string, unknown> = {}

  try {
    parsedArguments = JSON.parse(rawArguments)
  } catch {
    parsedArguments = {}
  }

  return {
    type: 'tool_use',
    id: String(item.call_id ?? ''),
    name: String(item.name ?? ''),
    input: parsedArguments,
  } as unknown as ToolUseBlock
}

function extractReasoningDisplayText(
  item: Record<string, unknown>,
): string | null {
  const summary = Array.isArray(item.summary)
    ? item.summary
        .map(block => {
          if (
            block &&
            typeof block === 'object' &&
            block.type === 'summary_text' &&
            typeof (block as { text?: unknown }).text === 'string'
          ) {
            return String((block as { text: string }).text)
          }
          return ''
        })
        .filter(Boolean)
    : []

  if (summary.length > 0) {
    return summary.join('\n')
  }

  const content = Array.isArray(item.content)
    ? item.content
        .map(block => {
          if (
            block &&
            typeof block === 'object' &&
            typeof (block as { text?: unknown }).text === 'string'
          ) {
            return String((block as { text: string }).text)
          }
          return ''
        })
        .filter(Boolean)
    : []

  return content.length > 0 ? content.join('\n') : null
}

function createAssistantMessageFromResponseItem(
  item: Record<string, unknown>,
  usage: Usage,
): AssistantMessage | null {
  if (item.type === 'message') {
    const content = extractOutputTextBlocks(item)
    return content.length > 0 ? createAssistantMessage({ content, usage }) : null
  }

  if (item.type === 'function_call') {
    return createAssistantMessage({
      content: [createToolUseBlock(item) as unknown as BetaContentBlock],
      usage,
    })
  }

  if (item.type === 'reasoning') {
    const text = extractReasoningDisplayText(item)
    if (!text) {
      return null
    }

    return createAssistantMessage({
      content: [
        {
          type: 'thinking',
          thinking: text,
          signature: '',
        } as unknown as BetaContentBlock,
      ],
      usage,
    })
  }

  return null
}

function resolveUsageServiceTier(
  actualServiceTier: unknown,
  requestedServiceTier: ResponsesApiRequest['service_tier'],
): 'standard' | 'priority' | 'flex' | 'auto' {
  if (
    actualServiceTier === 'priority' ||
    actualServiceTier === 'flex' ||
    actualServiceTier === 'auto'
  ) {
    return actualServiceTier
  }

  if (actualServiceTier === 'default' || actualServiceTier === 'standard') {
    return 'standard'
  }

  if (requestedServiceTier === 'priority' || requestedServiceTier === 'flex') {
    return requestedServiceTier
  }
  return 'standard'
}

function createUsageFromCompletedResponse(params: {
  completedUsage?: ResponsesCompletedUsage
  serviceTier?: ResponsesApiRequest['service_tier']
  actualServiceTier?: unknown
}): Usage {
  const cachedInputTokens =
    params.completedUsage?.input_tokens_details?.cached_tokens ?? 0
  const totalInputTokens = params.completedUsage?.input_tokens ?? 0
  const directInputTokens = Math.max(0, totalInputTokens - cachedInputTokens)

  return {
    input_tokens: directInputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedInputTokens,
    output_tokens: params.completedUsage?.output_tokens ?? 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: resolveUsageServiceTier(
      params.actualServiceTier,
      params.serviceTier,
    ),
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  } as unknown as Usage
}

function createContentBlockStartEvent(
  index: number,
  contentBlock: Record<string, unknown>,
): StreamEvent {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    },
  }
}

function createContentBlockDeltaEvent(
  index: number,
  delta: Record<string, unknown>,
): StreamEvent {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta,
    },
  }
}

function createTextStartEvent(): StreamEvent {
  return createContentBlockStartEvent(TEXT_BLOCK_INDEX, {
    type: 'text',
    text: '',
  })
}

function createTextDeltaEvent(delta: string): StreamEvent {
  return createContentBlockDeltaEvent(TEXT_BLOCK_INDEX, {
    type: 'text_delta',
    text: delta,
  })
}

function createThinkingStartEvent(index: number): StreamEvent {
  return createContentBlockStartEvent(index, {
    type: 'thinking',
    thinking: '',
    signature: '',
  })
}

function createThinkingDeltaEvent(index: number, delta: string): StreamEvent {
  return createContentBlockDeltaEvent(index, {
    type: 'thinking_delta',
    thinking: delta,
  })
}

function createToolUseStartEvent(index: number, item: Record<string, unknown>): StreamEvent {
  return createContentBlockStartEvent(index, {
    type: 'tool_use',
    id: String(item.call_id ?? ''),
    name: String(item.name ?? ''),
    input: '',
  })
}

function createToolUseDeltaEvent(index: number, input: string): StreamEvent {
  return createContentBlockDeltaEvent(index, {
    type: 'input_json_delta',
    partial_json: input,
  })
}

function createMessageStartEvent(
  usage: Usage,
  ttftMs?: number,
): StreamEvent & { ttftMs?: number } {
  return {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: randomUUID(),
        usage,
      },
    },
    ...(ttftMs !== undefined ? { ttftMs } : {}),
  }
}

function createMessageDeltaEvent(params: {
  usage: Usage
  stopReason: 'end_turn' | 'tool_use'
}): StreamEvent {
  return {
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: {
        stop_reason: params.stopReason,
      },
      usage: params.usage,
    },
  }
}

function createMessageStopEvent(): StreamEvent {
  return {
    type: 'stream_event',
    event: {
      type: 'message_stop',
    },
  }
}

function getFunctionCallBlockIndex(
  callId: string,
  indices: Map<string, number>,
): number {
  const existing = indices.get(callId)
  if (existing !== undefined) {
    return existing
  }

  const nextIndex = TOOL_BLOCK_INDEX_BASE + indices.size
  indices.set(callId, nextIndex)
  return nextIndex
}

export async function* queryCodexModelWithStreaming(params: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: ClaudeOptions
}): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal, options } = params

  try {
    const start = Date.now()
    const request = await buildResponsesRequest({
      messages: normalizeMessagesForAPI(messages, tools),
      systemPrompt,
      tools,
      options,
    })
    const baseUsage = createUsageFromCompletedResponse({
      serviceTier: request.service_tier,
    })
    const fetchImpl = options.fetchOverride ?? fetch
    const provider = getResolvedCodexProvider()
    const headers = await getCodexRequestHeaders({
      subagent: getSubagentHeader(options.querySource),
    })

    const authRequired =
      provider.id === 'openai' || provider.info.requires_openai_auth === true
    if (authRequired && !headers.Authorization) {
      throw new Error(
        'Not logged in to Codex. Run `claude auth login --provider codex` or configure an API key before sending requests.',
      )
    }

    const makeRequest = async () => {
      return fetchImpl(getCodexResponsesUrl(), {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          [RESPONSES_INCLUDE_TIMING_METRICS_HEADER]: 'true',
          ...headers,
        },
        body: JSON.stringify(request),
        signal,
      })
    }

    const yieldedAssistantMessages: AssistantMessage[] = []
    const startedThinkingBlocks = new Set<number>()
    const startedFunctionCalls = new Set<string>()
    const functionCallIndices = new Map<string, number>()
    let emittedMessageStart = false
    let emittedTextStart = false
    let completed = false
    let sawToolCall = false
    let usedWebSocket = false
    let websocketSawAnyEvent = false

    const handleEventRecord = async function* (
      record: { event: string; data: string },
    ): AsyncGenerator<
      StreamEvent | AssistantMessage | SystemAPIErrorMessage,
      void
    > {
      const { event, data } = record
      if (!emittedMessageStart) {
        emittedMessageStart = true
        yield createMessageStartEvent(baseUsage, Date.now() - start)
      }

      let parsed: ResponsesStreamEvent

      try {
        parsed = JSON.parse(data) as ResponsesStreamEvent
      } catch {
        return
      }

      if (event === 'response.output_text.delta' && parsed.delta) {
        if (!emittedTextStart) {
          emittedTextStart = true
          yield createTextStartEvent()
        }
        yield createTextDeltaEvent(parsed.delta)
        return
      }

      if (event === 'error') {
        const payload = parsed as ResponsesErrorPayload & {
          status?: number
          message?: string
        }
        const message =
          payload.error?.message ??
          payload.error?.code ??
          payload.message ??
          'Codex websocket error'
        yield createAssistantAPIErrorMessage({
          content: `Codex websocket error: ${message}`,
        })
        return
      }

      if (event === 'codex.rate_limits') {
        return
      }

      if (event === 'response.reasoning_summary_part.added') {
        if (typeof parsed.summary_index === 'number') {
          const blockIndex =
            REASONING_SUMMARY_BLOCK_INDEX_BASE + parsed.summary_index
          if (!startedThinkingBlocks.has(blockIndex)) {
            startedThinkingBlocks.add(blockIndex)
            yield createThinkingStartEvent(blockIndex)
          }
        }
        return
      }

      if (
        event === 'response.reasoning_summary_text.delta' &&
        typeof parsed.delta === 'string' &&
        typeof parsed.summary_index === 'number'
      ) {
        const blockIndex =
          REASONING_SUMMARY_BLOCK_INDEX_BASE + parsed.summary_index
        if (!startedThinkingBlocks.has(blockIndex)) {
          startedThinkingBlocks.add(blockIndex)
          yield createThinkingStartEvent(blockIndex)
        }
        yield createThinkingDeltaEvent(blockIndex, parsed.delta)
        return
      }

      if (
        event === 'response.reasoning_text.delta' &&
        typeof parsed.delta === 'string' &&
        typeof parsed.content_index === 'number'
      ) {
        const blockIndex =
          REASONING_CONTENT_BLOCK_INDEX_BASE + parsed.content_index
        if (!startedThinkingBlocks.has(blockIndex)) {
          startedThinkingBlocks.add(blockIndex)
          yield createThinkingStartEvent(blockIndex)
        }
        yield createThinkingDeltaEvent(blockIndex, parsed.delta)
        return
      }

      if (
        event === 'response.output_item.added' &&
        parsed.item &&
        parsed.item.type === 'function_call'
      ) {
        const callId = String(parsed.item.call_id ?? '')
        if (callId) {
          const blockIndex = getFunctionCallBlockIndex(callId, functionCallIndices)
          if (!startedFunctionCalls.has(callId)) {
            startedFunctionCalls.add(callId)
            sawToolCall = true
            yield createToolUseStartEvent(blockIndex, parsed.item)
          }
        }
        return
      }

      if (event === 'response.failed') {
        const payload = parsed.response as ResponsesErrorPayload | undefined
        const message =
          payload?.error?.message ??
          payload?.error?.code ??
          'Codex response failed'
        yield createAssistantAPIErrorMessage({
          content: `Codex response failed: ${message}`,
        })
        return
      }

      if (event === 'response.incomplete') {
        const reason =
          typeof parsed.response?.incomplete_details === 'object' &&
          parsed.response?.incomplete_details &&
          'reason' in parsed.response.incomplete_details
            ? String(
                (parsed.response.incomplete_details as { reason?: unknown }).reason ??
                  'unknown',
              )
            : 'unknown'
        yield createAssistantAPIErrorMessage({
          content: `Codex response incomplete: ${reason}`,
        })
        return
      }

      if (
        event === 'response.output_item.done' &&
        parsed.item &&
        typeof parsed.item === 'object'
      ) {
        if (parsed.item.type === 'function_call') {
          const callId = String(parsed.item.call_id ?? '')
          const blockIndex = getFunctionCallBlockIndex(callId, functionCallIndices)
          if (!startedFunctionCalls.has(callId)) {
            startedFunctionCalls.add(callId)
            yield createToolUseStartEvent(blockIndex, parsed.item)
          }

          const rawArguments = String(parsed.item.arguments ?? '')
          if (rawArguments) {
            yield createToolUseDeltaEvent(blockIndex, rawArguments)
          }

          sawToolCall = true
        } else if (parsed.item.type === 'message') {
          const fullText = extractOutputText(parsed.item)
          if (!emittedTextStart && fullText) {
            emittedTextStart = true
            yield createTextStartEvent()
            yield createTextDeltaEvent(fullText)
          }
        }

        const assistantMessage = createAssistantMessageFromResponseItem(
          parsed.item,
          baseUsage,
        )
        if (assistantMessage) {
          yieldedAssistantMessages.push(assistantMessage)
          yield assistantMessage
        }

        return
      }

      if (event === 'response.completed') {
        completed = true
        const completedUsage = parsed.response?.usage as
          | ResponsesCompletedUsage
          | undefined
        const finalUsage = createUsageFromCompletedResponse({
          completedUsage,
          actualServiceTier: parsed.response?.service_tier,
          serviceTier: request.service_tier,
        })
        const stopReason = sawToolCall ? 'tool_use' : 'end_turn'
        const lastAssistant = yieldedAssistantMessages.at(-1)

        if (lastAssistant?.message) {
          lastAssistant.message.usage = finalUsage
          lastAssistant.message.stop_reason = stopReason
        }

        yield createMessageDeltaEvent({
          usage: finalUsage,
          stopReason,
        })
        yield createMessageStopEvent()
        return
      }

      if (event === 'response.done' || event === 'response.created') {
        return
      }

      return
    }

    if (shouldUseCodexWebSocketTransport()) {
      try {
        usedWebSocket = true
        for await (const record of iterateWebSocket(request, headers, signal)) {
          if (
            record.event !== 'response.created' &&
            record.event !== 'response.done' &&
            record.event !== 'codex.rate_limits'
          ) {
            websocketSawAnyEvent = true
          }
          for await (const message of handleEventRecord(record)) {
            yield message
          }
          if (completed) {
            return
          }
        }
      } catch (error) {
        logForDebugging(
          `[codex-websocket] ${websocketSawAnyEvent ? 'stream failed' : 'connect failed'}: ${error instanceof Error ? error.message : String(error)}`,
          { level: websocketSawAnyEvent ? 'error' : 'warn' },
        )
        const canFallbackToHttp =
          !completed &&
          !emittedTextStart &&
          startedThinkingBlocks.size === 0 &&
          startedFunctionCalls.size === 0 &&
          yieldedAssistantMessages.length === 0
        if (websocketSawAnyEvent && !canFallbackToHttp) {
          throw error
        }
      }
    }

    let response = await makeRequest()
    if (response.status === 401 && getCodexAuthMode() === 'chatgpt') {
      await refreshCodexAuthIfNeeded(true)
      response = await makeRequest()
    }

    if (!response.ok) {
      const text = await response.text()
      yield createAssistantAPIErrorMessage({
        content: `Codex API error (${response.status}): ${text || response.statusText}`,
      })
      return
    }

    mergeCodexRateLimitsFromHeaders(response.headers)

    for await (const record of iterateSse(response)) {
      for await (const message of handleEventRecord(record)) {
        yield message
      }
      if (completed) {
        return
      }
    }

    if (!completed && !signal.aborted) {
      yield createAssistantAPIErrorMessage({
        content: usedWebSocket
          ? 'Codex response stream closed before completion'
          : 'Codex response stream closed before completion',
      })
    }
  } catch (error) {
    if (signal.aborted) {
      return
    }

    yield createAssistantAPIErrorMessage({
      content:
        error instanceof Error
          ? `Codex request failed: ${error.message}`
          : 'Codex request failed',
    })
  }
}

export async function queryCodexModelWithoutStreaming(params: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: ClaudeOptions
}): Promise<AssistantMessage> {
  let assistantMessage: AssistantMessage | undefined

  for await (const event of queryCodexModelWithStreaming(params)) {
    if (event.type === 'assistant') {
      assistantMessage = event
    }
  }

  if (!assistantMessage) {
    throw new Error('No assistant message found from Codex provider')
  }

  return assistantMessage
}
