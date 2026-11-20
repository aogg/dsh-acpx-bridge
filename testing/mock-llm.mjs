/**
 * mock-llm — a minimal OpenAI Chat Completions server used ONLY for local
 * end-to-end testing when the real WorkBuddy model endpoint is unreachable.
 * Emulates a model that calls `acpx_delegate`, then answers from the tool result.
 * Supports BOTH stream:true (SSE) and plain JSON responses.
 *
 *   node testing/mock-llm.mjs        # listens on 127.0.0.1:8899
 */
import http from 'node:http'

const PORT = Number(process.env.PORT || 8899)
const MODEL = process.env.MODEL || 'gs/deepseek-flash-deepseek.com'

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function sseChunk(id, delta, finishReason = null) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function sendStream(res, id, buildChunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const c of buildChunks(id)) res.write(c)
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const url = req.url || ''
    if (url.includes('/v1/models') || url.endsWith('/models')) {
      return sendJson(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'mock' }] })
    }
    if (!url.includes('/chat/completions')) {
      return sendJson(res, 404, { error: { message: 'not found' } })
    }

    let body
    try { body = JSON.parse(raw || '{}') } catch { return sendJson(res, 400, { error: { message: 'bad json' } }) }

    const stream = body.stream === true
    const messages = body.messages || []
    const hasToolResult = messages.some((m) => m.role === 'tool')
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const userText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content || []).map((c) => c.text || '').join(' ')
    const now = Math.floor(Date.now() / 1000)

    // ---- Step 1: tool call ----
    if (!hasToolResult) {
      const args = JSON.stringify({ agent: 'codex', task: userText || 'Summarize the repository', format: 'quiet' })
      const callId = 'call_acpx_' + now
      const fnName = 'acpx_delegate'

      if (stream) {
        return sendStream(res, 'chatcmpl-mock-' + now, (id) => [
          sseChunk(id, { role: 'assistant', content: '' }),
          sseChunk(id, { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: fnName, arguments: '' } }] }),
          sseChunk(id, { tool_calls: [{ index: 0, function: { arguments: args } }] }),
          sseChunk(id, {}, 'tool_calls'),
        ])
      }
      return sendJson(res, 200, {
        id: 'chatcmpl-mock-' + now, object: 'chat.completion', created: now, model: MODEL,
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name: fnName, arguments: args } }],
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    }

    // ---- Step 2: final answer ----
    const toolMsg = [...messages].reverse().find((m) => m.role === 'tool')
    const toolContent = typeof toolMsg?.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg?.content)
    const answer =
      '已通过 acpx 调度子 agent 完成任务。工具返回：\n\n' + toolContent.slice(0, 800) +
      '\n\n（本地 mock LLM 的验证回复，用于确认 dsh → acpx_delegate → acpx 链路可用。）'

    if (stream) {
      return sendStream(res, 'chatcmpl-mock-final-' + now, (id) => [
        sseChunk(id, { role: 'assistant', content: '' }),
        sseChunk(id, { content: answer }),
        sseChunk(id, {}, 'stop'),
      ])
    }
    return sendJson(res, 200, {
      id: 'chatcmpl-mock-final-' + now, object: 'chat.completion', created: now, model: MODEL,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }],
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-llm listening on http://127.0.0.1:${PORT}/v1  (model=${MODEL})`)
})
