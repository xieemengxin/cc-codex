import React, { useCallback, useState } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '@anthropic/ink'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import TextInput from './TextInput.js'

type CodexConfigInputDialogProps = {
  title: string
  subtitle?: string
  initialValue: string
  placeholder?: string
  multiline?: boolean
  onSubmit: (value: string) => string | void
  onCancel: () => void
}

export function CodexConfigInputDialog({
  title,
  subtitle,
  initialValue,
  placeholder,
  multiline = false,
  onSubmit,
  onCancel,
}: CodexConfigInputDialogProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const [value, setValue] = useState(initialValue)
  const [cursorOffset, setCursorOffset] = useState(initialValue.length)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(() => {
    const nextError = onSubmit(value)
    if (typeof nextError === 'string' && nextError.length > 0) {
      setError(nextError)
      return
    }
    setError(null)
  }, [onSubmit, value])

  const handleChange = useCallback((nextValue: string) => {
    setValue(nextValue)
    if (error !== null) {
      setError(null)
    }
  }, [error])

  useKeybinding('confirm:no', onCancel, {
    context: 'Settings',
    isActive: true,
  })

  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      color="permission"
      onCancel={onCancel}
      isCancelActive={false}
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="save" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        </Byline>
      )}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text>{'>'}</Text>
          <TextInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder={placeholder}
            focus={true}
            showCursor={true}
            multiline={multiline}
            columns={columns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        {error ? <Text color="error">{error}</Text> : null}
      </Box>
    </Dialog>
  )
}
