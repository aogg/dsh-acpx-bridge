/**
 * Self-test for the pure logic. Runs with plain Node, no harness, no acpx and
 * no network required.
 *   node src/selftest.mjs
 */
import assert from 'node:assert/strict'
import { buildAcpxArgs, buildSessionNewArgs, Config, inject } from './index.js'
import {
  allModelIds,
  baseDisplayName,
  displayNameForModel,
  modelDisplayNames,
  toWireModel,
  resolveConfig,
  PROVIDER,
} from './config.js'
import { AcpxBridgeAdapter } from './llm-adapter.js'
import { translateOpenAi } from './openai-stream.js'

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

console.log('✓ dsh-acpx-bridge selftest passed (config, adapter, tool-call SSE, command building)')
