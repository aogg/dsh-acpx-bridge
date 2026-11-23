/**
 * Command-tool (acpx agent) authorization table + pure probe helpers.
 *
 * One row per platform CLI this deployment actually has installed:
 *   kimi · trae · opencode · qwen · codebuddy · deepseek-harness · antigravity
 *
 * Everything here is a PURE description of "how do I ask this CLI whether it is
 * authorized, and how do I log it in/out". The HTTP surface (agent-api.js) and
 * the subprocess lifecycle (agent-jobs.js) build on it, and the self-test drives
 * it with an injected `run`, so nothing in this file spawns a process by itself.
 *
 * Read-only by contract: probing must never write a credential file and must
 * never run `acpx <agent> exec` (that costs money and is a separate, explicit
 * action). `kimi login` is the one exception the platform forces on us — it is
 * the only way to ask Kimi for its auth state, and when Kimi is already
 * authorized it just prints one line and exits.
 *
 * State vocabulary returned to the page:
 *   authorized    proof of a usable credential
 *   unauthorized  the CLI says it is not logged in / has no credential
 *   no-auth       this agent needs no authorization at all (local ACP server)
 *   unavailable   the CLI exists but cannot run on this machine
 *   unknown       cannot be determined without an interactive terminal
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { resolveAcpxPath } from './api.js'

const execFileAsync = promisify(execFile)

/** Default cap for one probe subprocess. */
export const PROBE_TIMEOUT_MS = 8_000
/** Default stdout/stderr cap for a probe subprocess. */
export const PROBE_MAX_BUFFER = 256 * 1024
/** Longest `detail` string handed to the page (one line of CLI output). */
export const MAX_DETAIL_CHARS = 400
/** Longest version string kept for the page. */
const MAX_VERSION_CHARS = 64
/** Timeout of a `models` listing probe (kimi provider list --json). */
const MODELS_TIMEOUT_MS = 12_000

