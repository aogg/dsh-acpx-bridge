/**
 * The plugin's small HTTP surface, mounted on the harness Web server.
 *
 * Four exact routes under `/api/acpx-bridge/`:
 *   GET  /state        everything the settings page renders (never a secret)
 *   PUT  /prefs        validated partial preference update
 *   POST /verify       one real minimal chat/completions probe
 *   POST /acpx-check   `acpx --version` (path + version)
 *
 * Security rules, all enforced here rather than in the client:
 *   - same-origin only: when `Origin` is present it must match `Host`, and a
 *     `sec-fetch-site: cross-site` marker is refused outright (403);
 *   - writes require `content-type: application/json` (415);
 *   - request bodies are capped at 64 KiB (413);
 *   - no CORS headers are ever emitted, so a foreign page can neither read a
 *     response nor preflight a write;
 *   - errors are `{ error: { code, message } }` and never carry a secret.
 *
 * Everything that can be unit-tested without a socket is a pure function:
 * same-origin judgement, body reading/limits, catalog + counts, response shape,
 * the verify probe (injectable fetch) and the acpx probe (injectable exec).
 */

import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_BASE_URL } from './config.js'
import {
  disabledModelSet,
  isPlaceholderModel,
  modelDisplayName,
  uniqueModelIds,
} from './prefs.js'

/** Route prefix owned by this plugin. */
export const API_PREFIX = '/api/acpx-bridge'
/** The four registered exact paths. */
export const ROUTES = Object.freeze({
  state: `${API_PREFIX}/state`,
  prefs: `${API_PREFIX}/prefs`,
  verify: `${API_PREFIX}/verify`,
  acpxCheck: `${API_PREFIX}/acpx-check`,
})

/** Request-body cap for every write route. */
export const MAX_BODY_BYTES = 64 * 1024
/** Timeout of one verify probe. */
export const VERIFY_TIMEOUT_MS = 15_000
/** Timeout of one `acpx --version` probe. */
export const ACPX_CHECK_TIMEOUT_MS = 10_000
/** Longest provider error excerpt echoed back to the page. */
const MAX_ERROR_CHARS = 300

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * Read one header from a plain Node header bag or a Fetch `Headers`.
 * @param headers - `req.headers` or a Headers instance.
 * @param name - lowercase header name.
 * @returns the first string value, or undefined.
 */
export function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : undefined
  }
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  const lower = headers[name.toLowerCase()]
  if (typeof lower === 'string') return lower
  if (Array.isArray(lower) && typeof lower[0] === 'string') return lower[0]
  return undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Same-origin fence for every route of this plugin.
 *
 * A browser sends `Origin` on cross-origin fetches and on same-origin unsafe
 * methods, so comparing it with the `Host` header rejects a foreign page
 * driving this API while leaving ordinary same-origin requests untouched.
 * @param headers - request headers.
 * @returns true when the request may be served.
 */
export function isSameOrigin(headers) {
  const host = headerOf(headers, 'host')
  if (typeof host !== 'string' || host.length === 0) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (headerOf(headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    // Expected branch: an unparsable Origin is not the host we serve.
    return false
  }
}

/** Whether `content-type` is exactly `application/json` (parameters allowed). */
export function isJsonContentType(headers) {
  const raw = headerOf(headers, 'content-type')
  if (typeof raw !== 'string') return false
  return raw.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

/**
 * Read and parse a JSON request body under a byte cap.
 * @param req - Node IncomingMessage (or an async iterable of Buffers/Uint8Arrays).
 * @param options.limit - byte cap, default {@link MAX_BODY_BYTES}.
 * @returns `{ ok: true, value }` or `{ ok: false, code, message }`.
 */
export async function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  const tooLarge = { ok: false, code: 'body-too-large', message: `请求体超过 ${limit} 字节上限` }
  // A declared length lets us refuse before touching the stream, which keeps
  // the socket intact long enough to deliver the 413.
  const declared = headerOf(req?.headers, 'content-length')
  if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > limit) {
    return tooLarge
  }
  const chunks = []
  let size = 0
  let oversized = false
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) {
        // Keep draining a chunked body up to a hard cap instead of returning
        // from inside `for await` (an early return destroys the request stream
        // and can lose the response). Beyond the cap the client is abusive and
        // the connection is dropped.
        oversized = true
        if (size > limit * 8) {
          req.destroy?.()
          break
        }
        continue
      }
      chunks.push(buffer)
    }
  } catch (error) {
    return { ok: false, code: 'body-read-failed', message: `读取请求体失败：${error?.message ?? error}` }
  }
  if (oversized) return tooLarge
  if (size === 0) return { ok: true, value: {} }
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return { ok: false, code: 'invalid-json', message: '请求体不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'invalid-body', message: '请求体必须是 JSON 对象' }
  }
  return { ok: true, value: parsed }
}

