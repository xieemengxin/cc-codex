import { basename, sep } from 'path'
import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  getInvokedSkillsForAgent,
  getSessionId,
  getTurnToolCount,
  getTurnToolDurationMs,
} from '../../bootstrap/state.js'
import { getTotalDuration } from '../../cost-tracker.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useTasksV2 } from '../../hooks/useTasksV2.js'
import { Box, Text } from '@anthropic/ink'
import { extractMcpToolDetails, extractSkillName } from '../../services/analytics/metadata.js'
import { useAppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { getMemoryFiles, type MemoryFileInfo } from '../../utils/claudemd.js'
import { getCodexProviderConfigValue } from '../../utils/codex/config.js'
import { getResolvedCodexProvider } from '../../utils/codex/provider.js'
import {
  type CodexRateLimitWindow,
  fetchCodexRateLimits,
  getCachedCodexRateLimits,
} from '../../utils/codex/rateLimits.js'
import { getDisplayedEffortLevel } from '../../utils/effort.js'
import {
  formatDuration,
  formatResetTime,
  formatSecondsShort,
} from '../../utils/format.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { isFastModeEnabled } from '../../utils/fastMode.js'
import { getUserMessageText } from '../../utils/messages.js'
import { renderModelName } from '../../utils/model/model.js'
import {
  getModelProviderKind,
  getModelProviderLabel,
  isCodexProviderEnabled,
} from '../../utils/model/providerMode.js'
import { ProgressBar } from '../design-system/ProgressBar.js'

type Props = {
  messages: Message[]
  isLoading: boolean
  hidden?: boolean
}

type MemoryStats = {
  claudeMdCount: number
  ruleCount: number
}

type ToolTone = 'cyan' | 'success' | 'magenta' | 'yellow' | undefined

type RecentToolStat = {
  label: string
  count: number
  tone?: ToolTone
}

type TodoProgressItem = {
  status: 'pending' | 'in_progress' | 'completed'
}

const EMPTY_MEMORY_STATS: MemoryStats = {
  claudeMdCount: 0,
  ruleCount: 0,
}

const EMPTY_TODO_PROGRESS_ITEMS: TodoProgressItem[] = []

type HudTurnMetrics = {
  ttftMs?: number
  ttftPendingMs?: number
  turnMs?: number
  toolMs?: number
  modelMs?: number
  toolCount?: number
}

type ApiMetricsMessage = Message & {
  type: 'system'
  subtype: 'api_metrics'
  ttftMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  toolCount?: number
}

export function PromptInputHud({
  messages,
  isLoading,
  hidden = false,
}: Props): React.ReactNode {
  const codexEnabled = isCodexProviderEnabled()
  const isFullscreen = isFullscreenEnvEnabled()
  const sessionId = getSessionId()
  const { columns } = useTerminalSize()
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const effortValue = useAppState(s => s.effortValue)
  const fastMode = useAppState(s => s.fastMode ?? false)
  const tasks = useAppState(s => s.tasks)
  const mcpClients = useAppState(s => s.mcp.clients)
  const sessionHooks = useAppState(s => s.sessionHooks)
  const todosByAgent = useAppState(s => s.todos)
  const tasksV2 = useTasksV2()
  const [memoryStats, setMemoryStats] = useState<MemoryStats>(EMPTY_MEMORY_STATS)
  const [rateLimitState, setRateLimitState] = useState(() => getCachedCodexRateLimits())
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!codexEnabled) {
      return
    }

    let cancelled = false

    void getMemoryFiles()
      .then(files => {
        if (cancelled) return
        setMemoryStats(getMemoryStats(files))
      })
      .catch(() => {
        if (cancelled) return
        setMemoryStats(EMPTY_MEMORY_STATS)
      })

    return () => {
      cancelled = true
    }
  }, [codexEnabled])

  useEffect(() => {
    if (!codexEnabled) {
      return
    }

    let cancelled = false

    void fetchCodexRateLimits()
      .then(next => {
        if (cancelled) return
        setRateLimitState(next)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [codexEnabled])

  useEffect(() => {
    if (!isLoading) {
      return
    }

    const interval = setInterval(() => {
      setNowMs(Date.now())
    }, 500)

    return () => {
      clearInterval(interval)
    }
  }, [isLoading])

  const recentTools = useMemo(() => getRecentToolStats(messages), [messages])
  const turnMetrics = useMemo(
    () => getHudTurnMetrics(messages, isLoading, nowMs),
    [messages, isLoading, nowMs],
  )
  const requestedTier = useMemo(() => getRequestedServiceTierLabel(fastMode), [fastMode])
  const actualTier = useMemo(
    () => getActualServiceTierLabel(messages, isLoading),
    [messages, isLoading],
  )
  const fastEnabledForDisplay = requestedTier === 'fast'

  if (!codexEnabled) {
    return null
  }

  if (hidden && !isFullscreen) {
    return null
  }

  if (hidden) {
    return (
      <Box flexDirection="column">
        <HudRow />
        <HudRow />
        <HudRow />
        <HudRow />
        <HudRow />
      </Box>
    )
  }

  const compact = columns < 120
  const ultraCompact = columns < 95
  const provider = getResolvedCodexProvider()
  const providerLabel = getModelProviderLabel()
  const displayedEffort = getDisplayedEffortLevel(mainLoopModel, effortValue)
  const configuredMcpCount = mcpClients.filter(c => c.type !== 'disabled').length
  const hookCount = getSessionHookCount(sessionHooks, sessionId)
  const skillCount = getInvokedSkillsForAgent(null).size
  const legacyTodos =
    todosByAgent[sessionId] ?? EMPTY_TODO_PROGRESS_ITEMS
  const backgroundTaskCount = Object.values(tasks).filter(
    task => task?.status === 'running' || task?.status === 'pending',
  ).length
  const todoProgress = getTodoProgress(tasksV2, legacyTodos)
  const elapsed = formatDuration(getTotalDuration(), {
    hideTrailingZeros: true,
    mostSignificantOnly: true,
  })

  const line1Items: React.ReactNode[] = [
    <Text color="success" key="provider">
      [{provider.id === 'openai' && ultraCompact
        ? providerLabel
        : `${providerLabel}/${truncateHudLabel(provider.id, ultraCompact ? 8 : 14)}`}]
    </Text>,
    <Text bold color="success" key="model">
      {renderModelName(mainLoopModel)}
    </Text>,
  ]

  line1Items.push(
    <Text
      color={fastEnabledForDisplay ? 'warning' : undefined}
      key="fast-mode"
    >
      fast {fastEnabledForDisplay ? 'on' : 'off'}
    </Text>,
  )

  if (memoryStats.claudeMdCount > 0 || !compact) {
    line1Items.push(
      <Text key="claude-md">
        {memoryStats.claudeMdCount} instructions
      </Text>,
    )
  }

  if ((memoryStats.ruleCount > 0 || !compact) && !ultraCompact) {
    line1Items.push(
      <Text key="rules">
        {memoryStats.ruleCount} rules
      </Text>,
    )
  }

  if (configuredMcpCount > 0 || !compact) {
    line1Items.push(
      <Text key="mcps">
        {configuredMcpCount} MCPs
      </Text>,
    )
  }

  if ((hookCount > 0 || !compact) && !ultraCompact) {
    line1Items.push(
      <Text key="hooks">
        {hookCount} hooks
      </Text>,
    )
  }

  if ((skillCount > 0 || !compact) && !ultraCompact) {
    line1Items.push(
      <Text key="skills">
        {skillCount} skills
      </Text>,
    )
  }

  line1Items.push(
    <Text dimColor key="elapsed">
      time {elapsed}
    </Text>,
  )

  const lineMetricsItems: React.ReactNode[] = [
    <Text
      color={requestedTier === 'fast' ? 'warning' : undefined}
      key="tier-requested"
    >
      req {requestedTier}
    </Text>,
    <Text key="tier-actual">
      actual {actualTier ?? '--'}
    </Text>,
    <Text key="ttft">
      {renderTtftLabel(turnMetrics)}
    </Text>,
    <Text key="model-time">
      model {renderDurationLabel(turnMetrics.modelMs)}
    </Text>,
    <Text key="tool-time">
      tool {renderToolDurationLabel(turnMetrics.toolMs, turnMetrics.toolCount)}
    </Text>,
  ]

  const line2Items: React.ReactNode[] = [
    <Text dimColor key="effort">
      effort {displayedEffort}
    </Text>,
  ]

  for (const tool of recentTools.slice(0, ultraCompact ? 2 : 4)) {
    line2Items.push(
      <HudCheckItem
        key={`tool-${tool.label}`}
        label={`${tool.label} x${tool.count}`}
        tone={tool.tone}
      />,
    )
  }

  if (recentTools.length === 0) {
    line2Items.push(
      <Text dimColor key="tool-idle">
        waiting for tools
      </Text>,
    )
  }

  if (backgroundTaskCount > 0) {
    line2Items.push(
      <HudCheckItem
        key="agents"
        label={`${backgroundTaskCount} agents`}
        tone="cyan"
      />,
    )
  }

  if (todoProgress.total > 0) {
    line2Items.push(
      <HudCheckItem
        key="todos"
        label={`todos ${todoProgress.completed}/${todoProgress.total}`}
        tone={
          todoProgress.completed === todoProgress.total ? 'success' : 'yellow'
        }
      />,
    )
  }

  return (
    <Box flexDirection="column">
      <HudRow>{line1Items}</HudRow>
      <HudRow>{lineMetricsItems}</HudRow>
      <HudLimitLine window={rateLimitState?.primary?.primary} label="5h left" />
      <HudLimitLine window={rateLimitState?.primary?.secondary} label="weekly left" />
      <HudRow>{line2Items}</HudRow>
    </Box>
  )
}

function HudRow({
  children,
}: {
  children?: React.ReactNode
}): React.ReactNode {
  const items = React.Children.toArray(children)
  if (items.length === 0) {
    return <Text> </Text>
  }

  return (
    <Text wrap="truncate">
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <Text dimColor> | </Text> : null}
          {item}
        </React.Fragment>
      ))}
    </Text>
  )
}

