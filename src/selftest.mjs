/**
 * Self-test for the pure logic. Runs with plain Node, no harness, no acpx and
 * no network required.
 *   node src/selftest.mjs
 */
import assert from 'node:assert/strict'
import { buildAcpxArgs, buildSessionNewArgs, Config, inject } from './index.js'
import { allModelIds, displayNameForModel, toWireModel, resolveConfig, PROVIDER } from './config.js'
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
assert.equal(displayNameForModel('gs/deepseek-flash-deepseek.com'), 'acpx/deepseek-flash')
assert.equal(toWireModel('gs/deepseek-flash-deepseek.com'), 'deepseek-flash')

// adapter advertises the configured models without any network call
const adapter = new AcpxBridgeAdapter(resolved)
const models = await adapter.listModels(PROVIDER)
assert.equal(models.length, 1)
assert.equal(models[0].id, 'gs/deepseek-flash-deepseek.com')
assert.equal(models[0].name, 'acpx/deepseek-flash')
const info = await adapter.resolveModel(PROVIDER, models[0].id)
assert.equal(info.context.contextWindow, 131072)
assert.equal(info.defaultMaxTokens, 8192)

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
