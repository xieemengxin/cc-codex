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
import { getAutoCompactTokenLimitForModel } from '../../utils/context.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']
const RESET_ARGS = new Set(['default', 'auto', 'unset'])

function getUsageText(): string {
  return `Usage: /auto-compact-context [default|token_count]

Auto-compact token limit:
- default: Use the current model default auto-compact token limit
- token_count: Override the effective auto-compact token limit used by Codex provider logic

Use a plain integer token count like 600000. Suffixes like 1M are not supported.`
}

function applyAutoCompactContext(
  onDone: LocalJSXCommandOnDone,
  rawArgs: string,
  model: string,
): React.ReactNode | null {
  const normalized = rawArgs.trim().toLowerCase()
  const effective = getAutoCompactTokenLimitForModel(model)

  if (RESET_ARGS.has(normalized)) {
    const result = updateCodexProviderConfig({
      model_auto_compact_token_limit: undefined,
    })

    if (result.error) {
      onDone(
        `Failed to clear Codex auto-compact token limit: ${result.error.message}`,
        {
          display: 'system',
        },
      )
      return null
    }

    onDone(
      effective !== undefined
        ? `Cleared Codex auto-compact token limit override (default: ${effective})`
        : 'Cleared Codex auto-compact token limit override',
    )
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
    model_auto_compact_token_limit: parsed,
  })

  if (result.error) {
    onDone(`Failed to update Codex auto-compact token limit: ${result.error.message}`, {
      display: 'system',
    })
    return null
  }

  onDone(`Set Codex auto-compact token limit override to ${parsed} tokens`)
  return null
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const rawArgs = args?.trim() ?? ''
  const normalized = rawArgs.toLowerCase()
  const model =
    context.getAppState().mainLoopModel ?? context.options.mainLoopModel
  const configured = getCodexProviderConfigValue('model_auto_compact_token_limit')
  const effective = getAutoCompactTokenLimitForModel(model)

  if (COMMON_HELP_ARGS.includes(normalized)) {
    onDone(getUsageText(), { display: 'system' })
    return null
  }

  if (normalized === 'current' || normalized === 'status') {
    onDone(
      configured !== undefined
        ? `Current Codex auto-compact token limit override: ${configured} tokens`
        : effective !== undefined
          ? `Current Codex auto-compact token limit: default (${effective} tokens)`
          : 'Current Codex auto-compact token limit: default (not set)',
      { display: 'system' },
    )
    return null
  }

  if (!rawArgs) {
    return (
      <CodexConfigInputDialog
        title="Codex auto-compact token limit"
        subtitle="Leave empty to reset to the model default."
        initialValue={configured !== undefined ? String(configured) : ''}
        placeholder={effective !== undefined ? String(effective) : ''}
        onSubmit={value => {
          const trimmed = value.trim()
          if (!trimmed) {
            applyAutoCompactContext(onDone, 'default', model)
            return
          }
          const parsed = parseStrictPositiveTokenCount(trimmed)
          if (parsed === null) {
            return getStrictPositiveTokenCountError()
          }
          applyAutoCompactContext(onDone, trimmed, model)
        }}
        onCancel={() => {
          onDone(
            configured !== undefined
              ? `Kept Codex auto-compact token limit override at ${configured} tokens`
              : effective !== undefined
                ? `Kept Codex auto-compact token limit at default (${effective} tokens)`
                : 'Kept Codex auto-compact token limit at default',
            { display: 'system' },
          )
        }}
      />
    )
  }

  return applyAutoCompactContext(onDone, rawArgs, model)
}