/** Send one JSON response; deliberately no CORS headers. */
export function sendJson(res, status, payload) {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

/** Send one `{ error: { code, message } }` response. */
export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

// ---------------------------------------------------------------------------
// State payload (pure)
// ---------------------------------------------------------------------------

/**
 * Group configured models by command tool (acpx agent) with per-row state.
 * @param tools - resolved `tools` config.
 * @param prefs - current preference document.
 * @returns `[{ agent, models: [{ id, name, placeholder, enabled }] }]`.
 */
export function buildCatalog(tools, prefs) {
  const disabled = disabledModelSet(prefs)
  return (tools ?? []).map(tool => ({
    agent: String(tool?.name ?? ''),
    models: (tool?.models ?? []).map(id => ({
      id: String(id),
      name: modelDisplayName(String(id), tools, prefs),
      placeholder: isPlaceholderModel(id),
      enabled: !disabled.has(String(id)),
    })),
  }))
}

/**
 * Enabled / total model counts. Counted over DISTINCT model ids, so the number
 * matches the entries the model selector can show (`default` collapses).
 * @param tools - resolved `tools` config.
 * @param prefs - current preference document.
 * @returns `{ total, enabled }`.
 */
export function countModels(tools, prefs) {
  const ids = uniqueModelIds(tools)
  const disabled = disabledModelSet(prefs)
  return { total: ids.length, enabled: ids.filter(id => !disabled.has(id)).length }
}

/**
 * Assemble the `/state` response. Contains no credential literal by construction:
 * the credential field is the seam's presence/writability view only.
 * @param input - already-resolved page facts.
 * @returns the JSON body.
 */
export function buildState({ version, provider, entryId, endpoint, credential, acpx, prefs, wireModels, notes, tools }) {
  return {
    ok: true,
    version: String(version ?? ''),
    provider: String(provider ?? ''),
    entryId: String(entryId ?? ''),
    endpoint: {
      effective: String(endpoint?.effective ?? ''),
      source: String(endpoint?.source ?? 'default'),
      fallback: String(endpoint?.fallback ?? DEFAULT_BASE_URL),
    },
    credential: {
      ref: String(credential?.ref ?? ''),
      configured: credential?.configured === true,
      source: String(credential?.source ?? ''),
      writable: credential?.writable !== false,
    },
    acpx: {
      bin: String(acpx?.bin ?? 'acpx'),
      path: String(acpx?.path ?? ''),
      version: String(acpx?.version ?? ''),
      ok: acpx?.ok === true,
      error: String(acpx?.error ?? ''),
    },
    catalog: buildCatalog(tools, prefs),
    counts: countModels(tools, prefs),
    prefs,
    wireModels: wireModels ?? {},
    notes: notes ?? {},
  }
}

// ---------------------------------------------------------------------------
// Verify probe
// ---------------------------------------------------------------------------

/** Strip bearer tokens and key-looking fragments from text a provider echoed. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, 'sk-***')
    .replace(/[A-Za-z0-9_-]{32,}/g, '***')
}

/** One-line provider error summary: prefer a JSON `error.message`. */
export function summarizeProviderError(text, status, logger = null) {
  let message = ''
  try {
    const parsed = JSON.parse(text)
    const candidate = parsed?.error?.message ?? parsed?.message ?? parsed?.error
    if (typeof candidate === 'string') message = candidate
  } catch (error) {
    // Expected branch: the body is plain text, so the raw excerpt below is the
    // best summary. Logged at debug so a broken provider body stays traceable.
    logger?.debug?.(`[acpx-bridge] verify: non-JSON error body (${error?.message ?? error})`)
  }
  if (!message) message = String(text ?? '').replace(/\s+/g, ' ').trim()
  const summary = redactSecrets(message).slice(0, MAX_ERROR_CHARS)
  return summary || `端点返回 HTTP ${status}`
}

/**
 * Probe the effective endpoint with one minimal non-streaming completion.
 * @param options.baseURL - endpoint root (no trailing slash needed).
 * @param options.apiKey - resolved key; a missing key fails without any request.
 * @param options.model - wire model id to ask for.
 * @param options.timeoutMs - probe timeout, default {@link VERIFY_TIMEOUT_MS}.
 * @param options.fetchImpl - injectable fetch (tests).
 * @param options.now - injectable clock (tests).
 * @param options.logger - receives contained failures.
 * @returns `{ ok, latencyMs, model, status, error }`.
 */
export async function verifyConnection({
  baseURL,
  apiKey,
  model,
  timeoutMs = VERIFY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = null,
} = {}) {
  const started = now()
  const result = { ok: false, latencyMs: 0, model: String(model ?? ''), status: 0, error: '' }
  const finish = () => {
    result.latencyMs = Math.max(0, now() - started)
    return result
  }
  if (typeof baseURL !== 'string' || !baseURL) {
    result.error = '没有可用的端点地址'
    return finish()
  }
  if (typeof apiKey !== 'string' || !apiKey) {
    result.error = '没有可用的密钥（凭据库与配置都为空）'
    return finish()
  }
  if (typeof fetchImpl !== 'function') {
    result.error = '当前运行时没有可用的 fetch'
    return finish()
  }

  const controller = new AbortController()
  // Not unref'd: the probe awaits this timer's abort, so an unref'd timer
  // could let the process exit with the promise still pending.
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${String(baseURL).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
      }),
    })
    result.status = Number.isInteger(response?.status) ? response.status : 0
    let text = ''
    try {
      text = await response.text()
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] verify: unable to read response body: ${error?.message ?? error}`)
    }
    if (!response?.ok) {
      result.error = summarizeProviderError(text, result.status, logger)
      return finish()
    }
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null // A 2xx with a non-JSON body still proves reachability.
    }
    const echoed = typeof body?.model === 'string' && body.model ? body.model : ''
    result.model = echoed || String(model ?? '')
    result.ok = true
    return finish()
  } catch (error) {
    if (controller.signal.aborted) {
      result.error = `请求超时（${timeoutMs}ms）`
    } else {
      const code = error?.cause?.code ?? error?.code ?? ''
      result.error = redactSecrets(`请求失败：${error?.message ?? String(error)}${code ? ` (${code})` : ''}`)
    }
    return finish()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// acpx probe
// ---------------------------------------------------------------------------

function defaultIsExecutable(file) {
  try {
    accessSync(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate the acpx executable: an explicit path is taken as-is, a bare name is
 * resolved against PATH so the page can show a real absolute path.
 * @param bin - `ACPX_BIN` or `acpx`.
 * @param options.pathEnv - PATH contents (tests inject a fixture).
 * @param options.isExecutable - executable probe (tests inject one).
 * @returns the absolute path, or '' when nothing executable was found.
 */
export function resolveAcpxPath(bin, { pathEnv = process.env.PATH ?? '', isExecutable = defaultIsExecutable } = {}) {
  const name = typeof bin === 'string' ? bin.trim() : ''
  if (!name) return ''
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return isExecutable(name) ? name : ''
  }
  for (const entry of String(pathEnv).split(delimiter)) {
    if (!entry) continue
    const candidate = join(entry, name)
    if (isExecutable(candidate)) return candidate
  }
  return ''
}

/** First line of `acpx --version`, normalized to `x.y.z`. */
export function parseAcpxVersion(stdout) {
  const firstLine = String(stdout ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
  const match = firstLine.match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)
  return match ? match[1] : firstLine.slice(0, 80)
}

/**
 * Run `acpx --version`.
 * @param options.bin - executable name or path.
 * @param options.timeoutMs - probe timeout.
 * @param options.execFileImpl - injectable `execFile` promise (tests).
 * @param options.resolvePath - injectable PATH resolver (tests).
 * @returns `{ ok, path, version, error }`.
 */
export async function checkAcpx({
  bin = 'acpx',
  timeoutMs = ACPX_CHECK_TIMEOUT_MS,
  execFileImpl = execFileAsync,
  resolvePath = resolveAcpxPath,
} = {}) {
  const resolved = resolvePath(bin) || ''
  try {
    const { stdout } = await execFileImpl(bin, ['--version'], { timeout: timeoutMs, maxBuffer: 256 * 1024 })
    return { ok: true, path: resolved || String(bin), version: parseAcpxVersion(stdout), error: '' }
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    const timedOut = error?.killed === true || error?.code === 'ETIMEDOUT'
    const message = missing
      ? `未找到可执行文件 ${bin}（acpx 未安装或不在 PATH 中）`
      : timedOut
        ? `acpx --version 超时（${timeoutMs}ms）`
        : String(error?.message ?? error).slice(0, MAX_ERROR_CHARS)
    return { ok: false, path: resolved || String(bin), version: '', error: message }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Build the four route handlers.
 *
 * @param options.store - the preference store (`update`/`read`).
 * @param options.snapshot - async () => the `/state` body.
 * @param options.verify - async () => verify result.
 * @param options.acpxCheck - async ({ force }) => acpx probe result.
 * @param options.onPrefsChanged - called after a committed preference write.
 * @param options.logger - receives contained handler failures.
 * @returns the handlers plus the `[{ path, handler }]` route list.
 */
export function createApiHandlers({ store, snapshot, verify, acpxCheck, onPrefsChanged, logger = null } = {}) {
  const guard = (req, res, { method, json = false } = {}) => {
    if (req.method !== method) {
      sendError(res, 405, 'method-not-allowed', `该接口只支持 ${method}`)
      return false
    }
    if (!isSameOrigin(req.headers)) {
      sendError(res, 403, 'cross-origin', '只接受同源请求')
      return false
    }
    if (json && !isJsonContentType(req.headers)) {
      sendError(res, 415, 'unsupported-media-type', 'Content-Type 必须是 application/json')
      return false
    }
    return true
  }

  async function stateHandler(req, res) {
    if (!guard(req, res, { method: 'GET' })) return
    try {
      sendJson(res, 200, await snapshot())
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] state snapshot failed: ${error?.message ?? error}`)
      sendError(res, 500, 'state-failed', '读取插件状态失败')
    }
  }

  async function prefsHandler(req, res) {
    if (!guard(req, res, { method: 'PUT', json: true })) return
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.code === 'body-too-large' ? 413 : 400, body.code, body.message)
      return
    }
    // `{ reset: true }` is a control flag, not a stored field: it discards the
    // document back to defaults (the page's two-step reset button).
    const wantsReset = body.value.reset === true
    let prefs
    try {
      prefs = wantsReset && typeof store.reset === 'function'
        ? await store.reset()
        : await store.update(body.value)
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] preference write failed: ${error?.message ?? error}`)
      sendError(res, 500, 'prefs-write-failed', '保存设置失败')
      return
    }
    try {
      onPrefsChanged?.(prefs)
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] model-list announcement failed: ${error?.message ?? error}`)
    }
    try {
      sendJson(res, 200, { ok: true, prefs, state: await snapshot() })
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] post-write snapshot failed: ${error?.message ?? error}`)
      sendJson(res, 200, { ok: true, prefs })
    }
  }

  async function verifyHandler(req, res) {
    if (!guard(req, res, { method: 'POST' })) return
    req.resume?.()
    try {
      sendJson(res, 200, await verify())
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] verify probe failed: ${error?.message ?? error}`)
      sendJson(res, 200, { ok: false, latencyMs: 0, model: '', status: 0, error: '测试连接执行失败' })
    }
  }

  async function acpxCheckHandler(req, res) {
    if (!guard(req, res, { method: 'POST' })) return
    req.resume?.()
    try {
      sendJson(res, 200, await acpxCheck({ force: true }))
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] acpx probe failed: ${error?.message ?? error}`)
      sendJson(res, 200, { ok: false, path: '', version: '', error: '检测 acpx 失败' })
    }
  }

  return {
    state: stateHandler,
    prefs: prefsHandler,
    verify: verifyHandler,
    acpxCheck: acpxCheckHandler,
    routes: [
      { path: ROUTES.state, handler: stateHandler },
      { path: ROUTES.prefs, handler: prefsHandler },
      { path: ROUTES.verify, handler: verifyHandler },
      { path: ROUTES.acpxCheck, handler: acpxCheckHandler },
    ],
  }
}
