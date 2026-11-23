/**
 * Credential plumbing for the two API-key agents, plus logout and the
 * cost-bearing `acpx … exec ping` test.
 *
 * Where a key can live on this machine:
 *   opencode → `~/.local/share/opencode/auth.json`
 *              `{ "<provider>": { "type": "api", "key": "…" } }` (confirmed by
 *              reading the opencode dist: the login writer stores exactly that
 *              shape, and an OAuth entry is `{ type: "oauth", access, refresh,
 *              expires }`). Written by this module, then verified by re-reading
 *              `opencode auth list`; a failed verification restores the backup.
 *   qwen     → `~/.acpx/config.json` → `agents.qwen.argv`
 *              `["qwen","--acp","--auth-type","openai","--openai-api-key","…",
 *                "--openai-base-url","…","--model","…"]`
 *              Only those three flags are touched; every other agent and every
 *              unknown field in the document is preserved verbatim.
 *
 * Both writers: `.bak-<timestamp>` in the same directory first, atomic
 * `<file>.tmp-<uuid>` + rename, mode 0o600 (the file holds a plaintext secret),
 * and a read-back check that rolls the old bytes back on failure.
 *
 * No key ever leaves this module: responses carry `maskedKey` only, and every
 * string echoed to the page passes through `redactKey`.
 */

import { randomUUID } from 'node:crypto'
import { readFile as fsReadFile, writeFile as fsWriteFile, rename as fsRename, copyFile as fsCopyFile, unlink as fsUnlink, mkdir as fsMkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  QWEN_SECRET_FLAGS,
  buildQwenArgv,
  defaultRun,
  maskKey,
  redactKey,
  stripQwenSecretArgs,
  stripAnsi,
  summarizeLine,
} from './agents.js'

/** Cooldown between two accepted `acpx … exec ping` tests for one agent. */
export const TEST_COOLDOWN_MS = 60_000
/** Timeout of one real test call (slow: a full ACP session start). */
export const TEST_TIMEOUT_MS = 120_000
/** stdout/stderr cap returned by a test. */
export const TEST_OUTPUT_CHARS = 4_096
/** Largest accepted secret. */
const MAX_SECRET_CHARS = 8_192
/** opencode provider id shape. */
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Default filesystem seam (overridden in tests with a temp dir). */
export const defaultIo = Object.freeze({
  readFile: fsReadFile,
  writeFile: fsWriteFile,
  rename: fsRename,
  copyFile: fsCopyFile,
  unlink: fsUnlink,
  mkdir: fsMkdir,
})

/** `~/.local/share/opencode/auth.json` (respects XDG_DATA_HOME). */
export function opencodeAuthFile({ xdgDataHome = process.env.XDG_DATA_HOME, home = homedir() } = {}) {
  const base = xdgDataHome ? join(xdgDataHome, 'opencode') : join(home, '.local', 'share', 'opencode')
  return join(base, 'auth.json')
}

/** `~/.acpx/config.json`. */
export function acpxConfigFile({ home = homedir() } = {}) {
  return join(home, '.acpx', 'config.json')
}

/** Validate + normalise an opencode provider id. */
export function normalizeProvider(provider) {
  const id = typeof provider === 'string' ? provider.trim() : ''
  return PROVIDER_RE.test(id) ? id : ''
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read + parse a JSON object file. A missing file is `{}`, not an error. */
async function readJsonDoc(file, io, logger) {
  let text
  try {
    text = await io.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, exists: false, doc: {}, text: '' }
    logger?.warn?.(`[acpx-bridge] unable to read ${file}: ${error?.message ?? error}`)
    return { ok: false, error: `读取 ${file} 失败：${error?.message ?? error}` }
  }
  const body = String(text ?? '')
  if (!body.trim()) return { ok: true, exists: true, doc: {}, text: body }
  let doc
  try {
    doc = JSON.parse(body)
  } catch (error) {
    logger?.warn?.(`[acpx-bridge] ${file} is not JSON: ${error?.message ?? error}`)
    return { ok: false, error: `${file} 不是合法 JSON：${error?.message ?? error}` }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: `${file} 的内容不是 JSON 对象` }
  }
  return { ok: true, exists: true, doc, text: body }
}