/** The seven platforms this deployment has CLI binaries for, in page order. */
export const AGENTS = Object.freeze([
  {
    id: 'kimi',
    name: 'Kimi',
    bin: 'kimi',
    versionArgs: ['kimi', '--version'],
    probe: {
      kind: 'command',
      argv: ['kimi', 'login'],
      timeoutMs: PROBE_TIMEOUT_MS,
      // Order matters: unauthorized is tested before authorized, so "Not
      // logged in" can never be read as "Logged in".
      unauthorizedRe: /not logged in|please (log|sign) ?in|unauthori[sz]ed/i,
      authorizedRe: /logged in/i,
      // A device code / verification link means "waiting for the human".
      pendingRe: /https?:\/\/[^\s]+|[A-Z0-9]{4}-[A-Z0-9]{4}/,
    },
    auth: {
      kind: 'device-code',
      loginArgv: ['kimi', 'login'],
      // `kimi login --region mainland-cn|global` is optional.
      regionValues: ['mainland-cn', 'global'],
      urlRe: /https?:\/\/[^\s]+/g,
      pasteCallback: false,
      logoutArgv: null,
      hint: '在页面里开一个登录 job：Kimi 会打印设备码/链接，浏览器确认后本行状态自动刷新。',
    },
    keyStore: null,
    models: { argv: ['kimi', 'provider', 'list', '--json'], parse: 'json-models' },
    docs: 'docs/平台授权.md',
  },
  {
    id: 'trae',
    name: 'Trae',
    bin: 'traecli',
    versionArgs: ['traecli', '--version'],
    probe: {
      kind: 'command',
      argv: ['traecli', 'login', 'status'],
      timeoutMs: PROBE_TIMEOUT_MS,
      unauthorizedRe: /not logged in|no credentials|未登录/i,
      authorizedRe: /logged in|authenticated|已登录/i,
    },
    auth: {
      kind: 'device-code',
      loginArgv: ['traecli', 'login'],
      urlRe: /https?:\/\/[^\s]+/g,
      // traecli starts a local callback listener and then wants the callback URL
      // pasted back on stdin.
      pasteCallback: true,
      logoutArgv: ['traecli', 'logout'],
      hint: '点「开始授权」→ 浏览器打开 SSO 链接 → 把回调 URL 粘回面板里的输入框提交。',
    },
    keyStore: null,
    models: null,
    docs: 'docs/平台授权.md',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    versionArgs: ['opencode', '--version'],
    probe: {
      kind: 'command',
      argv: ['opencode', 'auth', 'list'],
      timeoutMs: PROBE_TIMEOUT_MS,
      unauthorizedRe: /\b0 credentials?\b/i,
      authorizedRe: /\b[1-9]\d* credentials?\b/i,
    },
    auth: {
      kind: 'api-key',
      // `opencode auth login` is an interactive TUI: never spawned from the
      // page. The page writes ~/.local/share/opencode/auth.json instead and then
      // re-reads `opencode auth list` to verify.
      loginArgv: null,
      urlRe: null,
      pasteCallback: false,
      logoutArgv: ['opencode', 'auth', 'logout'],
      hint: '密钥写入 ~/.local/share/opencode/auth.json（provider → { type:"api", key }），写前备份、写后回读校验，校验失败自动回滚。',
    },
    keyStore: { kind: 'opencode-auth' },
    models: null,
    docs: 'docs/平台授权.md',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    bin: 'qwen',
    versionArgs: ['qwen', '--version'],
    probe: {
      // `qwen auth` no longer exists; authorization lives in the acpx argv.
      kind: 'config',
      file: '~/.acpx/config.json',
      agentKey: 'qwen',
      requireArgvFlag: '--openai-api-key',
      timeoutMs: 4_000,
    },
    auth: {
      kind: 'api-key',
      loginArgv: null,
      urlRe: null,
      pasteCallback: false,
      logoutArgv: null,
      hint: 'acpx 启动 qwen 时用的 argv 写在 ~/.acpx/config.json；本页只改 agents.qwen.argv，其它 agent 与未知字段整体保留。',
    },
    keyStore: { kind: 'acpx-config' },
    models: null,
    docs: 'docs/平台授权.md',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    bin: 'codebuddy',
    versionArgs: ['codebuddy', '--version'],
    probe: {
      // No login subcommand and no discoverable credential file: the only login
      // path is the interactive first-run TUI, which a page cannot drive.
      kind: 'static',
      state: 'unknown',
      detail: '无法自动探测：codebuddy 没有 login 子命令，首次运行是交互式 TUI 登录，本机 ~/.codebuddy 里也没有可判定的凭据文件。请在终端执行 `codebuddy` 完成首启登录。',
    },
    auth: {
      kind: 'interactive',
      loginArgv: ['codebuddy'],
      urlRe: null,
      pasteCallback: false,
      logoutArgv: null,
      hint: '在终端执行 codebuddy，按提示完成首次登录。',
    },
    keyStore: null,
    models: null,
    docs: 'docs/平台授权.md',
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    bin: 'dsh',
    versionArgs: ['dsh', '--version'],
    probe: {
      kind: 'static',
      state: 'no-auth',
      detail: '本地 dsh --profile acp，免授权。测试会真实跑一次 `acpx deepseek-harness exec "ping"`（较慢，可能产生费用）。',
    },
    auth: {
      kind: 'none',
      loginArgv: null,
      urlRe: null,
      pasteCallback: false,
      logoutArgv: null,
      hint: '免授权，无需操作。',
    },
    keyStore: null,
    models: null,
    docs: 'docs/平台授权.md',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    bin: '/usr/local/bin/agy_acp_server.par',
    versionArgs: null,
    probe: {
      kind: 'static',
      state: 'unavailable',
      detail: 'FATAL ERROR: This binary was compiled with avx enabled, but this feature is not available on this processor (go/sigill-fail-fast).',
    },
    auth: {
      kind: 'none',
      loginArgv: null,
      urlRe: null,
      pasteCallback: false,
      logoutArgv: null,
      hint: '该可执行文件在本机 CPU 上无法运行（缺少 avx），任何授权动作都没有意义。',
    },
    keyStore: null,
    models: null,
    testable: false,
    docs: 'docs/平台授权.md',
  },
])