function HudCheckItem({
  label,
  tone,
}: {
  label: string
  tone?: ToolTone
}): React.ReactNode {
  return (
    <>
      <Text color="success">{figures.tick}</Text>
      <Text> </Text>
      <Text color={tone}>{label}</Text>
    </>
  )
}

function HudLimitLine({
  window,
  label,
}: {
  window: CodexRateLimitWindow | null | undefined
  label: string
}): React.ReactNode {
  if (!window) {
    return (
      <Text dimColor wrap="truncate">
        {label} --
      </Text>
    )
  }

  const remaining = clampPercent(100 - window.usedPercent)
  const resetText = formatResetTime(window.resetsAt ?? undefined, false, true)
  return (
    <HudLimitMeter label={label} percent={remaining} resetText={resetText} />
  )
}

function HudLimitMeter({
  label,
  percent,
  resetText,
}: {
  label: string
  percent: number
  resetText?: string
}): React.ReactNode {
  const clamped = clampPercent(percent)

  return (
    <Box flexDirection="row" gap={1}>
      <ProgressBar
        ratio={clamped / 100}
        width={6}
        fillColor="rate_limit_fill"
        emptyColor="rate_limit_empty"
      />
      <Text>{label} {clamped}%</Text>
      {resetText ? <Text dimColor>{`· resets ${resetText}`}</Text> : null}
    </Box>
  )
}

