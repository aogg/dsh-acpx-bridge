/**
 * dsh-acpx-bridge
 *
 * A DeepSeek Harness (dsh) plugin that registers an `acpx_delegate` tool,
 * letting the in-harness model drive other coding agents through the `acpx`
 * headless ACP client.
 *
 *   model (inside dsh)  --calls-->  acpx_delegate tool  --spawns-->  acpx <agent> exec "<task>"
 *
 * It also registers an LLM adapter so configured models appear in dsh's model
 * selector and real calls go to an OpenAI-compatible endpoint (see config.js).
 *
 * Why a tool instead of a subagent provider:
 *   acpx itself is an ACP *client* with 30 built-in agent profiles and a stable
 *   one-shot `exec` command. Wrapping it as a single tool is the smallest, most
 *   robust integration and keeps the whole CLI surface (agent choice, --cwd,
 *   permission policy, --format json) available to the model.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config, PROVIDER, allModelIds, resolveConfig } from './config.js'
import { AcpxBridgeAdapter } from './llm-adapter.js'

const execFileAsync = promisify(execFile)

export const name = 'acpx-bridge'
export const inject = ['tools', 'llm']
export { Config }

// ---------------------------------------------------------------------------
// Configuration (env-overridable; no credentials stored here)
// ---------------------------------------------------------------------------

const ACPX_BIN = process.env.ACPX_BIN || 'acpx'
const DEFAULT_AGENT = process.env.ACPX_DEFAULT_AGENT || 'codex'
const DEFAULT_FORMAT = 'quiet' // quiet | json | text
const DEFAULT_APPROVE = 'reads' // reads | all | none
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_STDOUT_CHARS = 200_000
const MAX_RENDER_CHARS = 12_000

// acpx built-in profile names (see https://acpx.sh/agents.html) — exposed to
// the model as a hint only; any custom ACP server works via `--agent`.
const KNOWN_AGENTS = [
  'codex', 'claude', 'gemini', 'cursor', 'copilot', 'opencode', 'qwen',
  'kimi', 'droid', 'goose', 'iflow', 'junie', 'kilocode', 'kiro', 'mcode',
  'mux', 'pool', 'qoder', 'trae', 'zeroclaw', 'pi', 'openclaw',
  'deepseek-harness', 'devin', 'factory', 'fast-agent', 'fx', 'grok-build',
  'antigravity', 'ante', 'octomind',
]

// ---------------------------------------------------------------------------
// Pure command builder (unit-testable without acpx installed)
// ---------------------------------------------------------------------------

/**
 * Build the argv for a one-shot or named-session acpx invocation.
 * Global flags go before the agent subcommand, matching the acpx CLI.
 */
export function buildAcpxArgs({
  agent = DEFAULT_AGENT,
  task,
  cwd,
  mode = 'exec',
  session,
  approve = DEFAULT_APPROVE,
  format = DEFAULT_FORMAT,
  model,
} = {}) {
  if (!task || typeof task !== 'string') {
    throw new TypeError('buildAcpxArgs: `task` must be a non-empty string')
  }
  if (!agent || typeof agent !== 'string') {
    throw new TypeError('buildAcpxArgs: `agent` must be a non-empty string')
  }

  const args = ['--format', format]

  if (approve === 'all') args.push('--approve-all')
  else if (approve === 'none') args.push('--deny-all')
  else args.push('--approve-reads') // default

  if (model) args.push('--model', model)
  if (cwd) args.push('--cwd', cwd)

  args.push(agent)

  if (mode === 'session') {
    if (!session) {
      throw new TypeError('buildAcpxArgs: `session` is required when mode=session')
    }
    args.push('-s', session)
  } else {
    args.push('exec')
  }

  args.push(task)
  return args
}

/** Build argv for creating a named persistent session. */
export function buildSessionNewArgs(agent, session) {
  if (!agent || !session) {
    throw new TypeError('buildSessionNewArgs: agent and session are required')
  }
  return [agent, 'sessions', 'new', '--name', session]
}

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + `\n… [truncated ${s.length - max} chars]` : s
}

