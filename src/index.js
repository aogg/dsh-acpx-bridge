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
 * selector and real calls go to an OpenAI-compatible endpoint (see config.js),
 * plus the HTTP surface behind the browser settings page (see api.js).
 *
 * Persistence split (deliberate):
 *   - model/endpoint/parameter preferences -> `<DSH_HOME>/storages/acpx-bridge/prefs.json`
 *     (own JSON document, atomic write; never the profile's cordis.patch.yml);
 *   - the API key -> the harness credential seam only (`ACPX_BRIDGE_API_KEY`),
 *     so it is never written into a settings file and never returned to a browser.
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  API_KEY_ENV,
  Config,
  PROVIDER,
  allModelIds,
  endpointInfo,
  readConfigValue,
  resolveConfig,
  toWireModel,
} from './config.js'
import { AcpxBridgeAdapter } from './llm-adapter.js'
import {
  DEFAULT_PREFS,
  PrefsStore,
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  enabledModelIds,
  isModelDisabled,
  isPlaceholderModel,
  modelDisplayName,
} from './prefs.js'
import {
  ACPX_CHECK_TIMEOUT_MS,
  buildState,
  checkAcpx,
  createApiHandlers,
  verifyConnection,
} from './api.js'

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
const MAX_STDOUT_CHARS = 200_000
const MAX_RENDER_CHARS = 12_000
/** How long one acpx probe answer is reused before `--version` runs again. */
const ACPX_CACHE_MS = 10_000

// acpx built-in profile names (see https://acpx.sh/agents.html) — exposed to
// the model as a hint only; any custom ACP server works via `--agent`.
const KNOWN_AGENTS = [
  'codex', 'claude', 'gemini', 'cursor', 'copilot', 'opencode', 'qwen',
  'kimi', 'droid', 'goose', 'iflow', 'junie', 'kilocode', 'kiro', 'mcode',
  'mux', 'pool', 'qoder', 'trae', 'zeroclaw', 'pi', 'openclaw',
  'deepseek-harness', 'devin', 'factory', 'fast-agent', 'fx', 'grok-build',
  'antigravity', 'ante', 'octomind',
]

/** Read this package's version for the settings page. */
function readPluginVersion(logger) {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0'
  } catch (error) {
    logger?.warn?.(`[acpx-bridge] unable to read package.json version: ${error?.message ?? error}`)
    return '0.0.0'
  }
}

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

