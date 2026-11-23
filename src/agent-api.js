/**
 * HTTP surface of the command-tool authorization page.
 *
 * Mounted through Connection's authenticated Fetch registry exactly like
 * api.js — one physical `/api` carrier runs `connection.admit()` (Host/Origin
 * fence + browser-session auth) before dispatching here. Two platform limits
 * shape the URL design and are worth stating once:
 *
 *   1. Connection matches EXACT paths (`fetchRoutes.get(pathname)`), so no
 *      `:id` segment can be interpolated. The agent id travels in the query
 *      (`?agent=kimi`) or in the JSON body instead.
 *   2. The Fetch contract only allows GET / HEAD / POST. There is no DELETE,
 *      so "remove a credential" and "cancel a login" are POSTs to their own
 *      path (`…/agents/key/remove`, `…/agents/login/cancel`).
 *
 * Routes (all exact):
 *   GET  /api/acpx-bridge/agents                status of the seven platforms
 *   POST /api/acpx-bridge/agents/login          start one login job   {agent, region?}
 *   GET  /api/acpx-bridge/agents/login/events   SSE stream             ?agent=&job=
 *   POST /api/acpx-bridge/agents/login/input    stdin line             {agent, jobId, text}
 *   POST /api/acpx-bridge/agents/login/cancel   SIGTERM/SIGKILL        {agent, jobId}
 *   POST /api/acpx-bridge/agents/key            write a key            {agent, provider?|apiKey…}
 *   POST /api/acpx-bridge/agents/key/remove     remove a credential    {agent, provider?}
 *   POST /api/acpx-bridge/agents/logout         CLI logout             {agent, provider?}
 *   POST /api/acpx-bridge/agents/test           one real exec ping     {agent}
 *
 * Defence in depth, all enforced here: same-origin check, JSON content type on
 * every write, a 16 KiB body cap, no CORS headers, structured errors that never
 * carry a secret, one login job per agent (409), a 3-job cap (429), and a 60s
 * cooldown on the cost-bearing test (429).
 */

import {
  API_PREFIX,
  errorResponse,
  isJsonContentType,
  isSameOrigin,
  jsonResponse,
  readRequestJson,
} from './api.js'
import { getAgent } from './agents.js'
import { createJobStream } from './agent-jobs.js'
import {
  TEST_COOLDOWN_MS,
  logoutAgent,
  removeQwenKey,
  testAgent,
  writeOpencodeKey,
  writeQwenKey,
} from './agent-keys.js'

/** Exact route paths owned by the authorization page. */
export const AGENT_ROUTES = Object.freeze({
  list: `${API_PREFIX}/agents`,
  login: `${API_PREFIX}/agents/login`,
  loginEvents: `${API_PREFIX}/agents/login/events`,
  loginInput: `${API_PREFIX}/agents/login/input`,
  loginCancel: `${API_PREFIX}/agents/login/cancel`,
  key: `${API_PREFIX}/agents/key`,
  keyRemove: `${API_PREFIX}/agents/key/remove`,
  logout: `${API_PREFIX}/agents/logout`,
  test: `${API_PREFIX}/agents/test`,
})

/** Methods per route (the Fetch contract allows GET/HEAD/POST only). */
export const AGENT_ROUTE_METHODS = Object.freeze({
  list: Object.freeze(['GET']),
  login: Object.freeze(['POST']),
  loginEvents: Object.freeze(['GET']),
  loginInput: Object.freeze(['POST']),
  loginCancel: Object.freeze(['POST']),
  key: Object.freeze(['POST']),
  keyRemove: Object.freeze(['POST']),
  logout: Object.freeze(['POST']),
  test: Object.freeze(['POST']),
})

/** Body cap for every write of this surface (a key is at most a few KiB). */
export const AGENT_MAX_BODY_BYTES = 16 * 1024
/** Per-agent `detail` cap handed to the page. */
export const MAX_AGENT_DETAIL_CHARS = 2_048
/** Whole `/agents` payload cap. */
export const MAX_AGENTS_PAYLOAD_CHARS = 32 * 1024

