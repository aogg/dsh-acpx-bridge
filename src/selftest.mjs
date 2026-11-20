/**
 * Self-test for the pure command-building logic. Runs with plain Node, no
 * harness and no acpx binary required.
 *   node src/selftest.mjs
 */
import assert from 'node:assert/strict'
import { buildAcpxArgs, buildSessionNewArgs } from './index.js'

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

console.log('✓ dsh-acpx-bridge selftest passed (6 assertions)')