/** Timestamp suffix for backups: `yyyyMMdd-HHmmss`. */
function backupStamp(now) {
  const date = new Date(now())
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Copy a file to `<file>.bak-<stamp>` in the same directory.
 * @returns the backup path, or '' when the original did not exist.
 */
async function backupFile(file, io, now, logger) {
  const target = `${file}.bak-${backupStamp(now)}`
  try {
    await io.copyFile(file, target)
    return target
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    logger?.warn?.(`[acpx-bridge] unable to back up ${file}: ${error?.message ?? error}`)
    return ''
  }
}

/** Atomic JSON write: temp file in the same directory, then rename. */
async function writeJsonAtomic(file, doc, io, { mode = 0o600, logger = null } = {}) {
  await io.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    await io.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode })
    await io.rename(tmp, file)
    return true
  } catch (error) {
    logger?.warn?.(`[acpx-bridge] atomic write of ${file} failed: ${error?.message ?? error}`)
    try {
      await io.unlink(tmp)
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        logger?.warn?.(`[acpx-bridge] unable to remove temp file ${tmp}: ${cleanupError?.message ?? cleanupError}`)
      }
    }
    return false
  }
}

/** Put the previous bytes back after a failed verification. */
async function restoreFile(file, backup, existedBefore, io, logger) {
  try {
    if (backup) {
      await io.copyFile(backup, file)
      return true
    }
    if (!existedBefore) {
      await io.unlink(file)
      return true
    }
    return false
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    logger?.warn?.(`[acpx-bridge] rollback of ${file} failed: ${error?.message ?? error}`)
    return false
  }
}

/** A `{ ok:false, status, code, error }` answer. */
function failure(status, code, error) {
  return { ok: false, status, code, error }
}

/**
 * Write one opencode API key into `auth.json` and prove opencode accepts it.
 *
 * @param options.provider - opencode provider id (`openai`, `anthropic`, …).
 * @param options.key - the secret (trimmed; never logged or returned).
 * @param options.io - filesystem seam.
 * @param options.run - command runner seam (`opencode auth list`).
 * @param options.now - clock seam.
 * @returns `{ ok, provider, file, maskedKey, backup }` or a failure object.
 */
