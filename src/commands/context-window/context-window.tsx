import React from 'react'
import { CodexConfigInputDialog } from '../../components/CodexConfigInputDialog.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getCodexProviderConfigValue,
  updateCodexProviderConfig,
} from '../../utils/codex/config.js'
import {
  getStrictPositiveTokenCountError,
  parseStrictPositiveTokenCount,
} from '../../utils/codex/tokenCountInput.js'
import { getContextWindowForModel } from '../../utils/context.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']
const RESET_ARGS = new Set(['default', 'auto', 'unset'])

function getUsageText(): string {
  return `Usage: /context-window [default|token_count]

Context window:
- default: Use the current model default context window
- token_count: Override the effective context window used by Codex provider logic

Use a plain integer token count like 1000000. Suffixes like 1M are not supported.`
}

function applyContextWindow(
  onDone: LocalJSXCommandOnDone,
  rawArgs: string,
  model: string,
): React.ReactNode | null {
  const normalized = rawArgs.trim().toLowerCase()
  const effective = getContextWindowForModel(model)

  if (RESET_ARGS.has(normalized)) {
    const result = updateCodexProviderConfig({
      model_context_window: undefined,
    })

    if (result.error) {
      onDone(`Failed to clear Codex context window: ${result.error.message}`, {
        display: 'system',
      })
      return null
    }

    onDone(`Cleared Codex context window override (default: ${effective})`)
    return null
  }

  const parsed = parseStrictPositiveTokenCount(rawArgs)
  if (parsed === null) {
    onDone(`Invalid argument: ${rawArgs}. ${getStrictPositiveTokenCountError()}`, {
      display: 'system',
    })
    return null
  }

  const result = updateCodexProviderConfig({
    model_context_window: parsed,
  })

  if (result.error) {
    onDone(`Failed to update Codex context window: ${result.error.message}`, {
      display: 'system',
    })
    return null
  }

  onDone(`Set Codex context window override to ${parsed} tokens`)
  return null
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const rawArgs = args?.trim() ?? ''
  const normalized = rawArgs.toLowerCase()
  const model =
    context.getAppState().mainLoopModel ?? context.options.mainLoopModel
  const configured = getCodexProviderConfigValue('model_context_window')
  const effective = getContextWindowForModel(model)

  if (COMMON_HELP_ARGS.includes(normalized)) {
    onDone(getUsageText(), { display: 'system' })
    return null
  }

  if (normalized === 'current' || normalized === 'status') {
    onDone(
      configured !== undefined
        ? `Current Codex context window override: ${configured} tokens`
        : `Current Codex context window: default (${effective} tokens)`,
      { display: 'system' },
    )
    return null
  }

  if (!rawArgs) {
    return (
      <CodexConfigInputDialog
        title="Codex context window"
        subtitle="Leave empty to reset to the model default."
        initialValue={configured !== undefined ? String(configured) : ''}
        placeholder={String(effective)}
        onSubmit={value => {
          const trimmed = value.trim()
          if (!trimmed) {
            applyContextWindow(onDone, 'default', model)
            return
          }
          const parsed = parseStrictPositiveTokenCount(trimmed)
          if (parsed === null) {
            return getStrictPositiveTokenCountError()
          }
          applyContextWindow(onDone, trimmed, model)
        }}
        onCancel={() => {
          onDone(
            configured !== undefined
              ? `Kept Codex context window override at ${configured} tokens`
              : `Kept Codex context window at default (${effective} tokens)`,
            { display: 'system' },
          )
        }}
      />
    )
  }

  return applyContextWindow(onDone, rawArgs, model)
}
