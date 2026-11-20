/**
 * OpenAI chat/completions SSE client.
 *
 * Responsibilities (kept separate from the dsh adapter):
 *   1. serialize dsh GenerateOptions into an OpenAI-compatible request body
 *   2. POST it and frame the SSE response
 *   3. translate OpenAI deltas into dsh StreamChunks
 *
 * The SSE contract implemented here was probed against the real WorkBuddy
 * proxy: reasoning arrives as `delta.reasoning_content`, visible text as
 * `delta.content`, tool arguments as `delta.tool_calls[].function.arguments`
 * (a raw JSON string fragment), and `usage` may share the terminal chunk with
 * `finish_reason` before a final `data: [DONE]`.
 */

import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// Request serialization
// ---------------------------------------------------------------------------

/** Flatten the text-ish blocks of a message into one string. */
function blockText(content) {
  if (typeof content === 'string') return content
  const parts = []
  for (const block of content ?? []) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push(block.offloaded ? '[image offloaded]' : '[image]')
    else if (block.type === 'file') parts.push('[file]')
  }
  return parts.join('\n')
}

function serializeMessage(message) {
  const role = message.role
  if (role === 'system' || role === 'developer') {
    return { role: 'system', content: blockText(message.content) }
  }
  if (role === 'user') {
    return { role: 'user', content: blockText(message.content) }
  }
  if (role === 'assistant') {
    const result = { role: 'assistant', content: blockText(message.content) }
    const toolCalls = []
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call') continue
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
      })
    }
    if (toolCalls.length > 0) result.tool_calls = toolCalls
    return result
  }
  if (role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? message.source?.callId ?? '',
      content: blockText(message.content),
    }
  }
  // Unknown future roles: fall through as user text rather than dropping them.
  return { role: 'user', content: blockText(message.content) }
}

/** Build the OpenAI chat/completions request body. Pure and unit-testable. */
export function buildRequestBody(options, wireModel) {
  const messages = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages ?? []) messages.push(serializeMessage(message))

  const body = {
    model: wireModel,
    stream: true,
    stream_options: { include_usage: true },
    messages,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop?.length) body.stop = options.stop
  if (options.tools?.length) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  }
  return body
}

// ---------------------------------------------------------------------------
// Transport + SSE framing
// ---------------------------------------------------------------------------

/** Map an HTTP failure to a provider-neutral LlmError. */
function httpError(status, text) {
  let code = `HTTP_${status}`
  if (status === 401 || status === 403) code = 'AUTH'
  else if (status === 429) code = 'RATE_LIMIT'
  else if (status === 400) code = 'INVALID_REQUEST'
  else if (status >= 500) code = 'SERVER'
  const detail = text.length > 500 ? text.slice(0, 500) : text
  return new LlmError(`acpx-bridge: endpoint returned ${status}${detail ? `: ${detail}` : ''}`, code)
}

/**
 * POST the request and return the raw response body stream.
 * Exported so a minimal script can exercise the real endpoint without dsh.
 */
export async function requestChatCompletion(options, connection) {
  const { baseURL, apiKey } = connection
  if (!apiKey) {
    throw new LlmError(
      'acpx-bridge: no API key; set ACPX_BRIDGE_API_KEY (or config.apiKey via cordis)',
      'MISSING_CREDENTIAL',
    )
  }

  let response
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(options, options.wireModel ?? options.model)),
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw new LlmError('acpx-bridge: request aborted', 'ABORTED', { cause: error })
    throw new LlmError('acpx-bridge: request transport failed', 'TRANSPORT', { cause: error })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw httpError(response.status, text)
  }
  if (!response.body) throw new LlmError('acpx-bridge: endpoint returned no body', 'EMPTY_RESPONSE')
  return response.body
}

/** Turn one trimmed SSE line into a decoded event, or undefined to skip it. */
function eventFromLine(line) {
  if (!line.startsWith('data:')) return undefined
  const data = line.slice(5).trim()
  if (!data || data === '[DONE]') return undefined
  try {
    return JSON.parse(data)
  } catch {
    throw new LlmError('acpx-bridge: SSE contains invalid JSON', 'MALFORMED_RESPONSE')
  }
}

/** Frame an SSE byte stream into decoded JSON events. */
export async function* parseSse(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      const event = eventFromLine(line)
      if (event !== undefined) yield event
    }
  }
  buffer += decoder.decode()
  const tail = eventFromLine(buffer.trim())
  if (tail !== undefined) yield tail
}

// ---------------------------------------------------------------------------
// Delta → StreamChunk translation
// ---------------------------------------------------------------------------

function toUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = { inputTokens: 0, outputTokens: 0 }
  if (Number.isFinite(raw.prompt_tokens)) usage.inputTokens = raw.prompt_tokens
  if (Number.isFinite(raw.completion_tokens)) usage.outputTokens = raw.completion_tokens
  if (Number.isFinite(raw.total_tokens)) usage.totalTokens = raw.total_tokens
  const cached = raw.prompt_tokens_details?.cached_tokens
  if (Number.isFinite(cached)) usage.cacheReadTokens = cached
  const reasoning = raw.completion_tokens_details?.reasoning_tokens
  if (Number.isFinite(reasoning)) usage.reasoningTokens = reasoning
  return usage
}