const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-content-type-options': 'nosniff',
  'x-accel-buffering': 'no',
})

/**
 * Clamp a `/agents` payload: every `detail` is capped, the whole body is capped
 * by dropping the longest details first (never by dropping the agent rows).
 * @param payload - `{ ok, agents }`.
 * @returns a payload whose JSON is at most {@link MAX_AGENTS_PAYLOAD_CHARS}.
 */
export function clampAgentsPayload(payload) {
  const agents = (payload?.agents ?? []).map(agent => {
    const detail = typeof agent?.detail === 'string' ? agent.detail : ''
    return {
      ...agent,
      detail: detail.length > MAX_AGENT_DETAIL_CHARS ? `${detail.slice(0, MAX_AGENT_DETAIL_CHARS)}…` : detail,
    }
  })
  const body = { ok: payload?.ok !== false, agents }
  if (typeof payload?.probedAt === 'number') body.probedAt = payload.probedAt
  let size = Buffer.byteLength(JSON.stringify(body), 'utf8')
  while (size > MAX_AGENTS_PAYLOAD_CHARS) {
    let longest = -1
    for (let index = 0; index < body.agents.length; index += 1) {
      const detail = body.agents[index].detail ?? ''
      if (detail && (longest < 0 || detail.length > body.agents[longest].detail.length)) longest = index
    }
    if (longest < 0) break
    body.agents[longest] = { ...body.agents[longest], detail: '' }
    size = Buffer.byteLength(JSON.stringify(body), 'utf8')
  }
  return body
}

/**
 * Build the nine handlers plus their Connection route descriptors.
 *
 * @param options.agentsStatus - async ({ force }) => `{ ok, agents }`.
 * @param options.jobs - job store from `createJobStore`.
 * @param options.onChanged - called after a successful credential write/removal.
 * @param options.logger - receives contained failures.
 * @param options.now - injectable clock (test cooldown).
 * @param options.keyIo - filesystem seam for the key writers (tests).
 * @param options.run - command runner seam (tests).
 * @param options.secretsFor - async (spec) => string[] for output redaction.
 */
