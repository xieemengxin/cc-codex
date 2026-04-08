import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionTool } from 'openai/resources/chat/completions/completions.mjs'

/**
 * Convert Anthropic tool schemas to OpenAI function calling format.
 *
 * Anthropic: { name, description, input_schema }
 * OpenAI:    { type: "function", function: { name, description, parameters } }
 *
 * Anthropic-specific fields (cache_control, defer_loading, etc.) are stripped.
 */
export function anthropicToolsToOpenAI(
  tools: BetaToolUnion[],
): ChatCompletionTool[] {
  return tools
    .filter(tool => {
      // Only convert standard tools (skip server tools like computer_use, etc.)
      return tool.type === 'custom' || !('type' in tool) || tool.type !== 'server'
    })
    .map(tool => {
      // Handle the various tool shapes from Anthropic SDK
      const anyTool = tool as Record<string, unknown>
      const name = (anyTool.name as string) || ''
      const description = (anyTool.description as string) || ''
      const inputSchema = anyTool.input_schema as Record<string, unknown> | undefined

      return {
        type: 'function' as const,
        function: {
          name,
          description,
          parameters: sanitizeJsonSchema(inputSchema || { type: 'object', properties: {} }),
        },
      } satisfies ChatCompletionTool
    })
}

/**
 * Recursively sanitize a JSON Schema for OpenAI-compatible providers.
 *
 * Many OpenAI-compatible endpoints (Ollama, DeepSeek, vLLM, etc.) do not
 * support the `const` keyword in JSON Schema. Convert it to `enum` with a
 * single-element array, which is semantically equivalent.
 */
export function sanitizeJsonSchema(
  schema: Record<string, unknown>,
  options: {
    strict?: boolean
  } = {},
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema

  const result = { ...schema }

  // Convert `const` → `enum: [value]`
  if ('const' in result) {
    result.enum = [result.const]
    delete result.const
  }

  // Recursively process nested schemas
  const objectKeys = ['properties', 'definitions', '$defs', 'patternProperties'] as const
  for (const key of objectKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object') {
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
        sanitized[k] =
          v && typeof v === 'object'
            ? sanitizeJsonSchema(v as Record<string, unknown>, options)
            : v
      }
      result[key] = sanitized
    }
  }

  // Recursively process single-schema keys
  const singleKeys = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'] as const
  for (const key of singleKeys) {
    const nested = result[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      result[key] = sanitizeJsonSchema(
        nested as Record<string, unknown>,
        options,
      )
    }
  }

  // Recursively process array-of-schemas keys
  const arrayKeys = ['anyOf', 'oneOf', 'allOf'] as const
  for (const key of arrayKeys) {
    const nested = result[key]
    if (Array.isArray(nested)) {
      result[key] = nested.map(item =>
        item && typeof item === 'object'
          ? sanitizeJsonSchema(item as Record<string, unknown>, options)
          : item
      )
    }
  }

  if (
    options.strict &&
    (result.type === 'object' || 'properties' in result) &&
    result.properties &&
    typeof result.properties === 'object' &&
    !Array.isArray(result.properties)
  ) {
    const properties = result.properties as Record<string, unknown>
    const originalRequired = new Set(
      Array.isArray(result.required)
        ? result.required.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    )

    const strictProperties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(properties)) {
      const child =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      strictProperties[key] = originalRequired.has(key)
        ? child
        : makeSchemaNullable(child)
    }

    result.properties = strictProperties
    result.required = Object.keys(strictProperties)
    result.additionalProperties = false
  }

  return result
}

function makeSchemaNullable(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.nullable === true) {
    const copy = { ...schema }
    delete copy.nullable
    return makeSchemaNullable(copy)
  }

  if (typeof schema.type === 'string') {
    return schema.type === 'null'
      ? schema
      : { ...schema, type: [schema.type, 'null'] }
  }

  if (Array.isArray(schema.type)) {
    return schema.type.includes('null')
      ? schema
      : { ...schema, type: [...schema.type, 'null'] }
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(null)
      ? schema
      : { ...schema, enum: [...schema.enum, null] }
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some(isNullSchema)
      ? schema
      : { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] }
  }

  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.some(isNullSchema)
      ? schema
      : { ...schema, oneOf: [...schema.oneOf, { type: 'null' }] }
  }

  return {
    anyOf: [schema, { type: 'null' }],
    ...(typeof schema.description === 'string'
      ? { description: schema.description }
      : {}),
  }
}

function isNullSchema(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    (value as Record<string, unknown>).type === 'null'
  )
}

/**
 * Map Anthropic tool_choice to OpenAI tool_choice format.
 *
 * Anthropic → OpenAI:
 * - { type: "auto" } → "auto"
 * - { type: "any" }  → "required"
 * - { type: "tool", name } → { type: "function", function: { name } }
 * - undefined → undefined (use provider default)
 */
export function anthropicToolChoiceToOpenAI(
  toolChoice: unknown,
): string | { type: 'function'; function: { name: string } } | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined

  const tc = toolChoice as Record<string, unknown>
  const type = tc.type as string

  switch (type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return {
        type: 'function',
        function: { name: tc.name as string },
      }
    default:
      return undefined
  }
}