function getMemoryStats(files: MemoryFileInfo[]): MemoryStats {
  return files.reduce<MemoryStats>(
    (stats, file) => {
      const name = basename(file.path)
      if (
        name === 'CLAUDE.md' ||
        name === 'CLAUDE.local.md' ||
        name === 'AGENTS.md' ||
        name === 'AGENTS.override.md'
      ) {
        stats.claudeMdCount += 1
      }
      if (file.path.includes(`${sep}.claude${sep}rules${sep}`)) {
        stats.ruleCount += 1
      }
      return stats
    },
    {
      claudeMdCount: 0,
      ruleCount: 0,
    },
  )
}

function getSessionHookCount(
  sessionHooks: Map<
    string,
    {
      hooks?: Record<string, Array<{ hooks: unknown[] }>>
    }
  >,
  sessionId: string,
): number {
  const store = sessionHooks.get(sessionId)
  if (!store?.hooks) {
    return 0
  }

  return Object.values(store.hooks).reduce((total, matchers) => {
    return (
      total +
      (matchers ?? []).reduce((matcherTotal, matcher) => {
        return matcherTotal + matcher.hooks.length
      }, 0)
    )
  }, 0)
}

function getTodoProgress(
  tasksV2: TodoProgressItem[] | undefined,
  legacyTodos: TodoProgressItem[],
): {
  completed: number
  total: number
} {
  if (tasksV2 !== undefined) {
    return {
      completed: tasksV2.filter(task => task.status === 'completed').length,
      total: tasksV2.length,
    }
  }

  return {
    completed: legacyTodos.filter(todo => todo.status === 'completed').length,
    total: legacyTodos.length,
  }
}