export async function writeOpencodeKey({
  provider,
  key,
  io = defaultIo,
  run = defaultRun,
  now = () => Date.now(),
  logger = null,
  file = opencodeAuthFile(),
} = {}) {
  const providerId = normalizeProvider(provider)
  if (!providerId) return failure(400, 'invalid-provider', 'provider 必须是 a-z0-9._- 组成的 id（例如 openai）')
  const secret = typeof key === 'string' ? key.trim() : ''
  if (!secret) return failure(400, 'invalid-key', '密钥不能为空')
  if (secret.length > MAX_SECRET_CHARS) return failure(413, 'key-too-long', `密钥超过 ${MAX_SECRET_CHARS} 字符`)

  const read = await readJsonDoc(file, io, logger)
  if (!read.ok) return failure(500, 'key-read-failed', read.error)
  const backup = read.exists ? await backupFile(file, io, now, logger) : ''

  const existing = read.doc[providerId]
  const entry = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}
  entry.type = 'api'
  entry.key = secret
  const next = { ...read.doc, [providerId]: entry }

  const written = await writeJsonAtomic(file, next, io, { logger })
  if (!written) {
    await restoreFile(file, backup, read.exists, io, logger)
    return failure(500, 'key-write-failed', `写入 ${file} 失败（原文件已备份${backup ? `：${backup}` : ''}）`)
  }

  // Verification: the file is only trusted once opencode itself lists it.
  const verify = await run(['opencode', 'auth', 'list'], { timeoutMs: 15_000 })
  const output = stripAnsi(`${verify.stdout ?? ''}\n${verify.stderr ?? ''}`)
  const countOk = /\b[1-9]\d* credentials?\b/i.test(output)
  const listed = new RegExp(`(^|\\n)[^\\n]*\\b${escapeRegExp(providerId)}\\b`, 'i').test(output)
  if (verify.notFound === true || verify.code !== 0 || !countOk) {
    const restored = await restoreFile(file, backup, read.exists, io, logger)
    const reason = verify.notFound
      ? 'opencode 不在 PATH 中'
      : verify.code !== 0
        ? `opencode auth list 退出码 ${verify.code}`
        : 'opencode auth list 仍显示 0 credentials'
    return {
      ok: false,
      status: 502,
      code: 'key-verify-failed',
      error: `写入后回读校验失败（${reason}）${restored ? '，已回滚原文件' : '，回滚失败请手工检查'}${output.trim() ? `：${summarizeLine(output)}` : ''}`,
      rolledBack: restored,
    }
  }
  logger?.info?.(
    `[acpx-bridge][命令工具授权][密钥] opencode 密钥已写入 (provider=${providerId} 提供方, file=${file} 文件, maskedKey=${maskKey(secret)} 掩码)`,
  )
  return {
    ok: true,
    provider: providerId,
    file,
    maskedKey: maskKey(secret),
    backup,
    listed,
    detail: summarizeLine(output),
  }
}

/**
 * Write the qwen API key (and optional base URL/model) into the acpx argv.
 * @returns `{ ok, file, baseURL, model, maskedKey, backup }` or a failure.
 */
export async function writeQwenKey({
  apiKey,
  baseURL = '',
  model = '',
  io = defaultIo,
  now = () => Date.now(),
  logger = null,
  file = acpxConfigFile(),
} = {}) {
  const secret = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!secret) return failure(400, 'invalid-key', 'API Key 不能为空')
  if (secret.length > MAX_SECRET_CHARS) return failure(413, 'key-too-long', `密钥超过 ${MAX_SECRET_CHARS} 字符`)
  const base = typeof baseURL === 'string' ? baseURL.trim() : ''
  if (base) {
    let parsed
    try {
      parsed = new URL(base)
    } catch (error) {
      // Expected branch: the operator typed a non-URL base endpoint.
      logger?.debug?.(`[acpx-bridge] qwen baseURL rejected: ${error?.message ?? error}`)
      return failure(400, 'invalid-base-url', 'baseURL 必须是 http(s) 地址')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return failure(400, 'invalid-base-url', 'baseURL 必须是 http(s) 地址')
    }
  }
  const chosen = typeof model === 'string' ? model.trim() : ''

  let argv
  try {
    argv = buildQwenArgv({ apiKey: secret, baseURL: base, model: chosen })
  } catch (error) {
    return failure(400, 'invalid-key', String(error?.message ?? error))
  }

  const read = await readJsonDoc(file, io, logger)
  if (!read.ok) return failure(500, 'config-read-failed', read.error)
  const backup = read.exists ? await backupFile(file, io, now, logger) : ''

  const agents = read.doc.agents && typeof read.doc.agents === 'object' && !Array.isArray(read.doc.agents)
    ? read.doc.agents
    : {}
  const qwen = agents.qwen && typeof agents.qwen === 'object' && !Array.isArray(agents.qwen) ? { ...agents.qwen } : {}
  qwen.argv = argv
  const next = { ...read.doc, agents: { ...agents, qwen } }

  const written = await writeJsonAtomic(file, next, io, { logger })
  if (!written) {
    await restoreFile(file, backup, read.exists, io, logger)
    return failure(500, 'config-write-failed', `写入 ${file} 失败（原文件已备份${backup ? `：${backup}` : ''}）`)
  }

  // Read back: the key must be exactly where acpx will look for it.
  const verify = await readJsonDoc(file, io, logger)
  const verifyArgv = verify.ok ? verify.doc?.agents?.qwen?.argv : null
  const verified = verify.ok && Array.isArray(verifyArgv)
    && verifyArgv.includes('--openai-api-key')
    && verifyArgv[verifyArgv.indexOf('--openai-api-key') + 1] === secret
  if (!verified) {
    const restored = await restoreFile(file, backup, read.exists, io, logger)
    return {
      ok: false,
      status: 502,
      code: 'config-verify-failed',
      error: `写入后回读校验失败${restored ? '，已回滚原文件' : '，回滚失败请手工检查'}`,
      rolledBack: restored,
    }
  }
  logger?.info?.(
    `[acpx-bridge][命令工具授权][密钥] qwen argv 已写入 (file=${file} 文件, model=${chosen || '-'} 模型, maskedKey=${maskKey(secret)} 掩码)`,
  )
  return {
    ok: true,
    configured: true,
    file,
    baseURL: base,
    model: chosen,
    maskedKey: maskKey(secret),
    backup: redactKey(backup, secret),
  }
}

