export function parseStrictPositiveTokenCount(
  rawValue: string,
): number | null {
  const trimmed = rawValue.trim()
  if (!/^\d+$/.test(trimmed)) {
    return null
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

export function getStrictPositiveTokenCountError(): string {
  return 'Enter a positive integer token count like 1000000.'
}