function getRecentToolStats(messages: Message[]): RecentToolStat[] {
  const counts = new Map<string, RecentToolStat>()

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) {
      continue
    }

    if (message.type === 'user' && getUserMessageText(message)) {
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    const content = Array.isArray(message.message?.content)
      ? message.message.content
      : []

    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex]
      if (!isToolUseBlock(block)) {
        continue
      }

      const tool = getRecentToolLabel(block.name, block.input)
      const existing = counts.get(tool.label)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(tool.label, { ...tool, count: 1 })
      }
    }
  }

  return Array.from(counts.values())
}

function getRequestedServiceTierLabel(
  fastMode: boolean,
): 'default' | 'fast' | 'flex' {
  if (getModelProviderKind() !== 'codex') {
    return 'default'
  }

  const configured = getCodexProviderConfigValue('service_tier')
  if (configured === 'flex') {
    return 'flex'
  }
  if (fastMode && isFastModeEnabled()) {
    return 'fast'
  }
  return configured === 'fast' ? 'fast' : 'default'
}

function getActualServiceTierLabel(
  messages: Message[],
  isLoading: boolean,
): 'standard' | 'priority' | 'flex' | null {
  const currentTurnStart = getLastPromptTurnIndex(messages)
  const latestCurrentTurn = getLatestAssistantUsageServiceTier(
    messages,
    currentTurnStart === -1 ? 0 : currentTurnStart + 1,
  )

  if (isLoading) {
    return latestCurrentTurn
  }

  return latestCurrentTurn ?? getLatestAssistantUsageServiceTier(messages, 0)
}

function getHudTurnMetrics(
  messages: Message[],
  isLoading: boolean,
  nowMs: number,
): HudTurnMetrics {
  const currentTurnStart = getLastPromptTurnIndex(messages)
  const latestCurrentTurnMetrics =
    currentTurnStart === -1
      ? null
      : getLatestApiMetricsMessage(messages, currentTurnStart + 1)

  if (latestCurrentTurnMetrics) {
    return createHudTurnMetricsFromApiMessage(latestCurrentTurnMetrics)
  }

  if (!isLoading) {
    const latestMetrics = getLatestApiMetricsMessage(messages, 0)
    return latestMetrics ? createHudTurnMetricsFromApiMessage(latestMetrics) : {}
  }

  if (currentTurnStart === -1) {
    return {}
  }

  const startMs = getMessageTimestampMs(messages[currentTurnStart])
  if (startMs === null) {
    return {}
  }

  const turnMs = Math.max(0, nowMs - startMs)
  const toolMs = getTurnToolDurationMs()
  const toolCount = getTurnToolCount()
  const firstOutput = getFirstTurnOutputMessage(messages, currentTurnStart + 1)
  const firstOutputMs = firstOutput ? getMessageTimestampMs(firstOutput) : null

  return {
    ttftMs:
      firstOutputMs !== null ? Math.max(0, firstOutputMs - startMs) : undefined,
    ttftPendingMs: firstOutputMs === null ? turnMs : undefined,
    turnMs,
    toolMs,
    modelMs: Math.max(0, turnMs - toolMs),
    toolCount,
  }
}

