import { mkdirSync, readFileSync } from 'fs'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { logForDebugging } from '../debug.js'
import { getCodexConfigDir } from './config.js'
import { getCodexRequestHeaders } from './provider.js'
import { getCodexBackendApiBaseUrl } from './backend.js'
import { isCodexWorkspaceAccount } from './auth.js'

let cachedCloudRequirementsRaw: string | null | undefined
let cachedCloudRequirementsParsed: Record<string, unknown> | null | undefined

export function getCodexCloudRequirementsPath(): string {
  return `${getCodexConfigDir()}/cloud-requirements.toml`
}

function readCloudRequirementsRaw(): string | null {
  try {
    const raw = readFileSync(getCodexCloudRequirementsPath(), 'utf8')
    return raw.trim().length > 0 ? raw : null
  } catch {
    return null
  }
}

function writeCloudRequirementsRaw(raw: string): void {
  mkdirSync(getCodexConfigDir(), { recursive: true, mode: 0o700 })
  writeFileSyncAndFlush_DEPRECATED(
    getCodexCloudRequirementsPath(),
    raw.endsWith('\n') ? raw : `${raw}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

export function clearCachedCodexCloudRequirements(): void {
  cachedCloudRequirementsRaw = undefined
  cachedCloudRequirementsParsed = undefined
}

export function getCachedCodexCloudRequirementsRaw(): string | null {
  if (cachedCloudRequirementsRaw !== undefined) {
    return cachedCloudRequirementsRaw
  }

  cachedCloudRequirementsRaw = readCloudRequirementsRaw()
  return cachedCloudRequirementsRaw
}

export function getCachedCodexCloudRequirements():
  | Record<string, unknown>
  | null {
  if (cachedCloudRequirementsParsed !== undefined) {
    return cachedCloudRequirementsParsed
  }

  const raw = getCachedCodexCloudRequirementsRaw()
  if (!raw) {
    cachedCloudRequirementsParsed = null
    return cachedCloudRequirementsParsed
  }

  try {
    const parsed = Bun.TOML.parse(raw)
    cachedCloudRequirementsParsed =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null
  } catch {
    cachedCloudRequirementsParsed = null
  }

  return cachedCloudRequirementsParsed
}

export async function fetchCodexCloudRequirements(): Promise<string | null> {
  if (!isCodexWorkspaceAccount()) {
    logForDebugging(
      '[codex-cloud-requirements] skipped: current account is not a workspace plan',
    )
    return null
  }

  const headers = await getCodexRequestHeaders()
  const response = await fetch(
    `${getCodexBackendApiBaseUrl()}/wham/config/requirements`,
    {
      method: 'GET',
      headers,
    },
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Failed to fetch Codex cloud requirements (${response.status}): ${body || response.statusText}`,
    )
  }

  const raw = await response.text()
  if (raw.trim().length === 0) {
    return null
  }

  writeCloudRequirementsRaw(raw)
  cachedCloudRequirementsRaw = raw
  cachedCloudRequirementsParsed = undefined

  logForDebugging('[codex-cloud-requirements] fetched backend requirements')

  return raw
}