export function createAgentHandlers({
  agentsStatus,
  jobs,
  onChanged = null,
  logger = null,
  now = () => Date.now(),
  keyIo = undefined,
  run = undefined,
  secretsFor = null,
} = {}) {
  /** agentId → last accepted test timestamp. @type {Map<string, number>} */
  const lastTestAt = new Map()

  const guard = (request, { method, jsonBody = false }) => {
    if (request.method !== method) {
      return errorResponse(405, 'method-not-allowed', `该接口只支持 ${method}`)
    }
    if (!isSameOrigin(request.headers)) {
      return errorResponse(403, 'cross-origin', '只接受同源请求')
    }
    if (jsonBody && !isJsonContentType(request.headers)) {
      return errorResponse(415, 'unsupported-media-type', 'Content-Type 必须是 application/json')
    }
    return null
  }

  /** Read the JSON body of a write route under the 16 KiB cap. */
  async function bodyOf(request) {
    const parsed = await readRequestJson(request, { limit: AGENT_MAX_BODY_BYTES })
    return parsed
  }

  /** Resolve `{ agent }` (or the legacy `{ id }`) to a spec, or a 404 Response. */
  function specOf(payload) {
    const spec = getAgent(payload?.agent ?? payload?.id)
    if (spec === undefined) {
      return { spec: null, response: errorResponse(404, 'unknown-agent', `未知的平台：${String(payload?.agent ?? payload?.id ?? '')}`) }
    }
    return { spec, response: null }
  }

  /** Fetch one job that must belong to this agent. */
  function jobOf(spec, jobId) {
    const job = jobs.get(jobId)
    if (!job || job.agentId !== spec.id) {
      return { job: null, response: errorResponse(404, 'job-not-found', '找不到该登录 job（可能已结束并清理）') }
    }
    return { job, response: null }
  }

  async function listHandler(request) {
    const gate = guard(request, { method: 'GET' })
    if (gate !== null) return gate
    let force = false
    try {
      const url = new URL(request.url)
      const raw = url.searchParams.get('force')
      force = raw === '1' || raw === 'true'
    } catch (error) {
      logger?.debug?.(`[acpx-bridge] agents: unparsable request URL (${error?.message ?? error})`)
    }
    try {
      const payload = await agentsStatus({ force })
      return jsonResponse(200, clampAgentsPayload(payload))
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] agents status failed: ${error?.message ?? error}`)
      return errorResponse(500, 'agents-status-failed', '探测平台授权状态失败')
    }
  }

  async function loginHandler(request) {
    const gate = guard(request, { method: 'POST', jsonBody: true })
    if (gate !== null) return gate
    const body = await bodyOf(request)
    if (!body.ok) return errorResponse(body.status, body.code, body.message)
    const { spec, response } = specOf(body.value)
    if (response !== null) return response
    if (!Array.isArray(spec.auth?.loginArgv)) {
      return errorResponse(400, 'login-not-supported', `${spec.name} 没有可在页面上驱动的登录命令`)
    }
    const outcome = jobs.start(spec, { region: body.value.region })
    if (outcome.ok !== true) {
      if (outcome.conflict === true) {
        return jsonResponse(409, {
          ok: false,
          error: { code: 'job-running', message: '该平台已有一个正在运行的登录 job' },
          jobId: outcome.job.id,
          startedAt: outcome.job.startedAt,
        })
      }
      if (outcome.limit === true) {
        return errorResponse(429, 'too-many-jobs', `同时最多 ${outcome.running} 个登录 job（当前 ${outcome.running} 个在运行），请先取消其它 job`)
      }
      return errorResponse(500, 'login-start-failed', '无法启动登录进程')
    }
    const job = outcome.job
    return jsonResponse(200, {
      ok: true,
      jobId: job.id,
      agent: spec.id,
      argv: job.argv.join(' '),
      startedAt: job.startedAt,
    })
  }

  async function loginEventsHandler(request) {
    const gate = guard(request, { method: 'GET' })
    if (gate !== null) return gate
    let id = ''
    let jobId = ''
    try {
      const url = new URL(request.url)
      id = url.searchParams.get('agent') ?? ''
      jobId = url.searchParams.get('job') ?? ''
    } catch (error) {
      logger?.debug?.(`[acpx-bridge] login events: unparsable request URL (${error?.message ?? error})`)
    }
    const { spec, response } = specOf({ agent: id })
    if (response !== null) return response
    const found = jobOf(spec, jobId)
    if (found.response !== null) return found.response
    const job = found.job
    const stream = createJobStream(job, request, {
      logger,
      // Nobody is watching any more: a login nobody sees is a stuck process.
      onAbort: () => {
        if (!job.done) jobs.cancel(job)
      },
    })
    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  }

  async function loginInputHandler(request) {
    const gate = guard(request, { method: 'POST', jsonBody: true })
    if (gate !== null) return gate
    const body = await bodyOf(request)
    if (!body.ok) return errorResponse(body.status, body.code, body.message)
    const { spec, response } = specOf(body.value)
    if (response !== null) return response
    if (spec.auth?.pasteCallback !== true) {
      return errorResponse(400, 'input-not-supported', `${spec.name} 的登录不接受页面输入`)
    }
    const text = typeof body.value.text === 'string' ? body.value.text : ''
    if (!text.trim()) return errorResponse(400, 'empty-input', '输入不能为空')
    const found = jobOf(spec, body.value.jobId)
    if (found.response !== null) return found.response
    const accepted = jobs.writeInput(found.job, text)
    if (!accepted) return errorResponse(409, 'job-not-writable', '该 job 已结束或不再接受输入')
    return jsonResponse(200, { ok: true, jobId: found.job.id })
  }

  async function loginCancelHandler(request) {
    const gate = guard(request, { method: 'POST', jsonBody: true })
    if (gate !== null) return gate
    const body = await bodyOf(request)
    if (!body.ok) return errorResponse(body.status, body.code, body.message)
    const { spec, response } = specOf(body.value)
    if (response !== null) return response
    const found = jobOf(spec, body.value.jobId)
    if (found.response !== null) return found.response
    const outcome = jobs.cancel(found.job)
    if (outcome.ok !== true && outcome.reason === 'already-done') {
      return jsonResponse(200, { ok: true, alreadyDone: true, jobId: found.job.id })
    }
    return jsonResponse(200, { ok: outcome.ok === true, jobId: found.job.id })
  }

  async function keyHandler(request) {
    const gate = guard(request, { method: 'POST', jsonBody: true })
    if (gate !== null) return gate
    const body = await bodyOf(request)
    if (!body.ok) return errorResponse(body.status, body.code, body.message)
    const { spec, response } = specOf(body.value)
    if (response !== null) return response
    const kind = spec.keyStore?.kind
    if (!kind) {
      return errorResponse(404, 'key-not-supported', `${spec.name} 的密钥不由本页写入`)
    }
    const options = { logger, io: keyIo, run }
    let result
    try {
      if (kind === 'opencode-auth') {
        result = await writeOpencodeKey({ provider: body.value.provider, key: body.value.key, ...options })
      } else {
        result = await writeQwenKey({
          apiKey: body.value.apiKey ?? body.value.key,
          baseURL: body.value.baseURL,
          model: body.value.model,
          ...options,
        })
      }
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] key write for ${spec.id} failed: ${error?.message ?? error}`)
      return errorResponse(500, 'key-write-failed', '写入密钥失败')
    }
    if (result.ok !== true) {
      return errorResponse(result.status ?? 500, result.code ?? 'key-write-failed', result.error ?? '写入密钥失败')
    }
    onChanged?.()
    const answer = { ok: true, configured: true, agent: spec.id, maskedKey: result.maskedKey ?? '' }
    if (kind === 'opencode-auth') answer.provider = result.provider
    if (kind === 'acpx-config') {
      answer.baseURL = result.baseURL ?? ''
      answer.model = result.model ?? ''
    }
    return jsonResponse(200, answer)
  }

  async function keyRemoveHandler(request) {
    const gate = guard(request, { method: 'POST', jsonBody: true })
    if (gate !== null) return gate
    const body = await bodyOf(request)
    if (!body.ok) return errorResponse(body.status, body.code, body.message)
    const { spec, response } = specOf(body.value)
    if (response !== null) return response
    const kind = spec.keyStore?.kind
    if (!kind) return errorResponse(404, 'key-not-supported', `${spec.name} 的密钥不由本页管理`)
    try {
      if (kind === 'opencode-auth') {
        // `opencode auth logout <provider>` is the only supported removal path.
        const result = await logoutAgent(spec, {
          provider: body.value.provider,
          run,
          logger,
          secrets: typeof secretsFor === 'function' ? await secretsFor(spec) : [],
        })
        if (result.ok !== true) return errorResponse(result.status ?? 502, result.code ?? 'key-remove-failed', result.error)
        onChanged?.()
        return jsonResponse(200, { ok: true, removed: true, agent: spec.id })
      }
      const result = await removeQwenKey({ logger, io: keyIo })
      if (result.ok !== true) return errorResponse(result.status ?? 500, result.code ?? 'key-remove-failed', result.error)
      onChanged?.()
      return jsonResponse(200, { ok: true, removed: result.removed === true, agent: spec.id })
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] key removal for ${spec.id} failed: ${error?.message ?? error}`)
      return errorResponse(500, 'key-remove-failed', '移除密钥失败')
    }
  }

  async function logoutHandler(request) {
    const gate = guard(request, { method: 'POST', jsonBody: true })
    if (gate !== null) return gate
    const body = await bodyOf(request)
    if (!body.ok) return errorResponse(body.status, body.code, body.message)
    const { spec, response } = specOf(body.value)
    if (response !== null) return response
    let result
    try {
      result = await logoutAgent(spec, {
        provider: body.value.provider,
        run,
        logger,
        secrets: typeof secretsFor === 'function' ? await secretsFor(spec) : [],
      })
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] logout of ${spec.id} failed: ${error?.message ?? error}`)
      return errorResponse(500, 'logout-failed', '退出登录失败')
    }
    if (result.ok !== true) {
      return errorResponse(result.status ?? 502, result.code ?? 'logout-failed', result.error)
    }
    onChanged?.()
    return jsonResponse(200, { ok: true, agent: spec.id, detail: result.detail ?? '' })
  }

  async function testHandler(request) {
    const gate = guard(request, { method: 'POST', jsonBody: true })
    if (gate !== null) return gate
    const body = await bodyOf(request)
    if (!body.ok) return errorResponse(body.status, body.code, body.message)
    const { spec, response } = specOf(body.value)
    if (response !== null) return response
    if (spec.testable === false) {
      return errorResponse(400, 'test-not-supported', `${spec.name} 在该机器上不可用，无法测试`)
    }
    const startedAt = now()
    const last = lastTestAt.get(spec.id)
    if (typeof last === 'number' && startedAt - last < TEST_COOLDOWN_MS) {
      const waitMs = TEST_COOLDOWN_MS - (startedAt - last)
      return errorResponse(429, 'test-too-frequent', `测试过于频繁，请等待 ${Math.ceil(waitMs / 1000)} 秒后再试`)
    }
    lastTestAt.set(spec.id, startedAt)
    let result
    try {
      result = await testAgent(spec, {
        run,
        logger,
        secrets: typeof secretsFor === 'function' ? await secretsFor(spec) : [],
      })
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] test of ${spec.id} failed: ${error?.message ?? error}`)
      return jsonResponse(200, {
        ok: false,
        exitCode: null,
        durationMs: Math.max(0, now() - startedAt),
        stdout: '',
        stderr: '',
        diagnostic: '测试执行失败',
      })
    }
    return jsonResponse(200, { ...result, agent: spec.id })
  }

  return {
    list: listHandler,
    login: loginHandler,
    loginEvents: loginEventsHandler,
    loginInput: loginInputHandler,
    loginCancel: loginCancelHandler,
    key: keyHandler,
    keyRemove: keyRemoveHandler,
    logout: logoutHandler,
    test: testHandler,
    routes: [
      { path: AGENT_ROUTES.list, methods: AGENT_ROUTE_METHODS.list, requestBody: 'buffered', fetch: listHandler },
      { path: AGENT_ROUTES.login, methods: AGENT_ROUTE_METHODS.login, requestBody: 'buffered', fetch: loginHandler },
      { path: AGENT_ROUTES.loginEvents, methods: AGENT_ROUTE_METHODS.loginEvents, requestBody: 'buffered', fetch: loginEventsHandler },
      { path: AGENT_ROUTES.loginInput, methods: AGENT_ROUTE_METHODS.loginInput, requestBody: 'buffered', fetch: loginInputHandler },
      { path: AGENT_ROUTES.loginCancel, methods: AGENT_ROUTE_METHODS.loginCancel, requestBody: 'buffered', fetch: loginCancelHandler },
      { path: AGENT_ROUTES.key, methods: AGENT_ROUTE_METHODS.key, requestBody: 'buffered', fetch: keyHandler },
      { path: AGENT_ROUTES.keyRemove, methods: AGENT_ROUTE_METHODS.keyRemove, requestBody: 'buffered', fetch: keyRemoveHandler },
      { path: AGENT_ROUTES.logout, methods: AGENT_ROUTE_METHODS.logout, requestBody: 'buffered', fetch: logoutHandler },
      { path: AGENT_ROUTES.test, methods: AGENT_ROUTE_METHODS.test, requestBody: 'buffered', fetch: testHandler },
    ],
  }
}