export async function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-acpx-bridge') : (ctx.logger ?? console)
  const version = readPluginVersion(logger)

  // Own preference document, loaded once; every later read is a snapshot.
  const store = new PrefsStore({ logger })
  await store.load()

  const options = resolveConfig(config)
  const tools = options.tools
  const agentChoices = tools.length ? tools.map(tool => tool.name) : KNOWN_AGENTS
  const defaultAgent = agentChoices[0] || DEFAULT_AGENT
  const modelIds = allModelIds(tools)

  /** The credential seam is optional: the plugin works with Config only. */
  const getCredentials = () => (typeof ctx.get === 'function' ? ctx.get('credentials') : undefined)

  /** API key precedence: Config (may be env-injected) > credential store > ''. */
  async function resolveApiKey() {
    const current = resolveConfig(config)
    if (current.apiKey) return current.apiKey
    const credentials = getCredentials()
    if (!credentials || typeof credentials.resolve !== 'function') return ''
    try {
      const resolved = await credentials.resolve(API_KEY_ENV)
      return typeof resolved?.value === 'string' ? resolved.value : ''
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] credential resolve failed: ${error?.message ?? error}`)
      return ''
    }
  }

  /**
   * Presence-only credential view for the page (never the value):
   * `{ ref, configured, source, writable }`.
   */
  async function credentialView() {
    const view = { ref: API_KEY_ENV, configured: false, source: '', writable: true }
    const credentials = getCredentials()
    if (credentials && typeof credentials.describe === 'function') {
      try {
        const info = await credentials.describe(API_KEY_ENV)
        view.configured = info?.configured === true
        view.source = typeof info?.source === 'string' ? info.source : ''
        view.writable = info?.writable !== false
      } catch (error) {
        logger?.warn?.(`[acpx-bridge] credential describe failed: ${error?.message ?? error}`)
      }
    }
    // A key injected through the cordis config (usually `!!js process.env.…`)
    // cannot be edited from the browser: the config layer wins over the store.
    const configKey = readConfigValue(config.apiKey)
    const envKey = typeof process.env[API_KEY_ENV] === 'string' ? process.env[API_KEY_ENV] : ''
    if (typeof configKey === 'string' && configKey) {
      view.configured = true
      view.source = 'config'
      view.writable = false
    } else if (envKey) {
      view.configured = true
      if (!view.source) view.source = 'env'
      view.writable = false
    }
    if (!view.configured) view.source = ''
    return view
  }

  /**
   * Effective endpoint + where it came from; the page override wins.
   * `fallback` is what applies once the override is cleared, so the page can
   * tell the user which endpoint "reset to default" actually returns to.
   */
  function endpointView(prefs) {
    const base = endpointInfo(config)
    if (prefs.baseURLOverride) {
      return { effective: prefs.baseURLOverride, source: 'prefs', fallback: base.effective }
    }
    return base
  }

  let acpxCache = { at: 0, value: null }

  /** Cached `acpx --version` probe; `force` bypasses the cache. */
  async function acpxStatus({ force = false } = {}) {
    const now = Date.now()
    if (!force && acpxCache.value && now - acpxCache.at < ACPX_CACHE_MS) return acpxCache.value
    const probed = await checkAcpx({ bin: ACPX_BIN, timeoutMs: ACPX_CHECK_TIMEOUT_MS })
    const value = { bin: ACPX_BIN, ...probed }
    acpxCache = { at: Date.now(), value }
    return value
  }

  /** One `/state` body: everything the settings page renders. */
  async function snapshot() {
    const current = resolveConfig(config)
    const prefs = store.read()
    return buildState({
      version,
      provider: PROVIDER,
      entryId: name,
      endpoint: endpointView(prefs),
      credential: await credentialView(),
      acpx: await acpxStatus(),
      prefs,
      wireModels: current.wireModels ?? {},
      notes: {
        configSource: 'profile cordis 配置（cordis.patch.yml / --patch）',
        docs: 'docs/设置页.md',
      },
      tools: current.tools,
    })
  }

  /**
   * Tell the host's model catalogue to re-read the adapters, so the model
   * selector reflects a just-toggled model without a reload.
   * `llm/adapters-updated` is what this dsh build actually forwards to the
   * client; `llm/models-updated` is emitted as the task-level compatibility
   * name for external watchers.
   */
  function announceModels() {
    ctx.emit('llm/adapters-updated')
    ctx.emit('llm/models-updated', PROVIDER)
  }

  // Register the LLM adapter so configured models appear in dsh's model selector.
  const adapter = new AcpxBridgeAdapter({
    tools: () => resolveConfig(config).tools,
    prefs: () => store.read(),
    resolveConnection: async () => {
      const current = resolveConfig(config)
      const prefs = store.read()
      return {
        baseURL: prefs.baseURLOverride || current.baseURL,
        apiKey: await resolveApiKey(),
        wireModels: current.wireModels ?? {},
      }
    },
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  announceModels()
  ctx.on('loader/volatile-update', () => announceModels())

  ctx.tools.register(defineTool({
    name: 'acpx_delegate',
    description:
      'Delegate a coding task to another AI coding agent through acpx (headless ACP client). ' +
      'Use this to parallelise work or hand a task to a specialised agent. ' +
      `Configured agents: ${agentChoices.join(', ')}. ` +
      `Agent → models: ${tools.map(tool => `${tool.name}=[${(tool.models ?? []).join(', ')}]`).join('; ') || 'none'}. ` +
      'Models may be switched off on the acpx-bridge settings page; a switched-off model is refused here. ' +
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
        description: `Configured command tool (acpx agent profile). Defaults to the settings-page default, else ${defaultAgent}.`,
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
        description: 'exec = one-shot stateless run; session = persistent named conversation. Defaults to the settings-page default.'
      },
      session: {
        type: 'string',
        description: 'Session name (required for mode=session, e.g. "backend", "pr-842").',
      },
      approve: {
        type: 'string',
        enum: ['reads', 'all', 'none'],
        description: 'Permission policy: reads (auto-approve reads), all (auto-approve everything), none (deny all tool calls). Defaults to the settings-page default, else reads.',
      },
      format: {
        type: 'string',
        enum: ['quiet', 'json', 'text'],
        description: 'Output format: quiet (final assistant text), json (NDJSON ACP events), text (human readable). Defaults to the settings-page default, else quiet.',
      },
      timeoutMs: {
        type: 'number',
        description: `Timeout in milliseconds (${TIMEOUT_MIN_MS}..${TIMEOUT_MAX_MS}). Default ${TIMEOUT_DEFAULT_MS}, or the settings-page default.`,
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
      const prefs = store.read()
      const settingsDefaults = prefs.defaults ?? DEFAULT_PREFS.defaults
      const configuredAgent = settingsDefaults.agent && agentChoices.includes(settingsDefaults.agent)
        ? settingsDefaults.agent
        : defaultAgent
      const {
        task,
        agent = configuredAgent,
        model,
        cwd,
        mode = settingsDefaults.mode,
        session,
        approve = settingsDefaults.approve,
        format = settingsDefaults.format,
        timeoutMs = settingsDefaults.timeoutMs,
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

      // A model switched off on the settings page is refused here: the tool's
      // `enum` cannot be updated live, so execution is the enforcement point.
      if (model) {
        if (isModelDisabled(prefs, model)) {
          return {
            ...base,
            ok: false,
            diagnostic: `model "${model}" 已在 acpx-bridge 设置页停用（模型显示 → 开关）；请换用其它模型或在设置页重新启用`,
            durationMs: Date.now() - started,
          }
        }
        const allowed = (new Map(resolveConfig(config).tools.map(tool => [tool.name, tool.models ?? []]))).get(agent) ?? []
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
            timeout: Math.min(Number(timeoutMs), 30_000),
            signal: exec.signal,
            maxBuffer: 1024 * 1024,
          })
        } catch (error) {
          // Session may already exist — the send below still works.
          logger?.debug?.(`[acpx-bridge] session pre-create skipped: ${error?.message ?? error}`)
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
    description: 'List configured acpx command tools (agents), their models and whether each model is enabled, plus built-in agent profiles.',
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
                models: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      enabled: { type: 'boolean' },
                      placeholder: { type: 'boolean' },
                    },
                    additionalProperties: false,
                  },
                },
                enabledCount: { type: 'number' },
                totalCount: { type: 'number' },
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
            + value.tools.map(tool =>
              `- ${tool.name} (${tool.enabledCount}/${tool.totalCount} enabled): `
              + (tool.models.length
                ? tool.models.map(model => `${model.enabled ? '✓' : '✗'} ${model.id}`).join(', ')
                : '(no models)'),
            ).join('\n')
            + `\n\nBuilt-in acpx agents: ${value.known.join(', ')}\n\n${value.note}`,
        },
      ],
    },
    async execute() {
      const current = resolveConfig(config).tools
      const prefs = store.read()
      const currentTools = current.map(tool => {
        const models = (tool.models ?? []).map(id => ({
          id,
          name: modelDisplayName(id, current, prefs),
          enabled: !isModelDisabled(prefs, id),
          placeholder: isPlaceholderModel(id),
        }))
        return {
          name: tool.name,
          models,
          enabledCount: models.filter(model => model.enabled).length,
          totalCount: models.length,
        }
      })
      return {
        tools: currentTools,
        known: KNOWN_AGENTS,
        count: currentTools.length,
        note: `Using acpx binary: ${ACPX_BIN}. LLM provider: ${PROVIDER}. Preferences: ${store.file}.`,
      }
    },
  }))

  // -------------------------------------------------------------------------
  // Settings-page HTTP surface (only when this deployment has a Web server)
  // -------------------------------------------------------------------------

  /** Probe the effective endpoint with the effective key. */
  async function verifyCurrentConnection() {
    const current = resolveConfig(config)
    const prefs = store.read()
    const enabled = enabledModelIds(current.tools, prefs)
    const model = enabled[0] ?? allModelIds(current.tools)[0] ?? ''
    if (!model) {
      return { ok: false, latencyMs: 0, model: '', status: 0, error: '没有配置任何模型，无法测试连接' }
    }
    return verifyConnection({
      baseURL: endpointView(prefs).effective,
      apiKey: await resolveApiKey(),
      model: toWireModel(model, current.wireModels),
      logger,
    })
  }

  // The routes live inside Connection's authenticated Fetch registry, not on a
  // bare Web route: the physical `/api` carrier admits a request (Host/Origin
  // fence + browser-session auth) before it ever reaches these handlers.
  ctx.inject(['connection'], (connCtx) => {
    const handlers = createApiHandlers({
      store,
      snapshot,
      verify: verifyCurrentConnection,
      acpxCheck: acpxStatus,
      onPrefsChanged: () => announceModels(),
      logger,
    })
    for (const route of handlers.routes) {
      connCtx.effect(
        () => connCtx.connection.fetch.register({
          path: route.path,
          methods: [...route.methods],
          requestBody: route.requestBody,
          fetch: route.fetch,
        }),
        `dsh-acpx-bridge: ${route.path} Fetch route`,
      )
    }
  })
}

export default { name, inject, apply }