/** Agent ids in page order (frozen copy for callers that only need ids). */
export const AGENT_IDS = Object.freeze(AGENTS.map(agent => agent.id))

/**
 * Look one agent up by id.
 * @param id - agent id (`kimi`, `trae`, …).
 * @returns the spec, or undefined.
 */
export function getAgent(id) {
  const wanted = typeof id === 'string' ? id.trim() : ''
  if (!wanted) return undefined
  return AGENTS.find(agent => agent.id === wanted)
}

/** Remove ANSI escape sequences (colors, OSC titles) and normalise CRLF. */
export function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n')
}

/**
 * Every http(s) URL mentioned in a chunk of CLI output, de-duplicated in order.
 * Trailing punctuation is trimmed (CLIs love to end a URL with `)` or `.`).
 * @param text - raw CLI output.
 * @returns unique URLs, at most 20.
 */
export function extractAuthLinks(text) {
  const found = String(text ?? '').match(/https?:\/\/[^\s"'`<>()[\]{}]+/g)
  if (found === null) return []
  const seen = new Set()
  const links = []
  for (const raw of found) {
    const link = raw.replace(/[.,;:)！。，；）]+$/, '')
    if (!link || seen.has(link)) continue
    seen.add(link)
    links.push(link)
    if (links.length >= 20) break
  }
  return links
}

/** `****abcd` style mask: never reveals more than the last four characters. */
export function maskKey(key) {
  const value = typeof key === 'string' ? key : ''
  if (!value) return ''
  if (value.length <= 4) return '****'
  return `****${value.slice(-4)}`
}

/**
 * Replace every occurrence of a known secret in text with its mask, so no
 * response, log line or SSE frame can ever carry a complete key.
 * @param text - text that may contain the secret.
 * @param key - the secret to scrub (ignored when shorter than 4 chars).
 * @returns scrubbed text.
 */
export function redactKey(text, key) {
  const value = String(text ?? '')
  const secret = typeof key === 'string' ? key : ''
  if (secret.length < 4) return value
  return value.split(secret).join(maskKey(secret))
}

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(file) {
  const path = String(file ?? '')
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return `${homedir()}/${path.slice(2)}`
  return path
}

/** Trim + collapse one line for the page, capped at {@link MAX_DETAIL_CHARS}. */
export function summarizeLine(text, max = MAX_DETAIL_CHARS) {
  const line = stripAnsi(text)
    .split('\n')
    .map(entry => entry.trim())
    .filter(Boolean)
    .join(' · ')
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * First `x.y.z`-shaped version in a CLI's `--version` output.
 * @param stdout - command output.
 * @returns the version, or '' when nothing matched.
 */
export function parseVersion(stdout) {
  const text = stripAnsi(stdout).trim()
  if (!text) return ''
  const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  if (match) return match[0].slice(0, MAX_VERSION_CHARS)
  const first = text.split('\n')[0].trim()
  return first.slice(0, MAX_VERSION_CHARS)
}

/** Count of models from a `models` probe answer. */
export function parseModelCount(text, parse) {
  const body = stripAnsi(text)
  if (!body.trim()) return null
  if (parse === 'json-models' || parse === 'json-array') {
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      // Expected branch: the CLI printed human text instead of JSON (a warning
      // banner in front of the payload), so no model count is claimed.
      return null
    }
    const node = parse === 'json-models' ? payload?.models : payload
    if (Array.isArray(node)) return node.length
    if (node && typeof node === 'object') return Object.keys(node).length
    return null
  }
  if (parse === 'lines') return body.split('\n').filter(line => line.trim()).length
  return null
}

/** Result shape of one probe step. */
function probeResult(spec) {
  return {
    id: spec.id,
    name: spec.name,
    bin: spec.bin,
    installed: false,
    version: '',
    state: 'unknown',
    method: spec.auth?.kind ?? 'unknown',
    detail: '',
    actions: [],
    models: null,
    docs: spec.docs ?? '',
    error: '',
  }
}

/**
 * Classify a finished probe command's output.
 *
 * Precedence is unauthorized → authorized → pending → timeout → unknown: the
 * CLI's negative answer must win, because "Not logged in" contains "logged in".
 * @param spec - agent spec.
 * @param text - merged stdout+stderr.
 * @param timedOut - whether the probe had to be killed.
 * @returns `{ state, detail }`.
 */
export function classifyProbeOutput(spec, text, timedOut = false) {
  const probe = spec.probe ?? {}
  const clean = stripAnsi(text)
  const firstMatch = regex => {
    if (!regex) return ''
    const line = clean.split('\n').find(entry => regex.test(entry))
    return line ? summarizeLine(line) : ''
  }
  if (probe.unauthorizedRe && probe.unauthorizedRe.test(clean)) {
    return { state: 'unauthorized', detail: firstMatch(probe.unauthorizedRe) }
  }
  if (probe.authorizedRe && probe.authorizedRe.test(clean)) {
    return { state: 'authorized', detail: firstMatch(probe.authorizedRe) }
  }
  if (probe.pendingRe && probe.pendingRe.test(clean)) {
    return { state: 'unauthorized', detail: firstMatch(probe.pendingRe) }
  }
  if (timedOut) {
    return { state: 'unknown', detail: summarizeLine(clean) || '探测超时，CLI 没有给出可判定的答复' }
  }
  return { state: 'unknown', detail: summarizeLine(clean) || 'CLI 没有给出可判定的答复' }
}

/**
 * Actions the page may offer for one probed agent.
 * @param spec - agent spec.
 * @param probe - a probe result (`state`, `installed`).
 * @returns array of action ids: login | set-key | remove-key | logout | copy-login | test | paste-callback.
 */
export function actionsFor(spec, probe) {
  if (!probe || probe.installed !== true) return []
  if (probe.state === 'unavailable') return []
  const actions = []
  const kind = spec.auth?.kind ?? 'unknown'
  if (kind === 'device-code' && spec.auth?.loginArgv) actions.push('login')
  if (kind === 'api-key' && spec.keyStore) actions.push('set-key', 'remove-key')
  if (kind === 'interactive' && spec.auth?.loginArgv) actions.push('copy-login')
  if (spec.auth?.logoutArgv) actions.push('logout')
  if (spec.auth?.pasteCallback === true) actions.push('paste-callback')
  if (spec.testable !== false && probe.state !== 'unavailable') actions.push('test')
  return actions
}

/**
 * Default subprocess runner: `execFile` with a timeout and buffer cap, never
 * inheriting stdin, and never throwing (a failed probe is an answer, not a
 * crash).
 * @param argv - full command line, argv[0] is the file.
 * @param options.timeoutMs - kill after this long.
 * @param options.maxBuffer - stdout/stderr cap.
 * @returns `{ code, signal, stdout, stderr, timedOut, notFound, error }`.
 */
export async function defaultRun(argv, { timeoutMs = PROBE_TIMEOUT_MS, maxBuffer = PROBE_MAX_BUFFER } = {}) {
  const [file, ...args] = argv
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer,
      encoding: 'utf8',
      windowsHide: true,
      // No `stdio`/`input`: execFile leaves stdin as an ignored pipe, so a CLI
      // that wants to wait for a pasted URL gets EOF instead of hanging on a TTY.
    })
    return { code: 0, signal: null, stdout, stderr, timedOut: false, notFound: false, error: '' }
  } catch (error) {
    const notFound = error?.code === 'ENOENT'
    const timedOut = error?.killed === true || error?.code === 'ETIMEDOUT'
    return {
      code: typeof error?.code === 'number' ? error.code : null,
      signal: typeof error?.signal === 'string' ? error.signal : null,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
      timedOut,
      notFound,
      error: notFound ? `ENOENT: ${file}` : String(error?.message ?? error),
    }
  }
}

