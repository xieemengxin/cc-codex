import { c as _c } from 'react/compiler-runtime'
import React, { useCallback, useEffect, useState } from 'react'
import { Box, Link, Text, useTerminalNotification } from '@anthropic/ink'
import { sendNotification } from '../services/notifier.js'
import { CodexOAuthService } from '../services/codex/oauth.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Spinner } from './Spinner.js'

type CodexOAuthStatus =
  | { state: 'ready' }
  | { state: 'waiting'; url: string }
  | { state: 'success' }
  | { state: 'error'; message: string }

export function CodexOAuthFlow(props: {
  onDone: (success: boolean) => void
  startingMessage?: string
}): React.ReactNode {
  const $ = _c(10)
  const terminal = useTerminalNotification()
  const [status, setStatus] = useState<CodexOAuthStatus>({ state: 'ready' })
  const [oauthService] = useState(() => new CodexOAuthService())

  const startLogin = useCallback(async () => {
    try {
      await oauthService.startOAuthFlow(async url => {
        setStatus({ state: 'waiting', url })
      })
      setStatus({ state: 'success' })
      void sendNotification(
        {
          message: 'Codex login successful',
          notificationType: 'auth_success',
        },
        terminal,
      )
    } catch (error) {
      setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [oauthService, terminal])

  useEffect(() => {
    if (status.state === 'ready') {
      void startLogin()
    }
    return () => oauthService.cleanup()
  }, [oauthService, startLogin, status.state])

  useEffect(() => {
    if (status.state === 'success') {
      props.onDone(true)
    }
  }, [props, status.state])

  let body: React.ReactNode
  switch (status.state) {
    case 'ready':
      body = (
        <Box flexDirection="column" gap={1}>
          {props.startingMessage ? <Text>{props.startingMessage}</Text> : null}
          <Spinner label="Preparing Codex login…" />
        </Box>
      )
      break
    case 'waiting':
      body = (
        <Box flexDirection="column" gap={1}>
          {props.startingMessage ? <Text>{props.startingMessage}</Text> : null}
          <Text>Opening your browser for Codex login…</Text>
          <Text dimColor>
            If it did not open automatically, visit:
          </Text>
          <Link url={status.url}>
            <Text dimColor>{status.url}</Text>
          </Link>
        </Box>
      )
      break
    case 'success':
      body = (
        <Box flexDirection="column" gap={1}>
          <Text color="success">Codex login successful.</Text>
          <Text dimColor>
            <KeyboardShortcutHint shortcut="Enter" action="continue" />
          </Text>
        </Box>
      )
      break
    case 'error':
      body = (
        <Box flexDirection="column" gap={1}>
          <Text color="error">Codex login failed: {status.message}</Text>
          <Text dimColor>
            Close this dialog and try again after checking your browser or
            network setup.
          </Text>
        </Box>
      )
      break
  }

  return body
}
