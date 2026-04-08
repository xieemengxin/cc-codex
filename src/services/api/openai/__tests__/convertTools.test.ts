import { describe, expect, test } from 'bun:test'
import {
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  sanitizeJsonSchema,
} from '../convertTools.js'

describe('anthropicToolsToOpenAI', () => {
  test('converts basic tool', () => {
    const tools = [
      {
        type: 'custom',
        name: 'bash',
        description: 'Run a bash command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ]

    const result = anthropicToolsToOpenAI(tools as any)

    expect(result).toEqual([{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a bash command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    }])
  })

  test('uses empty schema when input_schema missing', () => {
    const tools = [{ type: 'custom', name: 'noop', description: 'no-op' }]
    const result = anthropicToolsToOpenAI(tools as any)

    expect(result[0].function.parameters).toEqual({ type: 'object', properties: {} })
  })

  test('strips Anthropic-specific fields', () => {
    const tools = [
      {
        type: 'custom',
        name: 'bash',
        description: 'Run bash',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
        defer_loading: true,
      },
    ]
    const result = anthropicToolsToOpenAI(tools as any)

    expect((result[0] as any).cache_control).toBeUndefined()
    expect((result[0] as any).defer_loading).toBeUndefined()
  })

  test('handles empty tools array', () => {
    expect(anthropicToolsToOpenAI([])).toEqual([])
  })

  test('sanitizes const to enum in tool schema', () => {
    const tools = [
      {
        type: 'custom',
        name: 'test',
        description: 'test tool',
        input_schema: {
          type: 'object',
          properties: {
            mode: { const: 'read' },
            name: { type: 'string' },
          },
        },
      },
    ]
    const result = anthropicToolsToOpenAI(tools as any)
    const props = result[0].function.parameters as any
    expect(props.properties.mode).toEqual({ enum: ['read'] })
    expect(props.properties.mode.const).toBeUndefined()
    expect(props.properties.name).toEqual({ type: 'string' })
  })

  test('sanitizes const in deeply nested schemas', () => {
    const tools = [
      {
        type: 'custom',
        name: 'deep',
        description: 'nested const',
        input_schema: {
          type: 'object',
          properties: {
            outer: {
              type: 'object',
              properties: {
                inner: { const: 'fixed' },
              },
            },
          },
          definitions: {
            MyType: {
              type: 'object',
              properties: {
                field: { const: 42 },
              },
            },
          },
        },
      },
    ]
    const result = anthropicToolsToOpenAI(tools as any)
    const params = result[0].function.parameters as any
    expect(params.properties.outer.properties.inner).toEqual({ enum: ['fixed'] })
    expect(params.definitions.MyType.properties.field).toEqual({ enum: [42] })
  })

  test('sanitizes const in anyOf/oneOf/allOf', () => {
    const tools = [
      {
        type: 'custom',
        name: 'union',
        description: 'union test',
        input_schema: {
          type: 'object',
          properties: {
            val: {
              anyOf: [
                { const: 'a' },
                { const: 'b' },
                { type: 'string' },
              ],
            },
          },
        },
      },
    ]
    const result = anthropicToolsToOpenAI(tools as any)
    const anyOf = (result[0].function.parameters as any).properties.val.anyOf
    expect(anyOf[0]).toEqual({ enum: ['a'] })
    expect(anyOf[1]).toEqual({ enum: ['b'] })
    expect(anyOf[2]).toEqual({ type: 'string' })
  })

  test('normalizes strict schemas for OpenAI responses tools', () => {
    const sanitized = sanitizeJsonSchema(
      {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number' },
          nested: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              create: { type: 'boolean' },
            },
            required: ['path'],
          },
        },
        required: ['command'],
      },
      { strict: true },
    ) as any

    expect(sanitized.required).toEqual(['command', 'timeout', 'nested'])
    expect(sanitized.additionalProperties).toBe(false)
    expect(sanitized.properties.timeout).toEqual({
      type: ['number', 'null'],
    })
    expect(sanitized.properties.nested.required).toEqual(['path', 'create'])
    expect(sanitized.properties.nested.additionalProperties).toBe(false)
    expect(sanitized.properties.nested.properties.create).toEqual({
      type: ['boolean', 'null'],
    })
  })
})

describe('anthropicToolChoiceToOpenAI', () => {
  test('maps auto', () => {
    expect(anthropicToolChoiceToOpenAI({ type: 'auto' })).toBe('auto')
  })

  test('maps any to required', () => {
    expect(anthropicToolChoiceToOpenAI({ type: 'any' })).toBe('required')
  })

  test('maps tool to function', () => {
    const result = anthropicToolChoiceToOpenAI({ type: 'tool', name: 'bash' })
    expect(result).toEqual({ type: 'function', function: { name: 'bash' } })
  })

  test('returns undefined for undefined input', () => {
    expect(anthropicToolChoiceToOpenAI(undefined)).toBeUndefined()
  })

  test('returns undefined for unknown type', () => {
    expect(anthropicToolChoiceToOpenAI({ type: 'unknown' })).toBeUndefined()
  })
})