async function defaultReadText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Human sentence for an argv, with the secret scrubbed. */
function describeQwen(argv, maskedKey) {
  const flag = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : ''
  }
  const parts = []
  if (maskedKey) parts.push(`key ${maskedKey}`)
  const baseURL = flag('--openai-base-url')
  if (baseURL) parts.push(`baseURL ${baseURL}`)
  const model = flag('--model')
  if (model) parts.push(`model ${model}`)
  return parts.join(' · ')
}

/**
 * Probe one agent. Never throws: a missing binary, a timeout and an
 * unparsable answer are all reported inside the result.
 * @param spec - agent spec from {@link AGENTS}.
 * @param options.run - injectable runner (tests).
 * @param options.readText - injectable file reader (tests).
 * @param options.logger - receives contained failures.
 * @returns the probe result handed to the page.
 */
export async function probeAgent(spec, { run = defaultRun, readText = defaultReadText, logger = null } = {}) {
  const result = probeResult(spec)
  if (!spec || typeof spec !== 'object') return result

  // 1. Installed? (`versionArgs` null means "trust the path check only".)
  let installed = false
  if (spec.versionArgs) {
    const versionRun = await run(spec.versionArgs, { timeoutMs: PROBE_TIMEOUT_MS })
    installed = !versionRun.notFound
    result.version = versionRun.notFound ? '' : parseVersion(versionRun.stdout || versionRun.stderr)
  } else {
    installed = resolveAcpxPath(spec.bin) !== ''
  }
  if (!installed) {
    result.installed = false
    result.state = 'unavailable'
    result.detail = `未找到可执行文件 ${spec.bin}（未安装或不在 PATH 中）`
    result.actions = []
    return result
  }
  result.installed = true

  const probe = spec.probe ?? {}

  // 2a. Static verdict (an agent whose login cannot be inspected from outside).
  if (probe.kind === 'static') {
    result.state = probe.state ?? 'unknown'
    result.detail = String(probe.detail ?? '')
    result.actions = actionsFor(spec, result)
    return result
  }

  // 2b. File-backed verdict (qwen: authorization is the acpx argv, not a CLI flag).
  if (probe.kind === 'config') {
    const file = expandHome(probe.file)
    let text = null
    try {
      text = await readText(file)
    } catch (error) {
      logger?.warn?.(`[acpx-bridge] agent probe: unable to read ${file}: ${error?.message ?? error}`)
      result.state = 'unknown'
      result.detail = `读取 ${probe.file} 失败：${error?.message ?? error}`
      result.error = String(error?.message ?? error)
      result.actions = actionsFor(spec, result)
      return result
    }
    if (text === null) {
      result.state = 'unauthorized'
      result.detail = `${probe.file} 不存在：该 agent 还没有任何授权配置`
      result.actions = actionsFor(spec, result)
      return result
    }
    let doc = null
    try {
      doc = JSON.parse(text)
    } catch (error) {
      // Expected branch: a hand-broken config file. Reported, not thrown.
      logger?.warn?.(`[acpx-bridge] agent probe: ${file} is not JSON: ${error?.message ?? error}`)
      result.state = 'unauthorized'
      result.detail = `${probe.file} 不是合法 JSON：${error?.message ?? error}`
      result.actions = actionsFor(spec, result)
      return result
    }
    const argv = doc?.agents?.[probe.agentKey]?.argv
    const list = Array.isArray(argv) ? argv.map(entry => String(entry)) : []
    const keyIndex = list.indexOf(probe.requireArgvFlag)
    const key = keyIndex >= 0 ? list[keyIndex + 1] ?? '' : ''
    if (key) {
      result.state = 'authorized'
      result.detail = `${describeQwen(list, maskKey(key))}（${probe.file}）`
    } else {
      result.state = 'unauthorized'
      result.detail = `${probe.file} 里 agents.${probe.agentKey}.argv 没有 ${probe.requireArgvFlag}`
    }
    result.actions = actionsFor(spec, result)
    return result
  }

  // 2c. Command verdict.
  if (probe.kind === 'command' && Array.isArray(probe.argv)) {
    const startedAt = Date.now()
    const answer = await run(probe.argv, { timeoutMs: probe.timeoutMs ?? PROBE_TIMEOUT_MS })
    const merged = `${answer.stdout ?? ''}\n${answer.stderr ?? ''}`
    const verdict = classifyProbeOutput(spec, merged, answer.timedOut === true)
    result.state = verdict.state
    result.detail = verdict.detail
    if (answer.timedOut === true && !verdict.detail) {
      result.detail = `探测超时（${probe.timeoutMs ?? PROBE_TIMEOUT_MS}ms，${Date.now() - startedAt}ms 后放弃）`
    }
    if (answer.error && verdict.state === 'unknown') result.error = answer.error
    result.actions = actionsFor(spec, result)

    // Model count is a display nicety; only worth asking when authorized.
    if (spec.models && result.state === 'authorized') {
      const modelsRun = await run(spec.models.argv, { timeoutMs: MODELS_TIMEOUT_MS })
      if (!modelsRun.notFound) {
        result.models = parseModelCount(`${modelsRun.stdout ?? ''}${modelsRun.stderr ?? ''}`, spec.models.parse)
      }
    }
    return result
  }

  result.state = 'unknown'
  result.detail = '该 agent 没有可用的探测方式'
  result.actions = actionsFor(spec, result)
  return result
}