/**
 * Remove this page's qwen flags from the acpx argv, keeping everything else.
 * @returns `{ ok, removed, argv }` or a failure.
 */
export async function removeQwenKey({ io = defaultIo, now = () => Date.now(), logger = null, file = acpxConfigFile() } = {}) {
  const read = await readJsonDoc(file, io, logger)
  if (!read.ok) return failure(500, 'config-read-failed', read.error)
  if (!read.exists) return { ok: true, removed: false, argv: [] }
  const agents = read.doc.agents && typeof read.doc.agents === 'object' && !Array.isArray(read.doc.agents)
    ? read.doc.agents
    : {}
  const qwen = agents.qwen && typeof agents.qwen === 'object' && !Array.isArray(agents.qwen) ? agents.qwen : null
  const current = Array.isArray(qwen?.argv) ? qwen.argv.map(entry => String(entry)) : []
  const next = stripQwenSecretArgs(current)
  if (next.length === current.length) return { ok: true, removed: false, argv: next, file }
  const backup = await backupFile(file, io, now, logger)
  const nextQwen = { ...qwen, argv: next }
  const nextDoc = { ...read.doc, agents: { ...agents, qwen: nextQwen } }
  const written = await writeJsonAtomic(file, nextDoc, io, { logger })
  if (!written) {
    await restoreFile(file, backup, read.exists, io, logger)
    return failure(500, 'config-write-failed', `写入 ${file} 失败（原文件已备份${backup ? `：${backup}` : ''}）`)
  }
  return { ok: true, removed: true, argv: next, file, backup }
}

/**
 * Read the secrets this deployment knows for one agent, for output redaction.
 * @returns array of secret strings (may be empty).
 */
export async function readAgentSecrets(spec, { io = defaultIo, logger = null } = {}) {
  const secrets = []
  try {
    if (spec?.keyStore?.kind === 'acpx-config') {
      const read = await readJsonDoc(acpxConfigFile(), io, logger)
      const argv = read.ok ? read.doc?.agents?.[spec.keyStore.agentKey ?? spec.id]?.argv : null
      if (Array.isArray(argv)) {
        for (const flag of QWEN_SECRET_FLAGS) {
          const index = argv.indexOf(flag)
          if (index >= 0 && index + 1 < argv.length && !String(argv[index + 1]).startsWith('--')) {
            secrets.push(String(argv[index + 1]))
          }
        }
      }
    } else if (spec?.keyStore?.kind === 'opencode-auth') {
      const read = await readJsonDoc(opencodeAuthFile(), io, logger)
      if (read.ok) {
        for (const entry of Object.values(read.doc)) {
          if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key) secrets.push(entry.key)
        }
      }
    }
  } catch (error) {
    logger?.warn?.(`[acpx-bridge] unable to read secrets for ${spec?.id}: ${error?.message ?? error}`)
  }
  return secrets
}

