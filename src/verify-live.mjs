/**
 * Live smoke test: call the adapter's stream() against the real endpoint.
 * No dsh runtime and no acpx binary needed.
 *
 *   ACPX_BRIDGE_API_KEY=<key> node src/verify-live.mjs
 *
 * The key is read from the environment only; it is never stored in this file.
 */

import assert from 'node:assert/strict'
import { Config, PROVIDER, resolveConfig } from './config.js'
import { AcpxBridgeAdapter } from './llm-adapter.js'

const config = resolveConfig(Config({}))
const adapter = new AcpxBridgeAdapter(config)
const model = config.tools[0].models[0]

const options = {
  provider: PROVIDER,
  model,
  messages: [{ role: 'user', content: 'Reply with only the single word: PONG' }],
}

const chunks = []
for await (const chunk of adapter.stream(options)) chunks.push(chunk)

const kinds = chunks.map(chunk => chunk.type)
const text = chunks
  .filter(chunk => chunk.type === 'text-delta')
  .map(chunk => chunk.text)
  .join('')
const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
const finish = chunks.find(chunk => chunk.type === 'finish')

console.log('chunks:', kinds.join(' '))
console.log('text:', JSON.stringify(text))
console.log('usage:', JSON.stringify(usage))
console.log('finish:', JSON.stringify(finish?.reason))

assert.match(text, /PONG/i, 'expected the model to reply PONG')
assert.equal(kinds.at(-1), 'finish', 'finish must be the last chunk')
assert.ok(kinds.indexOf('usage') < kinds.lastIndexOf('finish'), 'usage must precede finish')

console.log('✓ live endpoint PONG verified via adapter.stream()')