// ---------------------------------------------------------------------------
// argv helpers (pure; used by the key routes)
// ---------------------------------------------------------------------------

/** The three qwen/acpx argv flags this page owns. */
export const QWEN_SECRET_FLAGS = Object.freeze(['--openai-api-key', '--openai-base-url', '--model'])

/**
 * Build the acpx argv for qwen from a form value. Only the flags this page owns
 * are produced; everything else in the file stays untouched.
 * @param options.apiKey - required, non-empty.
 * @param options.baseURL - optional http(s) base URL.
 * @param options.model - optional model id.
 * @returns the argv array.
 */
export function buildQwenArgv({ apiKey, baseURL = '', model = '' } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) throw new TypeError('buildQwenArgv: apiKey is required')
  const argv = ['qwen', '--acp', '--auth-type', 'openai', '--openai-api-key', key]
  const base = typeof baseURL === 'string' ? baseURL.trim() : ''
  if (base) argv.push('--openai-base-url', base)
  const chosen = typeof model === 'string' ? model.trim() : ''
  if (chosen) argv.push('--model', chosen)
  return argv
}

/**
 * Remove this page's flags (and their values) from an existing qwen argv,
 * keeping every other argument in order.
 * @param argv - current argv.
 * @returns a new argv.
 */
export function stripQwenSecretArgs(argv) {
  const list = Array.isArray(argv) ? argv.map(entry => String(entry)) : []
  const kept = []
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    if (QWEN_SECRET_FLAGS.includes(entry)) {
      // Skip the flag and the value that follows it (a bare flag is also valid).
      if (index + 1 < list.length && !list[index + 1].startsWith('--')) index += 1
      continue
    }
    // `--flag=value` spelling.
    const inline = QWEN_SECRET_FLAGS.find(flag => entry.startsWith(`${flag}=`))
    if (inline) continue
    kept.push(entry)
  }
  return kept
}