function truncateForStore(text) {
  return clip(text, MAX_STDOUT_CHARS)
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const options = resolveConfig(config)
  const tools = options.tools
  const agentChoices = tools.length ? tools.map(tool => tool.name) : KNOWN_AGENTS
  const defaultAgent = agentChoices[0] || DEFAULT_AGENT
  const modelIds = allModelIds(tools)
  const modelsByAgent = new Map(tools.map(tool => [tool.name, tool.models ?? []]))

  // Register the LLM adapter so configured models appear in dsh's model selector.
  const adapter = new AcpxBridgeAdapter({
    ...options,
    tools: () => resolveConfig(config).tools,
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.emit('llm/models-updated', PROVIDER)
  ctx.on('loader/volatile-update', () => ctx.emit('llm/models-updated', PROVIDER))

  ctx.tools.register(defineTool({
    name: 'acpx_delegate',
    description:
      'Delegate a coding task to another AI coding agent through acpx (headless ACP client). ' +
      'Use this to parallelise work or hand a task to a specialised agent. ' +
      `Configured agents: ${agentChoices.join(', ')}. ` +
      `Agent → models: ${tools.map(tool => `${tool.name}=[${(tool.models ?? []).join(', ')}]`).join('; ') || 'none'}. ` +
      'Pass a self-contained task description — the child agent cannot see this conversation. ' +
      'For a throwaway run keep mode=exec; use mode=session with a `session` name to keep ' +
      'a persistent, resumable conversation scoped to the repo. ' +
      'Set format=json to get structured ACP events (tool calls, diffs), quiet for final text only.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'A complete, self-contained task description for the child agent.',
      },
      agent: {
        type: 'string',
        enum: agentChoices,
        description: `Configured command tool (acpx agent profile). Defaults to ${defaultAgent}.`,
      },
      model: {
        type: 'string',
        enum: modelIds,
        description: `Optional model id for this agent, passed to acpx as --model. Choices: ${modelIds.join(', ') || 'none'}.`,
      },
      cwd: {
        type: 'string',
        description: 'Absolute working directory for the child agent (its repo root). Defaults to the dsh workspace.',
      },
      mode: {
        type: 'string',
        enum: ['exec', 'session'],
        description: 'exec = one-shot stateless run; session = persistent named conversation.',
      },
      session: {
        type: 'string',
        description: 'Session name (required for mode=session, e.g. "backend", "pr-842").',
      },
      approve: {
        type: 'string',
        enum: ['reads', 'all', 'none'],
        description: 'Permission policy: reads (default, auto-approve reads), all (auto-approve everything), none (deny all tool calls).',
      },
      format: {
        type: 'string',
        enum: ['quiet', 'json', 'text'],
        description: 'Output format: quiet (final assistant text, default), json (NDJSON ACP events), text (human readable).',
      },
      timeoutMs: {
        type: 'number',
        description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          agent: { type: 'string' },
          mode: { type: 'string' },
          session: { type: 'string' },
          command: { type: 'string' },
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          durationMs: { type: 'number' },
          diagnostic: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const head = value.ok
          ? `acpx → ${value.agent} (${value.mode})${value.session ? ` session=${value.session}` : ''} exited ${value.exitCode}`
          : `acpx → ${value.agent} FAILED: ${value.diagnostic || `exit ${value.exitCode}`}`
        const body = clip(value.stdout || '', MAX_RENDER_CHARS)
        return [{ type: 'text', text: body ? `${head}\n\n${body}` : head }]
      },
    },
    async execute(args, exec) {
      const started = Date.now()
      const {
        task,
        agent = defaultAgent,
        model,
        cwd,
        mode = 'exec',
        session,
        approve = DEFAULT_APPROVE,
        format = DEFAULT_FORMAT,
        timeoutMs = DEFAULT_TIMEOUT_MS,
      } = args

      const base = {
        agent,
        mode,
        session: session || '',
        command: '',
        exitCode: -1,
        stdout: '',
        stderr: '',
        durationMs: 0,
      }

      // Reject a model that is not declared under the selected command tool.
      if (model) {
        const allowed = modelsByAgent.get(agent) ?? []
        if (allowed.length && !allowed.includes(model)) {
          return {
            ...base,
            ok: false,
            diagnostic: `model "${model}" is not configured for agent "${agent}" (allowed: ${allowed.join(', ')})`,
            durationMs: Date.now() - started,
          }
        }
      }

      // For session mode, best-effort create the named session first.
      if (mode === 'session' && session) {
        try {
          await execFileAsync(ACPX_BIN, buildSessionNewArgs(agent, session), {
            timeout: Math.min(timeoutMs, 30_000),
            signal: exec.signal,
            maxBuffer: 1024 * 1024,
          })
        } catch {
          // Session may already exist — the send below still works. Ignore.
        }
      }

      let argv
      try {
        argv = buildAcpxArgs({ agent, task, cwd, mode, session, approve, format, model })
      } catch (err) {
        return {
          ...base,
          ok: false,
          diagnostic: err.message,
          durationMs: Date.now() - started,
        }
      }
      base.command = [ACPX_BIN, ...argv].join(' ')

      try {
        const { stdout, stderr } = await execFileAsync(ACPX_BIN, argv, {
          cwd: cwd || undefined,
          timeout: Number(timeoutMs),
          signal: exec.signal,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env },
        })
        return {
          ...base,
          ok: true,
          exitCode: 0,
          stdout: truncateForStore(stdout),
          stderr: truncateForStore(stderr),
          durationMs: Date.now() - started,
        }
      } catch (err) {
        // Let AbortError propagate per dsh tool contract.
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err

        const timedOut = err?.killed || err?.code === 'ETIMEDOUT'
        const missing = err?.code === 'ENOENT'
        let diagnostic
        if (missing) {
          diagnostic = `acpx executable not found (${ACPX_BIN}). Install it with: npm install -g acpx@latest`
        } else if (timedOut) {
          diagnostic = `acpx timed out after ${timeoutMs}ms`
        } else {
          diagnostic = clip(err?.message || String(err), 1000)
        }
        return {
          ...base,
          ok: false,
          exitCode: err?.code ?? -1,
          stdout: truncateForStore(err?.stdout || ''),
          stderr: truncateForStore(err?.stderr || err?.message || ''),
          diagnostic,
          durationMs: Date.now() - started,
        }
      }
    },
  }))

  // A small companion tool: list configured command tools + their models.
  ctx.tools.register(defineTool({
    name: 'acpx_agents',
    description: 'List configured acpx command tools (agents), their models, and built-in agent profiles.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                models: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
          },
          known: { type: 'array', items: { type: 'string' } },
          count: { type: 'number' },
          note: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.count} configured tools:\n`
            + value.tools.map(tool => `- ${tool.name}: ${tool.models.join(', ') || '(no models)'}`).join('\n')
            + `\n\nBuilt-in acpx agents: ${value.known.join(', ')}\n\n${value.note}`,
        },
      ],
    },
    async execute() {
      const current = resolveConfig(config).tools
      return {
        tools: current,
        known: KNOWN_AGENTS,
        count: current.length,
        note: `Using acpx binary: ${ACPX_BIN}. LLM provider: ${PROVIDER}.`,
      }
    },
  }))
}

export default { name, inject, apply }
