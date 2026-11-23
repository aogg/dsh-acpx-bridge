/**
 * Self-test for the pure logic. Runs with plain Node, no harness, no acpx and
 * no network required.
 *   node src/selftest.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, buildAcpxArgs, buildSessionNewArgs, Config, inject } from './index.js'
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
import {
  AGENTS,
  AGENT_IDS,
  buildQwenArgv,
  classifyProbeOutput,
  extractAuthLinks,
  getAgent,
  maskKey,
  parseModelCount,
  parseVersion,
  probeAgent,
  redactKey,
  stripAnsi,
  stripQwenSecretArgs,
  summarizeLine,
} from './agents.js'
import {
  AGENT_ROUTES,
  AGENT_ROUTE_METHODS,
  MAX_AGENTS_PAYLOAD_CHARS,
  clampAgentsPayload,
  createAgentHandlers,
} from './agent-api.js'
import {
  JOB_TIMEOUT_MS,
  buildLoginArgv,
  createJobStore,
  createJobStream,
  encodeSse,
} from './agent-jobs.js'
import {
  acpxConfigFile,
  opencodeAuthFile,
  readAgentSecrets,
  removeQwenKey,
  testAgent,
  writeOpencodeKey,
  writeQwenKey,
} from './agent-keys.js'
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
  readRequestJson,
  redactSecrets,
  resolveAcpxPath,
  summarizeProviderError,
  verifyConnection,
  VERIFY_COOLDOWN_MS,
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

/** Build the Fetch request the Connection carrier would hand a route handler. */
function apiRequest(path, { method = 'GET', headers = {}, body } = {}) {
  return new Request(`http://127.0.0.1:3082${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  })
}

assert.deepEqual(await readRequestJson(apiRequest(ROUTES.prefs, { method: 'POST' })), { ok: true, value: {} })
assert.deepEqual(
  await readRequestJson(apiRequest(ROUTES.prefs, { method: 'POST', body: '{"a":1}' })),
  { ok: true, value: { a: 1 } },
)
assert.equal(
  (await readRequestJson(apiRequest(ROUTES.prefs, { method: 'POST', body: '{oops' }))).code,
  'invalid-json',
)
assert.equal(
  (await readRequestJson(apiRequest(ROUTES.prefs, { method: 'POST', body: '[1,2]' }))).code,
  'invalid-body',
)
{
  const big = '{"a":"' + 'x'.repeat(MAX_BODY_BYTES) + '"}'
  const oversized = await readRequestJson(apiRequest(ROUTES.prefs, { method: 'POST', body: big }))
  assert.equal(oversized.ok, false)
  assert.equal(oversized.status, 413)
  assert.equal(oversized.code, 'body-too-large')
}
{
  // declared length over the cap is refused before the body is parsed
  const declared = await readRequestJson(apiRequest(ROUTES.prefs, {
    method: 'POST',
    headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    body: '{}',
  }))
  assert.equal(declared.code, 'body-too-large')
}

// ---------------------------------------------------------------------------
// Verify probe (injected fetch — no network)
// ---------------------------------------------------------------------------
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
// Route handlers (WHATWG Fetch in / Response out — no socket, no network)
// ---------------------------------------------------------------------------

const handlerStore = new PrefsStore({
  file: join(dir, 'handlers', 'prefs.json'),
  logger: null,
  now: () => new Date('2026-02-03T04:05:06.000Z'),
})
await handlerStore.load()

let snapshotCalls = 0
let announced = 0
let clock = 10_000
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
  now: () => clock,
})

// the route descriptors handed to Connection
assert.deepEqual(handlers.routes.map(route => route.path), [
  ROUTES.state, ROUTES.prefs, ROUTES.verify, ROUTES.acpxCheck,
])
for (const route of handlers.routes) {
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
  assert.ok(route.methods.length > 0)
}
assert.deepEqual(handlers.routes[0].methods, ['GET'])
assert.deepEqual(handlers.routes.slice(1).map(route => route.methods), [['POST'], ['POST'], ['POST']])

const sameOriginHeaders = { host: '127.0.0.1:3082', origin: 'http://127.0.0.1:3082' }

// GET /state
{
  const response = await handlers.state(apiRequest(ROUTES.state, { headers: { host: '127.0.0.1:3082' } }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.credential.configured, false)
  assert.equal(payload.counts.total, 4)
  assert.equal(JSON.stringify(payload).includes('apiKey'), false)
  assert.equal(JSON.stringify(payload).includes('fake-key'), false)
}

// foreign origin is refused
{
  const response = await handlers.state(apiRequest(ROUTES.state, {
    headers: { host: '127.0.0.1:3082', origin: 'http://evil.test' },
  }))
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'cross-origin')
}

// wrong method
{
  const response = await handlers.state(apiRequest(ROUTES.state, { method: 'POST', headers: sameOriginHeaders }))
  assert.equal(response.status, 405)
  assert.equal((await response.json()).error.code, 'method-not-allowed')
}

// POST /prefs without a JSON content type
{
  const response = await handlers.prefs(apiRequest(ROUTES.prefs, {
    method: 'POST',
    headers: sameOriginHeaders,
  }))
  assert.equal(response.status, 415)
  assert.equal((await response.json()).error.code, 'unsupported-media-type')
}

// POST /prefs from a foreign origin
{
  const response = await handlers.prefs(apiRequest(ROUTES.prefs, {
    method: 'POST',
    headers: { host: '127.0.0.1:3082', origin: 'http://evil.test', 'content-type': 'application/json' },
    body: '{"disabledModels":["gs/x"]}',
  }))
  assert.equal(response.status, 403)
  assert.deepEqual(handlerStore.read().disabledModels, [])
}

// POST /prefs happy path: validated write + announcement + echoed state
{
  const response = await handlers.prefs(apiRequest(ROUTES.prefs, {
    method: 'POST',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    body: '{"disabledModels":["my/opencode/b-free"],"defaults":{"timeoutMs":99999999}}',
  }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.prefs.disabledModels, ['my/opencode/b-free'])
  assert.equal(payload.prefs.defaults.timeoutMs, TIMEOUT_MAX_MS) // clamped
  assert.equal(payload.state.counts.enabled, 3)
  assert.deepEqual(handlerStore.read().disabledModels, ['my/opencode/b-free'])
  assert.equal(announced, 1)
  assert.equal(snapshotCalls > 0, true)
}

// the disabled model is now refused by the delegate tool's pre-execution guard
assert.equal(isModelDisabled(handlerStore.read(), 'my/opencode/b-free'), true)

// POST /prefs { reset: true } restores defaults
{
  const response = await handlers.prefs(apiRequest(ROUTES.prefs, {
    method: 'POST',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    body: '{"reset":true}',
  }))
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).prefs.disabledModels, [])
}

// POST /prefs body over the cap
{
  const response = await handlers.prefs(apiRequest(ROUTES.prefs, {
    method: 'POST',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    body: '{"x":"' + 'y'.repeat(MAX_BODY_BYTES + 1) + '"}',
  }))
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error.code, 'body-too-large')
}

// POST /verify: first accepted, immediate second is 429 (cooldown), later one is accepted
{
  const first = await handlers.verify(apiRequest(ROUTES.verify, { method: 'POST', headers: sameOriginHeaders }))
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { ok: true, latencyMs: 12, model: 'm', status: 200, error: '' })

  clock += 500 // still inside the 2s cooldown
  const second = await handlers.verify(apiRequest(ROUTES.verify, { method: 'POST', headers: sameOriginHeaders }))
  assert.equal(second.status, 429)
  const secondPayload = await second.json()
  assert.equal(secondPayload.error.code, 'verify-too-frequent')
  assert.deepEqual(Object.keys(secondPayload), ['error']) // error envelope only, no state

  clock += VERIFY_COOLDOWN_MS
  const third = await handlers.verify(apiRequest(ROUTES.verify, { method: 'POST', headers: sameOriginHeaders }))
  assert.equal(third.status, 200)
}

// concurrent verify: while one is in flight the next is refused
{
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slowHandlers = createApiHandlers({
    store: handlerStore,
    snapshot: async () => ({}),
    verify: async () => {
      await gate
      return { ok: true, latencyMs: 1, model: 'm', status: 200, error: '' }
    },
    acpxCheck: async () => ({}),
    logger: null,
    now: () => 0,
  })
  const firstPromise = slowHandlers.verify(apiRequest(ROUTES.verify, { method: 'POST', headers: sameOriginHeaders }))
  const second = await slowHandlers.verify(apiRequest(ROUTES.verify, { method: 'POST', headers: sameOriginHeaders }))
  assert.equal(second.status, 429)
  release()
  assert.equal((await firstPromise).status, 200)
}

// POST /acpx-check
{
  const response = await handlers.acpxCheck(apiRequest(ROUTES.acpxCheck, { method: 'POST', headers: sameOriginHeaders }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.path, '/usr/local/bin/acpx')
}

// POST routes are same-origin gated too
{
  const response = await handlers.verify(apiRequest(ROUTES.verify, {
    method: 'POST',
    headers: { host: '127.0.0.1:3082', origin: 'http://evil.test' },
  }))
  assert.equal(response.status, 403)
}

// ---------------------------------------------------------------------------
// Plugin wiring: Connection Fetch routes registered through a fake connection
// ---------------------------------------------------------------------------

{
  const registeredRoutes = []
  const emitted = []
  const fakeConnectionContext = (ctx) => Object.assign(Object.create(ctx), {
    connection: {
      fetch: {
        register(route) {
          registeredRoutes.push(route)
          return async () => {}
        },
      },
    },
  })
  const pluginCtx = {
    logger: () => ({ warn: () => {}, debug: () => {}, info: () => {} }),
    effect(fn) {
      fn()
      return () => {}
    },
    on() { return () => {} },
    emit(event, ...args) { emitted.push([event, ...args]) },
    get() { return undefined },
    inject(deps, callback) {
      if (deps.includes('connection')) callback(fakeConnectionContext(pluginCtx))
    },
    tools: { register() {} },
    llm: { registerAdapter() {} },
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'acpx-bridge-wiring-'))
  try {
    await apply(pluginCtx, Config({ tools, wireModels: {} }))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  const agentRoutePaths = [
    AGENT_ROUTES.list, AGENT_ROUTES.login, AGENT_ROUTES.loginEvents,
    AGENT_ROUTES.loginInput, AGENT_ROUTES.loginCancel, AGENT_ROUTES.key,
    AGENT_ROUTES.keyRemove, AGENT_ROUTES.logout, AGENT_ROUTES.test,
  ]
  assert.deepEqual(registeredRoutes.map(route => route.path), [
    ROUTES.state, ROUTES.prefs, ROUTES.verify, ROUTES.acpxCheck, ...agentRoutePaths,
  ])
  for (const route of registeredRoutes) {
    assert.deepEqual(Object.keys(route).sort(), ['fetch', 'methods', 'path', 'requestBody'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  }
  assert.deepEqual(registeredRoutes.map(route => route.methods), [
    ['GET'], ['POST'], ['POST'], ['POST'],
    ['GET'], ['POST'], ['GET'], ['POST'], ['POST'], ['POST'], ['POST'], ['POST'], ['POST'],
  ])
  assert.ok(emitted.some(event => event[0] === 'llm/adapters-updated'))

  // the real registered handler answers a Fetch request
  const stateRoute = registeredRoutes.find(route => route.path === ROUTES.state)
  const response = await stateRoute.fetch(apiRequest(ROUTES.state, { headers: { host: '127.0.0.1:3082' } }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.provider, 'acpx-bridge')
  assert.equal(payload.counts.total, 4)
  assert.equal(JSON.stringify(payload).includes('apiKey'), false)
}

// ---------------------------------------------------------------------------
// 命令工具授权：7 平台表 + 探测分类（全部注入假 run，不真跑登录）
// ---------------------------------------------------------------------------

// the table itself: 7 unique platforms, every action source non-empty
assert.equal(AGENTS.length, 7)
assert.deepEqual(AGENT_IDS, ['kimi', 'trae', 'opencode', 'qwen', 'codebuddy', 'deepseek-harness', 'antigravity'])
assert.equal(new Set(AGENT_IDS).size, 7)
for (const spec of AGENTS) {
  assert.equal(typeof spec.id, 'string')
  assert.ok(spec.name.length > 0, `${spec.id}: name`)
  assert.ok(spec.bin.length > 0, `${spec.id}: bin`)
  assert.ok(spec.probe && typeof spec.probe.kind === 'string', `${spec.id}: probe.kind`)
  assert.ok(['command', 'config', 'static'].includes(spec.probe.kind), `${spec.id}: probe kind`)
  assert.ok(spec.auth && typeof spec.auth.kind === 'string', `${spec.id}: auth.kind`)
  if (spec.probe.kind === 'command') {
    assert.ok(Array.isArray(spec.probe.argv) && spec.probe.argv.length > 0, `${spec.id}: probe.argv`)
    assert.ok(spec.probe.argv.every(entry => typeof entry === 'string' && entry.length > 0))
  }
  if (spec.probe.kind === 'config') {
    assert.equal(typeof spec.probe.file, 'string')
    assert.equal(typeof spec.probe.agentKey, 'string')
    assert.equal(typeof spec.probe.requireArgvFlag, 'string')
  }
  if (spec.probe.kind === 'static') {
    assert.ok(typeof spec.probe.state === 'string' && spec.probe.state.length > 0, `${spec.id}: static state`)
    assert.ok(typeof spec.probe.detail === 'string' && spec.probe.detail.length > 0, `${spec.id}: static detail`)
  }
  if (spec.auth.loginArgv) {
    assert.ok(Array.isArray(spec.auth.loginArgv) && spec.auth.loginArgv.length > 0, `${spec.id}: loginArgv`)
    assert.ok(spec.auth.loginArgv.every(entry => typeof entry === 'string' && entry.length > 0))
  }
  if (spec.auth.logoutArgv) assert.ok(spec.auth.logoutArgv.length > 0)
  assert.equal(typeof spec.docs, 'string')
}
assert.equal(getAgent('kimi').bin, 'kimi')
assert.equal(getAgent('nope'), undefined)
assert.equal(getAgent(''), undefined)
// every platform that can start a login job has a non-empty login argv
for (const spec of AGENTS) {
  if (spec.auth.loginArgv) {
    assert.ok(buildLoginArgv(spec).length >= spec.auth.loginArgv.length)
  }
}
// Kimi's optional --region is only attached for a known value
assert.deepEqual(buildLoginArgv(getAgent('kimi'), 'mainland-cn'), ['kimi', 'login', '--region', 'mainland-cn'])
assert.deepEqual(buildLoginArgv(getAgent('kimi'), 'nonsense'), ['kimi', 'login'])
assert.deepEqual(buildLoginArgv(getAgent('trae'), 'mainland-cn'), ['traecli', 'login'])

// text helpers
assert.equal(stripAnsi('\u001b[31mred\u001b[0m plain'), 'red plain')
assert.equal(stripAnsi('a\r\nb'), 'a\nb')
assert.deepEqual(extractAuthLinks('open https://x.test/a?b=1. and https://x.test/a?b=1'), ['https://x.test/a?b=1'])
assert.deepEqual(extractAuthLinks('no link here'), [])
assert.equal(maskKey('SECRET1234'), '****1234')
assert.equal(maskKey('abc'), '****')
assert.equal(maskKey(''), '')
assert.equal(redactKey('key=SECRET1234 end', 'SECRET1234'), 'key=****1234 end')
assert.equal(redactKey('nothing', ''), 'nothing')
assert.equal(summarizeLine('\u001b[32m  hi  \u001b[0m\n\n there '), 'hi · there')
assert.equal(parseVersion('traecli 0.216.0\ninstallation: public'), '0.216.0')
assert.equal(parseVersion(''), '')
assert.equal(parseModelCount('{"models":{"a":{"x":1},"b":{}}}', 'json-models'), 2)
assert.equal(parseModelCount('totally not json', 'json-models'), null)
assert.equal(parseModelCount('a\nb\n\n', 'lines'), 2)

// probeAgent classification, driven by an injected run (no subprocess at all)
const okRun = (stdout, stderr = '') => ({ code: 0, signal: null, stdout, stderr, timedOut: false, notFound: false, error: '' })
{
  const kimi = getAgent('kimi')
  const authorized = await probeAgent(kimi, {
    run: async argv => {
      if (argv[1] === '--version') return okRun('2.7.2\n')
      if (argv[1] === 'provider') return okRun('{"models":{"m1":{},"m2":{},"m3":{}}}')
      return okRun('', 'Logged in to managed:kimi-code.\n')
    },
  })
  assert.equal(authorized.installed, true)
  assert.equal(authorized.version, '2.7.2')
  assert.equal(authorized.state, 'authorized')
  assert.equal(authorized.method, 'device-code')
  assert.equal(authorized.models, 3)
  assert.ok(authorized.actions.includes('login'))
  assert.ok(authorized.actions.includes('test'))
  assert.equal(authorized.actions.includes('logout'), false) // kimi has no logout

  const pending = await probeAgent(kimi, {
    run: async argv => (argv[1] === '--version'
      ? okRun('2.7.2\n')
      : { code: null, signal: 'SIGTERM', stdout: 'Visit https://auth.kimi.test/device and enter ABCD-1234\n', stderr: '', timedOut: true, notFound: false, error: 'timed out' }),
  })
  assert.equal(pending.state, 'unauthorized')
  assert.ok(pending.detail.includes('https://auth.kimi.test/device'))
  assert.equal(pending.models, null) // no paid/models probe while unauthorized
}
{
  const trae = getAgent('trae')
  const unauthorized = await probeAgent(trae, {
    run: async argv => (argv[1] === '--version' ? okRun('traecli 0.216.0\n') : okRun('', '\u001b[0mNot logged in\n')),
  })
  assert.equal(unauthorized.state, 'unauthorized')
  assert.equal(unauthorized.version, '0.216.0')
  assert.deepEqual(unauthorized.actions, ['login', 'logout', 'paste-callback', 'test'])
  // classifyProbeOutput must not read "Not logged in" as "logged in"
  assert.equal(classifyProbeOutput(trae, 'Not logged in').state, 'unauthorized')
  assert.equal(classifyProbeOutput(trae, 'Logged in as a@b.test').state, 'authorized')
}
{
  const opencode = getAgent('opencode')
  const zero = await probeAgent(opencode, {
    run: async argv => (argv[1] === '--version' ? okRun('1.19.5\n') : okRun('\u001b[90m└  0 credentials\u001b[0m\n')),
  })
  assert.equal(zero.state, 'unauthorized')
  const some = await probeAgent(opencode, {
    run: async argv => (argv[1] === '--version' ? okRun('1.19.5\n') : okRun('Credentials ~/.local/share/opencode/auth.json\nopenai api\n2 credentials\n')),
  })
  assert.equal(some.state, 'authorized')
  assert.deepEqual(some.actions, ['set-key', 'remove-key', 'logout', 'test'])
}
{
  // a missing binary is unavailable + no actions (never throws)
  const missing = await probeAgent(getAgent('trae'), {
    run: async () => ({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, notFound: true, error: 'ENOENT' }),
  })
  assert.equal(missing.installed, false)
  assert.equal(missing.state, 'unavailable')
  assert.deepEqual(missing.actions, [])
  assert.ok(missing.detail.includes('traecli'))
}
{
  // static verdicts: codebuddy unknown, dsh no-auth, antigravity unavailable
  const codebuddy = await probeAgent(getAgent('codebuddy'), { run: async () => okRun('2.185.0\n') })
  assert.equal(codebuddy.state, 'unknown')
  assert.deepEqual(codebuddy.actions, ['copy-login', 'test'])
  const dsh = await probeAgent(getAgent('deepseek-harness'), { run: async () => okRun('0.2.0-rc.2\n') })
  assert.equal(dsh.state, 'no-auth')
  assert.deepEqual(dsh.actions, ['test'])
  const agy = await probeAgent(getAgent('antigravity'), { run: async () => okRun('') })
  assert.equal(agy.state, 'unavailable')
  assert.ok(agy.detail.includes('avx enabled'))
  assert.deepEqual(agy.actions, [])
}
{
  // qwen: the verdict comes from the acpx argv, and the key is masked
  const dir = await mkdtemp(join(tmpdir(), 'acpx-bridge-qwen-probe-'))
  const file = join(dir, 'config.json')
  const qwen = getAgent('qwen')
  const before = await probeAgent(qwen, {
    run: async () => okRun('0.28.3\n'),
    readText: async () => null,
  })
  assert.equal(before.state, 'unauthorized')
  assert.ok(before.detail.includes('不存在'))
  await writeFile(file, JSON.stringify({
    agents: { qwen: { argv: ['qwen', '--acp', '--auth-type', 'openai', '--openai-api-key', 'SECRET9999'] } },
  }))
  const withKey = await probeAgent(qwen, {
    run: async () => okRun('0.28.3\n'),
    readText: async () => readFile(file, 'utf8'),
  })
  assert.equal(withKey.state, 'authorized')
  assert.equal(withKey.detail.includes('SECRET9999'), false)
  assert.ok(withKey.detail.includes('****9999'))
  const broken = await probeAgent(qwen, {
    run: async () => okRun('0.28.3\n'),
    readText: async () => '{not json',
  })
  assert.equal(broken.state, 'unauthorized')
}

// qwen argv helpers
assert.deepEqual(
  buildQwenArgv({ apiKey: 'k', baseURL: 'http://x/v1', model: 'm' }),
  ['qwen', '--acp', '--auth-type', 'openai', '--openai-api-key', 'k', '--openai-base-url', 'http://x/v1', '--model', 'm'],
)
assert.deepEqual(buildQwenArgv({ apiKey: 'k' }), ['qwen', '--acp', '--auth-type', 'openai', '--openai-api-key', 'k'])
assert.throws(() => buildQwenArgv({}), /apiKey/)
assert.deepEqual(
  stripQwenSecretArgs(['qwen', '--acp', '--auth-type', 'openai', '--openai-api-key', 'k', '--openai-base-url', 'u', '--model', 'm']),
  ['qwen', '--acp', '--auth-type', 'openai'],
)
assert.deepEqual(stripQwenSecretArgs(['qwen', '--acp', '--openai-api-key=k', '--model=m']), ['qwen', '--acp'])
assert.deepEqual(stripQwenSecretArgs(['qwen', '--acp']), ['qwen', '--acp'])

// the /agents payload clamp keeps every row and only trims details
{
  const agents = Array.from({ length: 40 }, (_, index) => ({
    id: `a${index}`,
    name: `A${index}`,
    state: 'authorized',
    installed: true,
    detail: 'x'.repeat(5_000),
  }))
  const clamped = clampAgentsPayload({ ok: true, agents })
  assert.equal(clamped.agents.length, 40)
  assert.ok(Buffer.byteLength(JSON.stringify(clamped), 'utf8') <= MAX_AGENTS_PAYLOAD_CHARS)
  const shortDetail = clampAgentsPayload({ ok: true, agents: [{ id: 'a', detail: 'y'.repeat(3_000) }] })
  assert.ok(shortDetail.agents[0].detail.length < 3_000)
}

// ---------------------------------------------------------------------------
// login job store + SSE framing (fake spawn, no login process is ever started)
// ---------------------------------------------------------------------------

/** Minimal ChildProcess stand-in: two output emitters, a stdin sink, kills. */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const writes = []
  child.stdin = {
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      writes.push(String(chunk))
      return true
    },
    end() {
      child.stdin.writableEnded = true
    },
  }
  child.kills = []
  child.kill = signal => {
    child.kills.push(signal)
    return true
  }
  child.writesOut = () => writes
  return child
}

assert.equal(encodeSse('snapshot', { a: 1 }), 'event: snapshot\ndata: {"a":1}\n\n')

{
  const child = fakeChild()
  const jobs = createJobStore({ spawnImpl: () => child })
  const started = jobs.start(getAgent('kimi'))
  assert.equal(started.ok, true)
  assert.equal(jobs.runningCount(), 1)
  const job = started.job
  assert.equal(typeof job.id, 'string')
  assert.ok(job.id.length >= 32)
  assert.deepEqual(job.argv, ['kimi', 'login'])

  // one job per platform: the second start reports the existing job (409 upstream)
  const conflicting = jobs.start(getAgent('kimi'))
  assert.equal(conflicting.conflict, true)
  assert.equal(conflicting.job.id, job.id)

  const request = apiRequest(`${AGENT_ROUTES.loginEvents}?agent=kimi&job=${job.id}`, { headers: sameOriginHeaders })
  const stream = createJobStream(job, request)
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  child.stdout.emit('data', '\u001b[32mGo to https://auth.kimi.test/device?code=ABCD-1234\u001b[0m\n')
  child.emit('exit', 0, null)

  let wire = ''
  for (;;) {
    const step = await reader.read()
    if (step.done === true) break
    wire += decoder.decode(step.value, { stream: true })
  }
  const frames = wire.split('\n\n').filter(frame => frame.trim() !== '')
  const names = frames.map(frame => frame.split('\n')[0].replace('event: ', ''))
  assert.deepEqual(names, ['snapshot', 'chunk', 'exit'], `frame order was ${JSON.stringify(names)}`)
  const snapshot = JSON.parse(frames[0].split('\n')[1].replace('data: ', ''))
  assert.equal(snapshot.jobId, job.id)
  assert.equal(snapshot.done, false)
  assert.equal(snapshot.seq, 0)
  const chunk = JSON.parse(frames[1].split('\n')[1].replace('data: ', ''))
  assert.equal(chunk.seq, 1)
  assert.ok(chunk.text.includes('https://auth.kimi.test/device?code=ABCD-1234'))
  assert.equal(chunk.text.includes('\u001b'), false) // ANSI stripped on the way in
  const exit = JSON.parse(frames[2].split('\n')[1].replace('data: ', ''))
  assert.equal(exit.done, true)
  assert.equal(exit.exitCode, 0)
  assert.deepEqual(exit.links, ['https://auth.kimi.test/device?code=ABCD-1234'])
  assert.equal(jobs.runningCount(), 0)
}

{
  // a stream opened on an already finished job still emits snapshot + exit
  const child = fakeChild()
  const jobs = createJobStore({ spawnImpl: () => child })
  const job = jobs.start(getAgent('trae')).job
  child.stderr.emit('data', 'Paste callback URL to verify automatically:\n')
  child.emit('exit', 1, null)
  assert.equal(job.done, true)
  const stream = createJobStream(job, apiRequest(`${AGENT_ROUTES.loginEvents}?agent=trae&job=${job.id}`, { headers: sameOriginHeaders }))
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let wire = ''
  for (;;) {
    const step = await reader.read()
    if (step.done === true) break
    wire += decoder.decode(step.value, { stream: true })
  }
  const names = wire.split('\n\n').filter(Boolean).map(frame => frame.split('\n')[0].replace('event: ', ''))
  assert.deepEqual(names, ['snapshot', 'exit'])
  assert.ok(wire.includes('"exitCode":1'))
}

{
  // stdin: trae accepts a pasted callback URL, and the job echoes what was sent
  const child = fakeChild()
  const jobs = createJobStore({ spawnImpl: () => child })
  const job = jobs.start(getAgent('trae')).job
  assert.equal(jobs.writeInput(job, 'http://localhost:34119/callback?code=abc'), true)
  assert.deepEqual(child.writesOut(), ['http://localhost:34119/callback?code=abc\n'])
  child.emit('exit', 0, null)
  assert.equal(jobs.writeInput(job, 'too late'), false)
}

{
  // timeout: the job is SIGTERMed, then SIGKILLed after the grace period
  const child = fakeChild()
  const jobs = createJobStore({ spawnImpl: () => child, timeoutMs: 10, killGraceMs: 5 })
  const job = jobs.start(getAgent('kimi')).job
  assert.equal(job.done, false)
  // A plain (non-unref'd) timer: this await IS the only pending work.
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(job.timedOut, true)
  assert.equal(job.done, false) // the fake child never exits, so the job stays open
  job.done = true // let killAll() forget it
}

{
  // global cap: 3 running jobs, the 4th platform is refused
  const children = []
  const jobs = createJobStore({ spawnImpl: () => { const child = fakeChild(); children.push(child); return child } })
  // synthetic specs: the store only needs an id and a login argv, and only two
  // of the real platforms have a page-drivable login command.
  const fakeSpec = id => ({ id, auth: { loginArgv: [id, 'login'], kind: 'device-code' } })
  assert.equal(jobs.start(fakeSpec('one')).ok, true)
  assert.equal(jobs.start(fakeSpec('two')).ok, true)
  assert.equal(jobs.start(fakeSpec('three')).ok, true)
  const fourth = jobs.start(fakeSpec('four'))
  assert.equal(fourth.ok, false)
  assert.equal(fourth.limit, true)
  // killAll sends SIGTERM to every live child
  jobs.killAll()
  assert.equal(children.length, 3)
  assert.deepEqual(children.map(child => child.kills[0]), ['SIGTERM', 'SIGTERM', 'SIGTERM'])
}

// ---------------------------------------------------------------------------
// 授权路由：登录 job / input / cancel / key / logout / test
// ---------------------------------------------------------------------------

const jsonHeaders = Object.assign({}, sameOriginHeaders, { 'content-type': 'application/json' })
clock = 1_000_000 // reuse the cooldown clock above for the agent routes
const agentHandlersWith = (jobs, overrides = {}) => createAgentHandlers(Object.assign({
  agentsStatus: async () => ({ ok: true, agents: [] }),
  jobs,
  logger: null,
  now: () => clock,
}, overrides))

{
  const child = fakeChild()
  const jobs = createJobStore({ spawnImpl: () => child })
  let changed = 0
  const handlerSet = agentHandlersWith(jobs, {
    onChanged: () => { changed += 1 },
    run: async () => okRun('Done'),
    secretsFor: async () => [],
  })

  // method + content-type fence
  const wrongMethod = await handlerSet.login(apiRequest(AGENT_ROUTES.login, { method: 'GET', headers: sameOriginHeaders }))
  assert.equal(wrongMethod.status, 405)
  const noJson = await handlerSet.login(apiRequest(AGENT_ROUTES.login, {
    method: 'POST',
    headers: Object.assign({}, sameOriginHeaders, { 'content-type': 'text/plain' }),
    body: '{"agent":"kimi"}',
  }))
  assert.equal(noJson.status, 415)
  const crossOrigin = await handlerSet.login(apiRequest(AGENT_ROUTES.login, {
    method: 'POST',
    headers: Object.assign({}, jsonHeaders, { origin: 'http://evil.test' }),
    body: JSON.stringify({ agent: 'kimi' }),
  }))
  assert.equal(crossOrigin.status, 403)

  // unknown platform → 404
  const unknown = await handlerSet.login(apiRequest(AGENT_ROUTES.login, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'nope' }),
  }))
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'unknown-agent')

  // a key write for a platform without a key store → 404 key-not-supported
  const noKey = await handlerSet.key(apiRequest(AGENT_ROUTES.key, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'kimi', key: 'x' }),
  }))
  assert.equal(noKey.status, 404)
  assert.equal((await noKey.json()).error.code, 'key-not-supported')

  // logout for kimi (no logout argv) → 400 logout-not-supported
  const noLogout = await handlerSet.logout(apiRequest(AGENT_ROUTES.logout, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'kimi' }),
  }))
  assert.equal(noLogout.status, 400)
  assert.equal((await noLogout.json()).error.code, 'logout-not-supported')

  // first login starts a job
  const first = await handlerSet.login(apiRequest(AGENT_ROUTES.login, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'kimi' }),
  }))
  assert.equal(first.status, 200)
  const firstPayload = await first.json()
  assert.equal(firstPayload.ok, true)
  assert.equal(typeof firstPayload.jobId, 'string')
  assert.equal(firstPayload.argv, 'kimi login')
  assert.ok(firstPayload.startedAt > 0)

  // second login for the same platform → 409 carrying the SAME jobId
  const second = await handlerSet.login(apiRequest(AGENT_ROUTES.login, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'kimi' }),
  }))
  assert.equal(second.status, 409)
  const secondPayload = await second.json()
  assert.equal(secondPayload.error.code, 'job-running')
  assert.equal(secondPayload.jobId, firstPayload.jobId)

  // a job cannot be read or driven through another platform's id
  const foreignEvents = await handlerSet.loginEvents(apiRequest(
    `${AGENT_ROUTES.loginEvents}?agent=trae&job=${firstPayload.jobId}`,
    { headers: sameOriginHeaders },
  ))
  assert.equal(foreignEvents.status, 404)
  const foreignCancel = await handlerSet.loginCancel(apiRequest(AGENT_ROUTES.loginCancel, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'trae', jobId: firstPayload.jobId }),
  }))
  assert.equal(foreignCancel.status, 404)
  // an unknown job id is 404 as well
  const ghostJob = await handlerSet.loginCancel(apiRequest(AGENT_ROUTES.loginCancel, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'kimi', jobId: 'nope' }),
  }))
  assert.equal(ghostJob.status, 404)

  // kimi does not take stdin
  const kimiInput = await handlerSet.loginInput(apiRequest(AGENT_ROUTES.loginInput, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'kimi', jobId: firstPayload.jobId, text: 'x' }),
  }))
  assert.equal(kimiInput.status, 400)
  assert.equal((await kimiInput.json()).error.code, 'input-not-supported')

  // trae does: the line reaches the child's stdin
  const traeJob = jobs.start(getAgent('trae')).job
  const traeInput = await handlerSet.loginInput(apiRequest(AGENT_ROUTES.loginInput, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'trae', jobId: traeJob.id, text: 'http://localhost:1/cb?code=z' }),
  }))
  assert.equal(traeInput.status, 200)
  assert.deepEqual(child.writesOut(), ['http://localhost:1/cb?code=z\n'])

  // cancel sends SIGTERM through the store
  const cancel = await handlerSet.loginCancel(apiRequest(AGENT_ROUTES.loginCancel, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'kimi', jobId: firstPayload.jobId }),
  }))
  assert.equal(cancel.status, 200)
  assert.equal((await cancel.json()).ok, true)
  assert.equal(child.kills[0], 'SIGTERM')
  assert.equal(changed, 0) // no credential changed, so no cache invalidation
  jobs.killAll()
}

{
  // test cooldown: one real call per 60s per platform (429 in between)
  let calls = 0
  const jobs = createJobStore({ spawnImpl: () => fakeChild() })
  const handlerSet = agentHandlersWith(jobs, {
    run: async () => {
      calls += 1
      return okRun('pong')
    },
  })
  const body = JSON.stringify({ agent: 'deepseek-harness' })
  const first = await handlerSet.test(apiRequest(AGENT_ROUTES.test, { method: 'POST', headers: jsonHeaders, body }))
  assert.equal(first.status, 200)
  const firstPayload = await first.json()
  assert.equal(firstPayload.ok, true)
  assert.equal(firstPayload.exitCode, 0)
  assert.equal(typeof firstPayload.durationMs, 'number')
  assert.equal(calls, 1)
  const second = await handlerSet.test(apiRequest(AGENT_ROUTES.test, { method: 'POST', headers: jsonHeaders, body }))
  assert.equal(second.status, 429)
  assert.equal((await second.json()).error.code, 'test-too-frequent')
  assert.equal(calls, 1)
  clock += 60_000
  const third = await handlerSet.test(apiRequest(AGENT_ROUTES.test, { method: 'POST', headers: jsonHeaders, body }))
  assert.equal(third.status, 200)
  assert.equal(calls, 2)
  // antigravity is refused without running anything
  const unavailable = await handlerSet.test(apiRequest(AGENT_ROUTES.test, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agent: 'antigravity' }),
  }))
  assert.equal(unavailable.status, 400)
  assert.equal((await unavailable.json()).error.code, 'test-not-supported')
}

// testAgent: ENOENT and output redaction
{
  const missing = await testAgent(getAgent('qwen'), {
    run: async () => ({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, notFound: true, error: 'ENOENT' }),
    now: () => 0,
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.diagnostic, 'acpx 未安装')
  const failed = await testAgent(getAgent('qwen'), {
    run: async () => ({ code: 1, signal: null, stdout: 'key=SECRET9999', stderr: 'boom SECRET9999', timedOut: false, notFound: false, error: '' }),
    secrets: ['SECRET9999'],
    now: () => 0,
  })
  assert.equal(failed.ok, false)
  assert.equal(JSON.stringify(failed).includes('SECRET9999'), false)
  assert.ok(failed.stdout.includes('****9999'))
}

// ---------------------------------------------------------------------------
// 密钥写盘：qwen 保留其它 agent 与未知字段；opencode 校验失败回滚
// ---------------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), 'acpx-bridge-qwen-write-'))
  const file = join(dir, 'config.json')
  const seed = {
    agents: {
      codebuddy: { argv: ['codebuddy', '--acp'] },
      opencode: { argv: ['opencode', 'acp'], extra: { keep: true } },
      kiro: { argv: ['kiro-cli', 'acp'] },
      qwen: { argv: ['qwen', '--acp', '--auth-type', 'openai', '--openai-api-key', 'OLDKEY1234', '--model', 'old-model'] },
    },
    unknownTop: { keep: [1, 2, 3] },
    version: 7,
  }
  await writeFile(file, `${JSON.stringify(seed, null, 2)}\n`)
  const result = await writeQwenKey({
    apiKey: 'NEWSECRET9999',
    baseURL: 'http://gw/v1',
    model: 'gs/deepseek-flash',
    file,
  })
  assert.equal(result.ok, true)
  assert.equal(result.configured, true)
  assert.equal(result.maskedKey, '****9999')
  assert.equal(result.baseURL, 'http://gw/v1')
  assert.equal(result.model, 'gs/deepseek-flash')
  assert.equal(JSON.stringify(result).includes('NEWSECRET9999'), false)

  const after = JSON.parse(await readFile(file, 'utf8'))
  // every other agent and every unknown field survives verbatim
  assert.deepEqual(after.agents.codebuddy, seed.agents.codebuddy)
  assert.deepEqual(after.agents.opencode, seed.agents.opencode)
  assert.deepEqual(after.agents.kiro, seed.agents.kiro)
  assert.deepEqual(after.unknownTop, seed.unknownTop)
  assert.equal(after.version, 7)
  assert.deepEqual(after.agents.qwen.argv, [
    'qwen', '--acp', '--auth-type', 'openai', '--openai-api-key', 'NEWSECRET9999',
    '--openai-base-url', 'http://gw/v1', '--model', 'gs/deepseek-flash',
  ])
  const files = await readdir(dir)
  assert.ok(files.some(name => name.startsWith('config.json.bak-')), 'a .bak-<timestamp> backup is written first')

  // removing the key strips only this page's three flags
  const removed = await removeQwenKey({ file })
  assert.equal(removed.ok, true)
  assert.equal(removed.removed, true)
  const stripped = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(stripped.agents.qwen.argv, ['qwen', '--acp', '--auth-type', 'openai'])
  assert.deepEqual(stripped.agents.codebuddy, seed.agents.codebuddy)
  assert.deepEqual(stripped.unknownTop, seed.unknownTop)
  assert.equal(JSON.stringify(removed).includes('NEWSECRET9999'), false)

  // a second removal is a no-op
  const again = await removeQwenKey({ file })
  assert.equal(again.removed, false)

  // a broken config is reported, never overwritten
  await writeFile(file, '{broken json')
  const brokenWrite = await writeQwenKey({ apiKey: 'X1234', file })
  assert.equal(brokenWrite.ok, false)
  assert.equal(brokenWrite.code, 'config-read-failed')
  assert.equal(await readFile(file, 'utf8'), '{broken json')

  // an invalid baseURL is refused before any write
  await writeFile(file, '{}')
  const badURL = await writeQwenKey({ apiKey: 'X1234', baseURL: 'ftp://nope', file })
  assert.equal(badURL.ok, false)
  assert.equal(badURL.code, 'invalid-base-url')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {})

  // the default paths are the platform ones
  assert.equal(acpxConfigFile({ home: '/home/u' }), join('/home/u', '.acpx', 'config.json'))
  assert.equal(opencodeAuthFile({ home: '/home/u' }), join('/home/u', '.local', 'share', 'opencode', 'auth.json'))
  assert.equal(opencodeAuthFile({ home: '/home/u', xdgDataHome: '/xdg' }), join('/xdg', 'opencode', 'auth.json'))
}

{
  const dir = await mkdtemp(join(tmpdir(), 'acpx-bridge-opencode-write-'))
  await mkdir(join(dir, 'opencode'), { recursive: true })
  const file = join(dir, 'opencode', 'auth.json')
  const original = { openai: { type: 'api', key: 'KEEPOLD5678' } }
  await writeFile(file, `${JSON.stringify(original, null, 2)}\n`)

  // verification fails → the previous bytes are restored
  const failed = await writeOpencodeKey({
    provider: 'anthropic',
    key: 'NEWKEY1234',
    file,
    run: async () => okRun('\u001b[90m└  0 credentials\u001b[0m\n'),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'key-verify-failed')
  assert.equal(failed.rolledBack, true)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original)
  assert.equal(JSON.stringify(failed).includes('NEWKEY1234'), false)

  // the CLI refusing to run also rolls back
  const missingCli = await writeOpencodeKey({
    provider: 'anthropic',
    key: 'NEWKEY1234',
    file,
    run: async () => ({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, notFound: true, error: 'ENOENT' }),
  })
  assert.equal(missingCli.ok, false)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original)

  // success: structure `{ provider: { type:'api', key } }`, other providers kept
  const good = await writeOpencodeKey({
    provider: 'anthropic',
    key: 'NEWKEY1234',
    file,
    run: async () => okRun('Credentials ~/.local/share/opencode/auth.json\nanthropic api\n2 credentials\n'),
  })
  assert.equal(good.ok, true)
  assert.equal(good.provider, 'anthropic')
  assert.equal(good.maskedKey, '****1234')
  assert.equal(JSON.stringify(good).includes('NEWKEY1234'), false)
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(written.openai, original.openai)
  assert.deepEqual(written.anthropic, { type: 'api', key: 'NEWKEY1234' })

  // invalid provider ids are refused before touching the file
  const badProvider = await writeOpencodeKey({ provider: '../etc', key: 'x', file, run: async () => okRun('1 credentials') })
  assert.equal(badProvider.ok, false)
  assert.equal(badProvider.code, 'invalid-provider')
  const emptyKey = await writeOpencodeKey({ provider: 'openai', key: '   ', file, run: async () => okRun('') })
  assert.equal(emptyKey.ok, false)
  assert.equal(emptyKey.code, 'invalid-key')
}

// no response or log line of this surface may ever carry a complete key
{
  const dir = await mkdtemp(join(tmpdir(), 'acpx-bridge-secret-'))
  const configFile = join(dir, 'config.json')
  const authFile = join(dir, 'auth.json')
  await writeFile(configFile, JSON.stringify({ agents: { qwen: { argv: ['qwen', '--acp', '--openai-api-key', 'QWENKEY4321'] } } }))
  await writeFile(authFile, JSON.stringify({ openai: { type: 'api', key: 'OPENKEY8765' } }))
  const qwenWrite = await writeQwenKey({ apiKey: 'QWENKEY4321', file: configFile })
  const openWrite = await writeOpencodeKey({
    provider: 'openai', key: 'OPENKEY8765', file: authFile, run: async () => okRun('1 credentials'),
  })
  for (const payload of [qwenWrite, openWrite]) {
    const wire = JSON.stringify(payload)
    assert.equal(wire.includes('QWENKEY4321'), false)
    assert.equal(wire.includes('OPENKEY8765'), false)
    assert.ok(wire.includes('****'))
  }
  // the CLI-facing argv helpers scrub too
  assert.equal(redactKey('["--openai-api-key","QWENKEY4321"]', 'QWENKEY4321').includes('QWENKEY4321'), false)
}

// the agent route table is exact-path and method-complete
{
  const paths = Object.values(AGENT_ROUTES)
  assert.equal(new Set(paths).size, paths.length)
  for (const path of paths) assert.ok(path.startsWith('/api/acpx-bridge/agents'))
  for (const method of Object.values(AGENT_ROUTE_METHODS)) {
    assert.ok(method.every(entry => ['GET', 'HEAD', 'POST'].includes(entry)))
  }
}


console.log('✓ dsh-acpx-bridge selftest passed (config, adapter, prefs, model filtering, Fetch route fence + handlers, verify cooldown + probes, tool-call SSE, command building, 7-platform auth table + probes, login jobs + SSE frames, key write/rollback, test cooldown)')