function toFinishReason(raw) {
  switch (raw) {
    case 'stop':
    case 'end_turn':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'content_filter':
      return { kind: 'error', failure: { message: 'acpx-bridge: content filtered by provider', code: 'CONTENT_REFUSED' } }
    default:
      throw new LlmError(`acpx-bridge: unsupported finish_reason ${String(raw)}`, 'MALFORMED_RESPONSE')
  }
}

function endChunk(block, type) {
  if (block === null) return undefined
  if (type === 'text') return { type: 'block-end', index: block.index, block: { type: 'text', text: block.value } }
  if (type === 'reasoning') return { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.value } }
  return {
    type: 'block-end',
    index: block.index,
    block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.value },
  }
}

/**
 * Translate decoded OpenAI chunks into dsh StreamChunks.
 *
 * Block indexes are assigned in first-seen order. Usage and finish are buffered
 * until the provider stream ends, so a trailing usage-only chunk is respected
 * and nothing is emitted after `finish`.
 */
export async function* translateOpenAi(events, model) {
  let nextIndex = 0
  let text = null
  let reasoning = null
  const calls = new Map()
  let usage
  let finishReason
  let responseId

  for await (const event of events) {
    if (typeof event.id === 'string') responseId = event.id
    if (event.usage != null) usage = toUsage(event.usage)

    for (const choice of event.choices ?? []) {
      const delta = choice.delta ?? {}

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        if (text !== null) {
          yield endChunk(text, 'text'); text = null
        }
        if (reasoning === null) {
          reasoning = { index: nextIndex++, value: '' }
          yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' }
        }
        reasoning.value += delta.reasoning_content
        yield { type: 'reasoning-delta', index: reasoning.index, text: delta.reasoning_content }
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (reasoning !== null) {
          yield endChunk(reasoning, 'reasoning'); reasoning = null
        }
        if (text === null) {
          text = { index: nextIndex++, value: '' }
          yield { type: 'block-start', index: text.index, blockType: 'text' }
        }
        text.value += delta.content
        yield { type: 'text-delta', index: text.index, text: delta.content }
      }

      for (const tool of delta.tool_calls ?? []) {
        const key = tool.index ?? 0
        let call = calls.get(key)
        if (call === undefined) {
          call = {
            index: nextIndex++,
            id: tool.id || `call_${key}`,
            name: tool.function?.name || 'unnamed_tool',
            value: '',
            nameEmitted: Boolean(tool.function?.name),
          }
          calls.set(key, call)
          yield { type: 'block-start', index: call.index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: call.index,
            id: call.id,
            ...call.nameEmitted ? { name: call.name } : {},
            argumentsDelta: '',
          }
        }
        if (tool.function?.name && !call.nameEmitted) {
          call.name = tool.function.name
          call.nameEmitted = true
        }
        if (typeof tool.function?.arguments === 'string' && tool.function.arguments.length > 0) {
          call.value += tool.function.arguments
          yield {
            type: 'tool-call-delta',
            index: call.index,
            id: call.id,
            argumentsDelta: tool.function.arguments,
          }
        }
      }

      if (choice.finish_reason != null && finishReason === undefined) {
        finishReason = toFinishReason(choice.finish_reason)
      }
    }
  }

  if (text === null && reasoning === null && calls.size === 0) {
    throw new LlmError('acpx-bridge: endpoint returned no content', 'EMPTY_RESPONSE')
  }

  // Close open blocks first, then usage, then the single terminal finish.
  if (reasoning !== null) yield endChunk(reasoning, 'reasoning')
  if (text !== null) yield endChunk(text, 'text')
  for (const call of calls.values()) yield endChunk(call, 'tool-call')

  yield { type: 'usage', usage: usage ?? { inputTokens: 0, outputTokens: 0 } }
  yield {
    type: 'finish',
    reason: finishReason ?? { kind: 'stop' },
    ...responseId === undefined ? {} : { replayState: { response: { id: responseId, model } } },
  }
}

/** Full streaming call: POST → frame → translate, with error classification. */
export async function* streamChatCompletion(options, connection) {
  let iterator
  try {
    const body = await requestChatCompletion(options, connection)
    iterator = parseSse(body)
    yield* translateOpenAi(iterator, options.model)
  } catch (error) {
    if (options.signal?.aborted) throw new LlmError('acpx-bridge: request aborted', 'ABORTED', { cause: error })
    if (error instanceof LlmError) throw error
    throw new LlmError('acpx-bridge: stream failed', 'TRANSPORT', { cause: error })
  } finally {
    if (iterator?.return) await iterator.return(undefined).catch(() => {})
  }
}
