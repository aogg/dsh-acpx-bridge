/**
 * Self-test for the pure logic. Runs with plain Node, no harness, no acpx and
 * no network required.
 *   node src/selftest.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAcpxArgs, buildSessionNewArgs, Config, inject } from './index.js'
import {
  allModelIds,
  baseDisplayName,
  displayNameForModel,
  endpointInfo,
  modelDisplayNames,
  toWireModel,
  resolveConfig,
  PROVIDER,
} from './config.js'
import { AcpxBridgeAdapter } from './llm-adapter.js'
import { translateOpenAi } from './openai-stream.js'
import {
  DEFAULT_PREFS,
  PrefsStore,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  clampTimeout,
  enabledModelIds,
  isModelDisabled,
  mergePrefs,
  modelDisplayName,
  sanitizeBaseURL,
  sanitizeDisplayNames,
  sanitizePrefs,
  writePrefsFile,
} from './prefs.js'
import {
  MAX_BODY_BYTES,
  ROUTES,
  buildCatalog,
  buildState,
  checkAcpx,
  countModels,
  createApiHandlers,
  isJsonContentType,
  isSameOrigin,
  parseAcpxVersion,
  readJsonBody,
  redactSecrets,
  resolveAcpxPath,
  summarizeProviderError,
  verifyConnection,
} from './api.js'

// inject now includes the llm service
assert.deepEqual(inject, ['tools', 'llm'])

// one-shot exec, default policy
assert.deepEqual(
  buildAcpxArgs({ task: 'fix the bug', agent: 'codex' }),
  ['--format', 'quiet', '--approve-reads', 'codex', 'exec', 'fix the bug'],
)

// approve-all + cwd
assert.deepEqual(
  buildAcpxArgs({ task: 'build api', agent: 'claude', approve: 'all', cwd: '/repo' }),
  ['--format', 'quiet', '--approve-all', '--cwd', '/repo', 'claude', 'exec', 'build api'],
)

// json format + deny-all
assert.deepEqual(
  buildAcpxArgs({ task: 'review', agent: 'gemini', approve: 'none', format: 'json' }),
  ['--format', 'json', '--deny-all', 'gemini', 'exec', 'review'],
)

// explicit model is forwarded to acpx as --model (global flag, before agent)
assert.deepEqual(
  buildAcpxArgs({ task: 'ping', agent: 'codex', model: 'gs/deepseek-flash-deepseek.com' }),
  ['--format', 'quiet', '--approve-reads', '--model', 'gs/deepseek-flash-deepseek.com', 'codex', 'exec', 'ping'],
)

// named session
assert.deepEqual(
  buildAcpxArgs({ task: 'continue', agent: 'codex', mode: 'session', session: 'backend' }),
  ['--format', 'quiet', '--approve-reads', 'codex', '-s', 'backend', 'continue'],
)

// session new
assert.deepEqual(
  buildSessionNewArgs('codex', 'backend'),
  ['codex', 'sessions', 'new', '--name', 'backend'],
)

// validation
assert.throws(() => buildAcpxArgs({ task: '' }), /non-empty string/)
assert.throws(() => buildAcpxArgs({ task: 'x', mode: 'session' }), /session.*required/)

// config schema defaults + model helpers
const cfg = Config({})
const resolved = resolveConfig(cfg)
assert.equal(PROVIDER, 'acpx-bridge')
assert.equal(resolved.tools.length, 1)
assert.deepEqual(allModelIds(resolved.tools), ['gs/deepseek-flash-deepseek.com'])
assert.deepEqual(resolved.wireModels, {})
assert.equal(displayNameForModel('gs/deepseek-flash-deepseek.com'), 'acpx/deepseek-flash')
assert.equal(baseDisplayName('my/opencode/deepseek-v4.1-flash-free'), 'deepseek-v4.1-flash-free')

// wire model: the FULL configured id is forwarded verbatim (no truncation)
assert.equal(toWireModel('gs/deepseek-flash-deepseek.com'), 'gs/deepseek-flash-deepseek.com')
assert.equal(toWireModel('my/opencode/deepseek-v4.1-flash-free'), 'my/opencode/deepseek-v4.1-flash-free')
// ... unless an explicit wire mapping says otherwise
assert.equal(
  toWireModel('my/opencode/deepseek-v4.1-flash-free', { 'my/opencode/deepseek-v4.1-flash-free': 'deepseek-flash' }),
  'deepseek-flash',
)
assert.equal(toWireModel('gs/deepseek-flash-deepseek.com', {}), 'gs/deepseek-flash-deepseek.com')

// selector names stay unique when different agents share a last path segment,
// and identical ids (placeholders) collapse into one selector entry
const names = modelDisplayNames([
  { name: 'deepseek-harness', models: ['gs/deepseek-flash-deepseek.com'] },
  {
    name: 'opencode',
    models: ['my/opencode/deepseek-v4.1-flash-free', 'my/opencode/mimo-v2.6-flash-free'],
  },
  { name: 'qwen', models: ['default'] },
  { name: 'kimi', models: ['default'] },
])
assert.equal(names.get('gs/deepseek-flash-deepseek.com'), 'acpx/deepseek-flash')
assert.equal(names.get('my/opencode/deepseek-v4.1-flash-free'), 'acpx/deepseek-v4.1-flash-free')
// same id string under several tools == one model entry
assert.equal(names.get('default'), 'acpx/default')
assert.equal(new Set([...names.values()]).size, names.size)

// different ids ending with the same segment are disambiguated by agent
const collided = modelDisplayNames([
  { name: 'gs-agent', models: ['gs/deepseek-flash'] },
  { name: 'opencode', models: ['opencode/deepseek-flash'] },
])
assert.equal(collided.get('gs/deepseek-flash'), 'acpx/gs-agent:deepseek-flash')
assert.equal(collided.get('opencode/deepseek-flash'), 'acpx/opencode:deepseek-flash')
assert.equal(displayNameForModel('default', [{ name: 'trae', models: ['default'] }]), 'acpx/default')

// adapter advertises the configured models without any network call
const adapter = new AcpxBridgeAdapter(resolved)
const models = await adapter.listModels(PROVIDER)
assert.equal(models.length, 1)
assert.equal(models[0].id, 'gs/deepseek-flash-deepseek.com')
assert.equal(models[0].name, 'acpx/deepseek-flash')
const info = await adapter.resolveModel(PROVIDER, models[0].id)
assert.equal(info.context.contextWindow, 131072)
assert.equal(info.defaultMaxTokens, 8192)

// adapter with collide-free tool list keeps ids and wire ids intact
const multi = new AcpxBridgeAdapter({
  ...resolved,
  tools: [
    { name: 'opencode', models: ['my/opencode/deepseek-v4.1-flash-free'] },
    { name: 'qwen', models: ['default'] },
  ],
  wireModels: {},
})
const multiModels = await multi.listModels(PROVIDER)
assert.deepEqual(multiModels.map(m => m.id), ['my/opencode/deepseek-v4.1-flash-free', 'default'])
assert.deepEqual(multiModels.map(m => m.name), ['acpx/deepseek-v4.1-flash-free', 'acpx/default'])

// synthetic tool-call stream: raw JSON fragments must survive as argumentsDelta
async function* toolEvents() {
  yield { id: 'resp-1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'ping', arguments: '' } }] }, finish_reason: null }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"host":' } }] }, finish_reason: null }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"baidu.com"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
}
const toolChunks = []
for await (const chunk of translateOpenAi(toolEvents(), 'm')) toolChunks.push(chunk)
const deltas = toolChunks.filter(chunk => chunk.type === 'tool-call-delta')
assert.deepEqual(deltas.slice(1).map(chunk => chunk.argumentsDelta), ['{"host":', '"baidu.com"}'])
const ended = toolChunks.find(chunk => chunk.type === 'block-end')
assert.equal(ended.block.arguments, '{"host":"baidu.com"}')
assert.deepEqual(toolChunks.at(-1).reason, { kind: 'tool-calls' })
assert.ok(toolChunks.findIndex(chunk => chunk.type === 'usage') < toolChunks.length - 1)


// ---------------------------------------------------------------------------
// Preference document: sanitize / clamp / merge
// ---------------------------------------------------------------------------

const clean = sanitizePrefs(DEFAULT_PREFS)
assert.equal(clean.version, 1)
assert.deepEqual(clean.disabledModels, [])
assert.deepEqual(clean.displayNames, {})
assert.equal(clean.baseURLOverride, '')
assert.deepEqual(clean.defaults, {
  agent: '', mode: 'exec', approve: 'reads', format: 'quiet', timeoutMs: 600000,
})

// an unknown version discards the whole document
assert.deepEqual(
  sanitizePrefs({ version: 99, disabledModels: ['x'], baseURLOverride: 'http://evil.test/v1' }),
  clean,
)

// unknown fields and wrong types are dropped, not fatal
const messy = sanitizePrefs({
  version: 1,
  disabledModels: ['a', 42, null, ' a ', '', 'b', {}],
  displayNames: { 'm/1': 'one', 'm/2': '', '  ': 'x', 'm/3': 7 },
  baseURLOverride: 'http://example.test/v1///',
  defaults: { mode: 'nope', approve: 'all', format: 'json', timeoutMs: 5, junk: true },
  surprise: 'ignored',
})
assert.deepEqual(messy.disabledModels, ['a', 'b'])
assert.deepEqual(messy.displayNames, { 'm/1': 'one' })
assert.equal(messy.baseURLOverride, 'http://example.test/v1')
assert.equal(messy.defaults.mode, 'exec') // invalid enum falls back
assert.equal(messy.defaults.approve, 'all')
assert.equal(messy.defaults.format, 'json')
assert.equal(messy.defaults.timeoutMs, TIMEOUT_MIN_MS) // clamped up
assert.equal(messy.surprise, undefined)

// timeout clamping
assert.equal(clampTimeout(1), TIMEOUT_MIN_MS)
assert.equal(clampTimeout(10_000_000), TIMEOUT_MAX_MS)
assert.equal(clampTimeout('120000'), 120000)
assert.equal(clampTimeout(Number.NaN), 600000)
assert.equal(clampTimeout(null), 600000)

// endpoint overrides: only plain http(s) URLs survive
assert.equal(sanitizeBaseURL('https://a.test/v1/'), 'https://a.test/v1')
assert.equal(sanitizeBaseURL('ftp://a.test'), '')
assert.equal(sanitizeBaseURL('http://user:pass@a.test/v1'), '')
assert.equal(sanitizeBaseURL('not a url'), '')
assert.equal(sanitizeBaseURL('   '), '')
assert.equal(sanitizeBaseURL(42), '')

// display names: blank values delete the key
assert.deepEqual(sanitizeDisplayNames({ a: 'A', b: '  ' }), { a: 'A' })

// merge keeps every untouched default (a timeout edit never resets mode)
const merged = mergePrefs(
  { ...clean, defaults: { ...clean.defaults, mode: 'session', agent: 'opencode' } },
  { defaults: { timeoutMs: 120000 } },
)
assert.equal(merged.defaults.timeoutMs, 120000)
assert.equal(merged.defaults.mode, 'session')
assert.equal(merged.defaults.agent, 'opencode')

// merge replaces the arrays it is given and drops garbage
assert.deepEqual(mergePrefs(clean, { disabledModels: ['a', 'a', 1] }).disabledModels, ['a'])
assert.deepEqual(mergePrefs(clean, { disabledModels: 'nope' }).disabledModels, [])

// an INVALID defaults value is dropped, not applied: the current value survives
const kept = mergePrefs(
  { ...clean, defaults: { ...clean.defaults, mode: 'session', timeoutMs: 120000 } },
  { defaults: { mode: 'bogus', approve: 42, format: 'nope', timeoutMs: 'abc' } },
)
assert.equal(kept.defaults.mode, 'session')
assert.equal(kept.defaults.approve, 'reads')
assert.equal(kept.defaults.format, 'quiet')
assert.equal(kept.defaults.timeoutMs, 120000)
// ... while a valid value is applied
assert.equal(mergePrefs(kept, { defaults: { agent: 'opencode' } }).defaults.agent, 'opencode')

// ---------------------------------------------------------------------------
// Model filtering + display names
// ---------------------------------------------------------------------------

const tools = [
  { name: 'deepseek-harness', models: ['gs/deepseek-flash-deepseek.com'] },
  { name: 'opencode', models: ['my/opencode/a-free', 'my/opencode/b-free'] },
  { name: 'qwen', models: ['default'] },
]
const disabledPrefs = { ...clean, disabledModels: ['my/opencode/b-free'] }
assert.equal(isModelDisabled(disabledPrefs, 'my/opencode/b-free'), true)
assert.equal(isModelDisabled(disabledPrefs, 'my/opencode/a-free'), false)
assert.deepEqual(
  enabledModelIds(tools, disabledPrefs),
  ['gs/deepseek-flash-deepseek.com', 'my/opencode/a-free', 'default'],
)
// no disabled list == everything enabled
assert.deepEqual(enabledModelIds(tools, clean), allModelIds(tools))

// display-name override wins; without one the collision-safe name is used
assert.equal(modelDisplayName('my/opencode/a-free', tools, clean), 'acpx/a-free')
assert.equal(
  modelDisplayName('my/opencode/a-free', tools, { ...clean, displayNames: { 'my/opencode/a-free': '自定义名' } }),
  '自定义名',
)

// adapter really advertises fewer models once one is disabled
const filteredAdapter = new AcpxBridgeAdapter({ tools, prefs: () => disabledPrefs, wireModels: {} })
const filteredModels = await filteredAdapter.listModels(PROVIDER)
assert.deepEqual(filteredModels.map(model => model.id), enabledModelIds(tools, disabledPrefs))
assert.ok(!filteredModels.some(model => model.id === 'my/opencode/b-free'))
// resolveModel refuses a disabled model with an explicit error
await assert.rejects(
  () => filteredAdapter.resolveModel(PROVIDER, 'my/opencode/b-free'),
  /disabled/,
)
// ... and still resolves an enabled one
const stillThere = await filteredAdapter.resolveModel(PROVIDER, 'my/opencode/a-free')
assert.equal(stillThere.id, 'my/opencode/a-free')

// the adapter picks up a changed prefs snapshot on the very next call
let livePrefs = clean
const liveAdapter = new AcpxBridgeAdapter({ tools, prefs: () => livePrefs, wireModels: {} })
assert.equal((await liveAdapter.listModels(PROVIDER)).length, 4)
livePrefs = { ...clean, disabledModels: ['default'] }
assert.equal((await liveAdapter.listModels(PROVIDER)).length, 3)

// ---------------------------------------------------------------------------
// Endpoint source label
// ---------------------------------------------------------------------------

const savedBaseEnv = process.env.ACPX_BRIDGE_BASE_URL
delete process.env.ACPX_BRIDGE_BASE_URL
assert.deepEqual(endpointInfo({}).source, 'default')
assert.equal(endpointInfo({ baseURL: 'http://cfg.test/v1/' }).effective, 'http://cfg.test/v1')
assert.equal(endpointInfo({ baseURL: 'http://cfg.test/v1/' }).source, 'config')
// an explicitly blank config value falls through to the environment
process.env.ACPX_BRIDGE_BASE_URL = 'http://env.test/v1'
assert.equal(endpointInfo({ baseURL: '' }).source, 'env')
assert.equal(endpointInfo({ baseURL: '' }).effective, 'http://env.test/v1')
if (savedBaseEnv === undefined) delete process.env.ACPX_BRIDGE_BASE_URL
else process.env.ACPX_BRIDGE_BASE_URL = savedBaseEnv

// ---------------------------------------------------------------------------
// Catalog + state payload
// ---------------------------------------------------------------------------

const catalog = buildCatalog(tools, disabledPrefs)
assert.equal(catalog.length, 3)
assert.deepEqual(catalog[1].models.map(model => model.enabled), [true, false])
assert.equal(catalog[2].models[0].placeholder, true)
assert.deepEqual(countModels(tools, disabledPrefs), { total: 4, enabled: 3 })
// counts are over DISTINCT ids: `default` under several agents counts once
assert.deepEqual(countModels([
  { name: 'a', models: ['default'] },
  { name: 'b', models: ['default'] },
], clean), { total: 1, enabled: 1 })

const statePayload = buildState({
  version: '0.1.0',
  provider: PROVIDER,
  entryId: 'acpx-bridge',
  endpoint: { effective: 'http://x.test/v1', source: 'prefs', fallback: 'http://fallback.test/v1' },
  credential: { ref: 'ACPX_BRIDGE_API_KEY', configured: true, source: 'file', writable: true },
  acpx: { bin: 'acpx', path: '/usr/bin/acpx', version: '0.22.0', ok: true, error: '' },
  prefs: disabledPrefs,
  wireModels: {},
  notes: { docs: 'docs/设置页.md' },
  tools,
})
assert.equal(statePayload.ok, true)
assert.equal(statePayload.credential.configured, true)
assert.equal(statePayload.counts.enabled, 3)
assert.equal(JSON.stringify(statePayload).includes('super-secret-key'), false)
assert.equal(JSON.stringify(statePayload).includes('apiKey'), false)

// ---------------------------------------------------------------------------
// HTTP fence: same origin, content type, body cap
// ---------------------------------------------------------------------------

assert.equal(isSameOrigin({ host: '127.0.0.1:3082' }), true) // no Origin: allowed
assert.equal(isSameOrigin({ host: '127.0.0.1:3082', origin: 'http://127.0.0.1:3082' }), true)
assert.equal(isSameOrigin({ host: '127.0.0.1:3082', origin: 'http://evil.test' }), false)
assert.equal(isSameOrigin({ host: '127.0.0.1:3082', origin: 'http://127.0.0.1:3999' }), false)
assert.equal(isSameOrigin({ host: '127.0.0.1:3082', 'sec-fetch-site': 'cross-site' }), false)
assert.equal(isSameOrigin({ origin: 'http://127.0.0.1:3082' }), false) // no Host at all
assert.equal(isSameOrigin({}), false)
assert.equal(isSameOrigin(new Headers({ host: 'a.test', origin: 'http://a.test' })), true)

assert.equal(isJsonContentType({ 'content-type': 'application/json' }), true)
assert.equal(isJsonContentType({ 'content-type': 'application/json; charset=utf-8' }), true)
assert.equal(isJsonContentType({ 'content-type': 'text/plain' }), false)
assert.equal(isJsonContentType({}), false)

function bodyReq(text) {
  return {
    async *[Symbol.asyncIterator]() {
      if (text !== undefined) yield Buffer.from(text)
    },
  }
}
assert.deepEqual(await readJsonBody(bodyReq(undefined)), { ok: true, value: {} })
assert.deepEqual(await readJsonBody(bodyReq('{"a":1}')), { ok: true, value: { a: 1 } })
assert.equal((await readJsonBody(bodyReq('{oops'))).code, 'invalid-json')
assert.equal((await readJsonBody(bodyReq('[1,2]'))).code, 'invalid-body')
assert.equal((await readJsonBody(bodyReq('"text"'))).code, 'invalid-body')
const tooBig = await readJsonBody(bodyReq('{"a":"' + 'x'.repeat(MAX_BODY_BYTES) + '"}'))
assert.equal(tooBig.ok, false)
assert.equal(tooBig.code, 'body-too-large')

// an oversized declared Content-Length is refused WITHOUT consuming the stream
{
  let consumed = false
  const declared = await readJsonBody({
    headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    async *[Symbol.asyncIterator]() {
      consumed = true
      yield Buffer.from('{}')
    },
  })
  assert.equal(declared.code, 'body-too-large')
  assert.equal(consumed, false)
}

// ---------------------------------------------------------------------------
// Verify probe (injected fetch — no network)
// ---------------------------------------------------------------------------

{
  const keyless = await verifyConnection({ baseURL: 'http://x.test/v1', apiKey: '', model: 'm' })
  assert.equal(keyless.ok, false)
  assert.match(keyless.error, /密钥/)

  const endpointless = await verifyConnection({ apiKey: 'k', model: 'm' })
  assert.equal(endpointless.ok, false)
  assert.match(endpointless.error, /端点/)

  let seen = null
  const okFetch = async (url, init) => {
    seen = { url, init }
    return {
      ok: true,
      status: 200,
      text: async () => '{"model":"m-echo","choices":[{"message":{"content":"pong"}}]}',
    }
  }
  const ok = await verifyConnection({ baseURL: 'http://x.test/v1/', apiKey: 'k', model: 'm', fetchImpl: okFetch })
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 200)
  assert.equal(ok.model, 'm-echo')
  assert.equal(ok.latencyMs >= 0, true)
  assert.equal(seen.url, 'http://x.test/v1/chat/completions')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers.authorization, 'Bearer k')
  const sent = JSON.parse(seen.init.body)
  assert.equal(sent.model, 'm')
  assert.equal(sent.stream, false)
  assert.ok(sent.max_tokens <= 16)

  const failFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"invalid api key Bearer sk-abcdef123456"}}',
  })
  const failed = await verifyConnection({ baseURL: 'http://x.test/v1', apiKey: 'k', model: 'm', fetchImpl: failFetch })
  assert.equal(failed.ok, false)
  assert.equal(failed.status, 401)
  assert.match(failed.error, /invalid api key/)
  assert.equal(failed.error.includes('sk-abcdef123456'), false)

  const badBodyFetch = async () => ({ ok: false, status: 502, text: async () => '<html>upstream down</html>' })
  const badBody = await verifyConnection({ baseURL: 'http://x.test/v1', apiKey: 'k', model: 'm', fetchImpl: badBodyFetch })
  assert.equal(badBody.ok, false)
  assert.equal(badBody.status, 502)
  assert.match(badBody.error, /upstream down/)

  const throwingFetch = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } })
  }
  const transport = await verifyConnection({ baseURL: 'http://x.test/v1', apiKey: 'k', model: 'm', fetchImpl: throwingFetch })
  assert.equal(transport.ok, false)
  assert.match(transport.error, /ECONNREFUSED/)

  const hangingFetch = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const timedOut = await verifyConnection({
    baseURL: 'http://x.test/v1', apiKey: 'k', model: 'm', timeoutMs: 20, fetchImpl: hangingFetch,
  })
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.error, /超时/)
}

assert.equal(redactSecrets('Bearer abc.def-123'), 'Bearer ***')
assert.equal(redactSecrets('key sk-abcdef123456 leaked').includes('sk-abcdef123456'), false)
assert.equal(
  summarizeProviderError('{"error":{"message":"rate limited"}}', 429),
  'rate limited',
)
assert.equal(summarizeProviderError('', 500), '端点返回 HTTP 500')

// ---------------------------------------------------------------------------
// acpx probe (injected exec / PATH)
// ---------------------------------------------------------------------------

assert.equal(parseAcpxVersion('0.22.0\n'), '0.22.0')
assert.equal(parseAcpxVersion('acpx v1.2.3 (linux)\n'), '1.2.3')
assert.equal(parseAcpxVersion(''), '')
assert.equal(
  resolveAcpxPath('acpx', { pathEnv: '/nope:/usr/local/bin', isExecutable: file => file === '/usr/local/bin/acpx' }),
  '/usr/local/bin/acpx',
)
assert.equal(
  resolveAcpxPath('acpx', { pathEnv: '/nope', isExecutable: () => false }),
  '',
)
assert.equal(
  resolveAcpxPath('/opt/bin/acpx', { isExecutable: file => file === '/opt/bin/acpx' }),
  '/opt/bin/acpx',
)
{
  const okProbe = await checkAcpx({
    bin: 'acpx',
    execFileImpl: async () => ({ stdout: '0.22.0\n', stderr: '' }),
    resolvePath: () => '/usr/local/bin/acpx',
  })
  assert.deepEqual(okProbe, { ok: true, path: '/usr/local/bin/acpx', version: '0.22.0', error: '' })

  const missingProbe = await checkAcpx({
    bin: 'acpx',
    execFileImpl: async () => {
      throw Object.assign(new Error('spawn acpx ENOENT'), { code: 'ENOENT' })
    },
    resolvePath: () => '',
  })
  assert.equal(missingProbe.ok, false)
  assert.match(missingProbe.error, /未找到/)
}

// ---------------------------------------------------------------------------
// Atomic preference store (temp directory, real filesystem)
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      this.payload = chunk === undefined ? '' : JSON.parse(chunk)
      this.headersSent = true
    },
  }
}

const dir = await mkdtemp(join(tmpdir(), 'acpx-bridge-selftest-'))
const prefsPath = join(dir, 'storages', 'acpx-bridge', 'prefs.json')
const store = new PrefsStore({
  file: prefsPath,
  logger: null,
  now: () => new Date('2026-01-02T03:04:05.000Z'),
})
await store.load()
assert.deepEqual(store.read(), clean) // missing file == defaults

const written = await store.update({ disabledModels: ['gs/x'] })
assert.deepEqual(written.disabledModels, ['gs/x'])
assert.equal(written.updatedAt, '2026-01-02T03:04:05.000Z')
const fileStat = await stat(prefsPath)
assert.equal(fileStat.mode & 0o777, 0o600)
const dirStat = await stat(join(dir, 'storages', 'acpx-bridge'))
assert.equal(dirStat.mode & 0o777, 0o700)
const onDisk = JSON.parse(await readFile(prefsPath, 'utf8'))
assert.deepEqual(onDisk.disabledModels, ['gs/x'])

// two overlapping writes serialize: each merges against the committed document
await Promise.all([
  store.update({ baseURLOverride: 'http://override.test/v1' }),
  store.update({ displayNames: { m: 'M' } }),
])
const raced = JSON.parse(await readFile(prefsPath, 'utf8'))
assert.equal(raced.baseURLOverride, 'http://override.test/v1')
assert.deepEqual(raced.displayNames, { m: 'M' })

// reset drops everything back to defaults
await store.update({ disabledModels: ['keep-me'] })
await store.reset()
assert.deepEqual(store.read(), { ...clean, updatedAt: '2026-01-02T03:04:05.000Z' })

// a corrupted document is ignored (defaults) instead of crashing the plugin
await writePrefsFile(prefsPath, { version: 1, disabledModels: [1, 2] })
const reloaded = new PrefsStore({ file: prefsPath, logger: null })
await reloaded.load()
assert.deepEqual(reloaded.read().disabledModels, [])

// ---------------------------------------------------------------------------
// Route handlers over fake req/res (no socket, no network)
// ---------------------------------------------------------------------------

const handlerStore = new PrefsStore({
  file: join(dir, 'handlers', 'prefs.json'),
  logger: null,
  now: () => new Date('2026-02-03T04:05:06.000Z'),
})
await handlerStore.load()

let snapshotCalls = 0
let announced = 0
const handlers = createApiHandlers({
  store: handlerStore,
  snapshot: async () => {
    snapshotCalls += 1
    return buildState({
      version: '0.1.0',
      provider: PROVIDER,
      entryId: 'acpx-bridge',
      endpoint: { effective: 'http://x.test/v1', source: 'default', fallback: 'http://x.test/v1' },
      credential: { ref: 'ACPX_BRIDGE_API_KEY', configured: false, source: '', writable: true },
      acpx: { bin: 'acpx', path: '/usr/local/bin/acpx', version: '0.22.0', ok: true, error: '' },
      prefs: handlerStore.read(),
      wireModels: {},
      notes: {},
      tools,
    })
  },
  verify: async () => ({ ok: true, latencyMs: 12, model: 'm', status: 200, error: '' }),
  acpxCheck: async () => ({ bin: 'acpx', ok: true, path: '/usr/local/bin/acpx', version: '0.22.0', error: '' }),
  onPrefsChanged: () => {
    announced += 1
  },
  logger: null,
})
assert.deepEqual(handlers.routes.map(route => route.path), [
  ROUTES.state, ROUTES.prefs, ROUTES.verify, ROUTES.acpxCheck,
])

const sameOriginHeaders = { host: '127.0.0.1:3082', origin: 'http://127.0.0.1:3082' }

// GET /state
{
  const req = { method: 'GET', headers: { host: '127.0.0.1:3082' } }
  const res = fakeRes()
  await handlers.state(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'].startsWith('application/json'), true)
  assert.equal(res.headers['access-control-allow-origin'], undefined)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.credential.configured, false)
  assert.equal(res.payload.counts.total, 4)
}

// GET /state from a foreign origin is refused
{
  const req = { method: 'GET', headers: { host: '127.0.0.1:3082', origin: 'http://evil.test' } }
  const res = fakeRes()
  await handlers.state(req, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.payload.error.code, 'cross-origin')
}

// wrong method
{
  const req = { method: 'POST', headers: sameOriginHeaders }
  const res = fakeRes()
  await handlers.state(req, res)
  assert.equal(res.statusCode, 405)
}

// PUT /prefs without a JSON content type
{
  const req = { method: 'PUT', headers: sameOriginHeaders }
  const res = fakeRes()
  await handlers.prefs(req, res)
  assert.equal(res.statusCode, 415)
  assert.equal(res.payload.error.code, 'unsupported-media-type')
}

// PUT /prefs from a foreign origin
{
  const req = {
    method: 'PUT',
    headers: { host: '127.0.0.1:3082', origin: 'http://evil.test', 'content-type': 'application/json' },
    ...bodyReq('{"disabledModels":["gs/x"]}'),
  }
  const res = fakeRes()
  await handlers.prefs(req, res)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(handlerStore.read().disabledModels, [])
}

// PUT /prefs happy path: validated write + announcement + echoed state
{
  const req = {
    method: 'PUT',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    ...bodyReq('{"disabledModels":["my/opencode/b-free"],"defaults":{"timeoutMs":99999999}}'),
  }
  const res = fakeRes()
  await handlers.prefs(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.ok, true)
  assert.deepEqual(res.payload.prefs.disabledModels, ['my/opencode/b-free'])
  assert.equal(res.payload.prefs.defaults.timeoutMs, TIMEOUT_MAX_MS) // clamped
  assert.equal(res.payload.state.counts.enabled, 3)
  assert.deepEqual(handlerStore.read().disabledModels, ['my/opencode/b-free'])
  assert.equal(announced, 1)
  assert.equal(snapshotCalls > 0, true)
}

// the disabled model is now refused by the delegate tool's pre-execution guard
assert.equal(isModelDisabled(handlerStore.read(), 'my/opencode/b-free'), true)

// PUT /prefs { reset: true } restores defaults
{
  const req = {
    method: 'PUT',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    ...bodyReq('{"reset":true}'),
  }
  const res = fakeRes()
  await handlers.prefs(req, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload.prefs.disabledModels, [])
}

// PUT /prefs body over the cap
{
  const req = {
    method: 'PUT',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    ...bodyReq('{"x":"' + 'y'.repeat(MAX_BODY_BYTES + 1) + '"}'),
  }
  const res = fakeRes()
  await handlers.prefs(req, res)
  assert.equal(res.statusCode, 413)
  assert.equal(res.payload.error.code, 'body-too-large')
}

// POST /verify
{
  const req = { method: 'POST', headers: sameOriginHeaders, resume() {} }
  const res = fakeRes()
  await handlers.verify(req, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { ok: true, latencyMs: 12, model: 'm', status: 200, error: '' })
}

// POST /acpx-check
{
  const req = { method: 'POST', headers: sameOriginHeaders, resume() {} }
  const res = fakeRes()
  await handlers.acpxCheck(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.path, '/usr/local/bin/acpx')
}

// POST routes are same-origin gated too
{
  const req = { method: 'POST', headers: { host: '127.0.0.1:3082', origin: 'http://evil.test' }, resume() {} }
  const res = fakeRes()
  await handlers.verify(req, res)
  assert.equal(res.statusCode, 403)
}

console.log('✓ dsh-acpx-bridge selftest passed (config, adapter, prefs, model filtering, HTTP fence, verify/acpx probes, tool-call SSE, command building)')