function createHudTurnMetricsFromApiMessage(
  message: ApiMetricsMessage,
): HudTurnMetrics {
  const turnMs =
    typeof message.turnDurationMs === 'number' ? message.turnDurationMs : undefined
  const toolMs =
    typeof message.toolDurationMs === 'number' ? message.toolDurationMs : undefined

  return {
    ttftMs: typeof message.ttftMs === 'number' ? message.ttftMs : undefined,
    turnMs,
    toolMs,
    modelMs:
      typeof turnMs === 'number'
        ? Math.max(0, turnMs - (toolMs ?? 0))
        : undefined,
    toolCount:
      typeof message.toolCount === 'number' ? message.toolCount : undefined,
  }
}

function getLastPromptTurnIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'user' && getUserMessageText(message)) {
      return index
    }
  }

  return -1
}

function getFirstTurnOutputMessage(
  messages: Message[],
  startIndex: number,
): Message | null {
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || message.isMeta) {
      continue
    }

    if (message.type === 'assistant' || message.type === 'progress') {
      return message
    }
  }

  return null
}

function getLatestAssistantUsageServiceTier(
  messages: Message[],
  startIndex: number,
): 'standard' | 'priority' | 'flex' | null {
  for (let index = messages.length - 1; index >= startIndex; index -= 1) {
    const message = messages[index]
    if (message?.type !== 'assistant') {
      continue
    }

    const tier = message.message?.usage?.service_tier
    if (
      tier === 'standard' ||
      tier === 'priority' ||
      tier === 'flex' ||
      tier === 'auto'
    ) {
      return tier
    }
  }

  return null
}

function getLatestApiMetricsMessage(messages: Message[], startIndex: number) {
  for (let index = messages.length - 1; index >= startIndex; index -= 1) {
    const message = messages[index]
    if (isApiMetricsMessage(message)) {
      return message
    }
  }

  return null
}

function isApiMetricsMessage(
  message: Message | undefined,
): message is ApiMetricsMessage {
  return message?.type === 'system' && message.subtype === 'api_metrics'
}

function getMessageTimestampMs(message: Message | undefined): number | null {
  const raw = message?.timestamp ?? message?.createdAt
  if (!raw) {
    return null
  }

  const parsed = new Date(raw).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function renderTtftLabel(metrics: HudTurnMetrics): string {
  if (typeof metrics.ttftMs === 'number') {
    return `ttft ${formatSecondsShort(metrics.ttftMs)}`
  }
  if (typeof metrics.ttftPendingMs === 'number') {
    return `ttft wait ${formatDuration(metrics.ttftPendingMs, {
      hideTrailingZeros: true,
      mostSignificantOnly: true,
    })}`
  }
  return 'ttft --'
}

function renderDurationLabel(ms: number | undefined): string {
  if (typeof ms !== 'number') {
    return '--'
  }
  return formatDuration(ms, {
    hideTrailingZeros: true,
    mostSignificantOnly: true,
  })
}

function renderToolDurationLabel(
  ms: number | undefined,
  count: number | undefined,
): string {
  const duration = renderDurationLabel(ms)
  if (typeof count === 'number' && count > 0 && duration !== '--') {
    return `${duration} x${count}`
  }
  return duration
}

function isToolUseBlock(
  block: unknown,
): block is {
  type: 'tool_use'
  name: string
  input?: unknown
} {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    'name' in block &&
    (block as { type?: unknown }).type === 'tool_use' &&
    typeof (block as { name?: unknown }).name === 'string'
  )
}

function getRecentToolLabel(
  toolName: string,
  input: unknown,
): Omit<RecentToolStat, 'count'> {
  const mcp = extractMcpToolDetails(toolName)
  if (mcp) {
    return {
      label: `MCP:${truncateHudLabel(mcp.serverName, 12)}`,
      tone: 'success',
    }
  }

  const skill = extractSkillName(toolName, input)
  if (skill) {
    return {
      label: `Skill:${truncateHudLabel(skill, 12)}`,
      tone: 'magenta',
    }
  }

  if (/bash|shell|tmux/i.test(toolName)) {
    return {
      label: truncateHudLabel(toolName, 16),
      tone: 'yellow',
    }
  }

  if (/agent|task/i.test(toolName)) {
    return {
      label: truncateHudLabel(toolName, 16),
      tone: 'cyan',
    }
  }

  return {
    label: truncateHudLabel(toolName, 16),
  }
}

function truncateHudLabel(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }

  return `${value.slice(0, Math.max(1, max - 1))}\u2026`
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}