/** Apply every known secret's mask to one string. */
export function redactSecretsList(text, secrets) {
  let out = String(text ?? '')
  for (const secret of secrets ?? []) out = redactKey(out, secret)
  return out
}

/**
 * Log an agent out through its own CLI.
 * @param spec - agent spec (needs `auth.logoutArgv`).
 * @param options.provider - opencode provider id (required there).
 * @returns `{ ok, exitCode, detail }` or a failure.
 */
export async function logoutAgent(spec, {
  provider = '',
  run = defaultRun,
  logger = null,
  secrets = [],
} = {}) {
  const base = Array.isArray(spec?.auth?.logoutArgv) ? [...spec.auth.logoutArgv] : null
  if (base === null) return failure(400, 'logout-not-supported', '该平台没有 logout 子命令，本页无法退出')
  if (spec.id === 'opencode') {
    const providerId = normalizeProvider(provider)
    if (!providerId) return failure(400, 'invalid-provider', '退出 opencode 需要指定 provider')
    base.push(providerId)
  }
  const answer = await run(base, { timeoutMs: 20_000 })
  const text = redactSecretsList(stripAnsi(`${answer.stdout ?? ''}\n${answer.stderr ?? ''}`), secrets)
  if (answer.notFound === true) {
    return failure(502, 'logout-failed', `未找到可执行文件 ${base[0]}`)
  }
  if (answer.code !== 0) {
    return failure(502, 'logout-failed', `${base.join(' ')} 退出码 ${answer.code}${text.trim() ? `：${summarizeLine(text)}` : ''}`)
  }
  logger?.debug?.(`[acpx-bridge] logout ${spec.id} ok`)
  return { ok: true, exitCode: 0, detail: summarizeLine(text) }
}

/** Cap one test output for the page. */
function clipOutput(text) {
  const body = String(text ?? '')
  return body.length > TEST_OUTPUT_CHARS ? `${body.slice(0, TEST_OUTPUT_CHARS)}\n… [已截断]` : body
}

/**
 * One REAL `acpx <agent> exec "ping"` call. Costs money; the page must confirm
 * before it calls this.
 * @returns `{ ok, exitCode, durationMs, stdout, stderr, diagnostic }`.
 */
export async function testAgent(spec, {
  run = defaultRun,
  now = () => Date.now(),
  bin = process.env.ACPX_BIN || 'acpx',
  secrets = [],
  timeoutMs = TEST_TIMEOUT_MS,
} = {}) {
  const argv = [bin, spec.id, 'exec', 'ping', '--format', 'quiet']
  const startedAt = now()
  const answer = await run(argv, { timeoutMs, maxBuffer: 1024 * 1024 })
  const durationMs = Math.max(0, now() - startedAt)
  const stdout = clipOutput(redactSecretsList(stripAnsi(answer.stdout), secrets))
  const stderr = clipOutput(redactSecretsList(stripAnsi(answer.stderr), secrets))
  if (answer.notFound === true) {
    return { ok: false, exitCode: null, durationMs, stdout, stderr, diagnostic: 'acpx 未安装' }
  }
  if (answer.timedOut === true) {
    return {
      ok: false,
      exitCode: answer.code,
      durationMs,
      stdout,
      stderr,
      diagnostic: `超过 ${timeoutMs}ms 没有返回`,
    }
  }
  if (answer.code !== 0) {
    return {
      ok: false,
      exitCode: answer.code,
      durationMs,
      stdout,
      stderr,
      diagnostic: summarizeLine(stderr || stdout) || `exit ${answer.code}`,
    }
  }
  return { ok: true, exitCode: 0, durationMs, stdout, stderr, diagnostic: '' }
}
