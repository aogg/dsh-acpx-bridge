/**
 * Persistent user preferences for dsh-acpx-bridge.
 *
 * The plugin keeps its own JSON document at
 * `<DSH_HOME>/storages/acpx-bridge/prefs.json` instead of writing the profile's
 * `cordis.patch.yml`: that file is hand-maintained (comments must survive) and
 * must never hold a secret. Credentials do not live here at all — they go
 * through the harness credential seam (see src/index.js).
 *
 * Everything in this module is either a pure function (sanitize / merge /
 * filter, unit-tested by src/selftest.mjs) or the small atomic file store.
 */

import { homedir } from 'node:os'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { displayNameForModel } from './config.js'

/** On-disk document version. An unknown version resets to defaults. */
export const PREF_VERSION = 1

/** Bounds for the delegate timeout: 1 minute .. 1 hour. */
export const TIMEOUT_MIN_MS = 60_000
export const TIMEOUT_MAX_MS = 3_600_000
/** Default delegate timeout, matching the tool's historical constant. */
export const TIMEOUT_DEFAULT_MS = 600_000

export const MODES = ['exec', 'session']
export const APPROVES = ['reads', 'all', 'none']
export const FORMATS = ['quiet', 'json', 'text']

/** Caps that keep a corrupted or hostile document from growing without bound. */
const MAX_DISABLED_MODELS = 500
const MAX_DISPLAY_NAMES = 500
const MAX_AGENT_LENGTH = 200
const MAX_BASE_URL_LENGTH = 2048

/** Directory (0700) and file (0600) modes of the preference document. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** The document a fresh install starts from (also the [reset] target). */
export const DEFAULT_PREFS = Object.freeze({
  version: PREF_VERSION,
  disabledModels: Object.freeze([]),
  displayNames: Object.freeze({}),
  baseURLOverride: '',
  defaults: Object.freeze({
    agent: '',
    mode: 'exec',
    approve: 'reads',
    format: 'quiet',
    timeoutMs: TIMEOUT_DEFAULT_MS,
  }),
  updatedAt: '',
})

/** The harness home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** Absolute path of this plugin's preference document. */
export function prefsFile() {
  return join(dshHome(), 'storages', 'acpx-bridge', 'prefs.json')
}

/** Deep copy helper: every read hands out an isolated snapshot. */
export function clonePrefs(prefs) {
  return structuredClone(prefs)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Clamp a timeout into [TIMEOUT_MIN_MS, TIMEOUT_MAX_MS]; non-numbers use the default. */
export function clampTimeout(value, fallback = TIMEOUT_DEFAULT_MS) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return fallback
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(numeric)))
}

/** Keep only non-empty strings, de-duplicated, capped. */
export function sanitizeDisabledModels(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const result = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    if (result.length >= MAX_DISABLED_MODELS) break
  }
  return result
}

/**
 * Normalize the display-name overrides: non-string keys/values dropped, blank
 * values removed (a blank override would otherwise hide the real name), capped.
 */
export function sanitizeDisplayNames(value) {
  if (!isRecord(value)) return {}
  const result = {}
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawKey !== 'string' || rawKey.trim() === '') continue
    if (typeof rawValue !== 'string') continue
    const name = rawValue.trim()
    if (!name) continue
    result[rawKey.trim()] = name
    count += 1
    if (count >= MAX_DISPLAY_NAMES) break
  }
  return result
}

/**
 * Validate an endpoint override. Only an http(s) URL without embedded
 * credentials survives; anything else becomes the empty string (= no override).
 */
export function sanitizeBaseURL(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_BASE_URL_LENGTH) return ''
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  if (url.username || url.password) return ''
  return trimmed.replace(/\/+$/, '')
}

/**
 * Pick only the `defaults` keys actually present in `value`, each validated.
 * Missing keys are absent from the result so a partial patch never resets the
 * keys it did not mention.
 */
export function pickDefaults(value) {
  if (!isRecord(value)) return {}
  const picked = {}
  // A key is included only when its value VALIDATES: a wrong-typed or
  // out-of-whitelist value is dropped, so a merge keeps the current value
  // instead of silently resetting the field the caller got wrong.
  if (typeof value.agent === 'string') {
    const agent = value.agent.trim()
    picked.agent = agent.length > MAX_AGENT_LENGTH ? agent.slice(0, MAX_AGENT_LENGTH) : agent
  }
  if (typeof value.mode === 'string' && MODES.includes(value.mode)) picked.mode = value.mode
  if (typeof value.approve === 'string' && APPROVES.includes(value.approve)) picked.approve = value.approve
  if (typeof value.format === 'string' && FORMATS.includes(value.format)) picked.format = value.format
  if ('timeoutMs' in value) {
    const numeric = typeof value.timeoutMs === 'string' && value.timeoutMs.trim() !== ''
      ? Number(value.timeoutMs)
      : value.timeoutMs
    if (typeof numeric === 'number' && Number.isFinite(numeric)) picked.timeoutMs = clampTimeout(numeric)
  }
  return picked
}

function defaultDefaults() {
  return { ...DEFAULT_PREFS.defaults }
}

/**
 * Turn whatever is on disk (or an API patch) into a complete, valid document.
 * Unknown fields are dropped, wrong types are dropped, and an unknown version
 * discards the whole document.
 */
export function sanitizePrefs(raw) {
  if (!isRecord(raw)) return { ...DEFAULT_PREFS, disabledModels: [], displayNames: {}, defaults: defaultDefaults() }
  if (raw.version !== PREF_VERSION) {
    return { ...DEFAULT_PREFS, disabledModels: [], displayNames: {}, defaults: defaultDefaults() }
  }
  const defaults = { ...defaultDefaults(), ...pickDefaults(raw.defaults) }
  return {
    version: PREF_VERSION,
    disabledModels: sanitizeDisabledModels(raw.disabledModels),
    displayNames: sanitizeDisplayNames(raw.displayNames),
    baseURLOverride: sanitizeBaseURL(raw.baseURLOverride),
    defaults,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

/**
 * Apply a partial patch over the current document.
 *
 * Top-level keys are replaced wholesale when the patch names them;
 * `defaults` is the exception — it merges key by key so a timeout edit never
 * resets the other delegate defaults.
 */
export function mergePrefs(current, patch) {
  const base = sanitizePrefs(current)
  if (!isRecord(patch)) return base
  const next = { ...base, defaults: { ...base.defaults } }
  if ('disabledModels' in patch) next.disabledModels = sanitizeDisabledModels(patch.disabledModels)
  if ('displayNames' in patch) next.displayNames = sanitizeDisplayNames(patch.displayNames)
  if ('baseURLOverride' in patch) next.baseURLOverride = sanitizeBaseURL(patch.baseURLOverride)
  if ('defaults' in patch && isRecord(patch.defaults)) {
    next.defaults = { ...base.defaults, ...pickDefaults(patch.defaults) }
  }
  return next
}

/** Fast lookup set of disabled model ids. */
export function disabledModelSet(prefs) {
  const sanitized = prefs && Array.isArray(prefs.disabledModels) ? prefs.disabledModels : []
  return new Set(sanitized)
}

/** Whether one model id is switched off in the settings page. */
export function isModelDisabled(prefs, id) {
  if (typeof id !== 'string' || !id) return false
  return disabledModelSet(prefs).has(id)
}

/** Every distinct configured model id, in declaration order. */
export function uniqueModelIds(tools) {
  const ids = []
  const seen = new Set()
  for (const tool of tools ?? []) {
    for (const id of tool.models ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/** Model ids that are configured AND enabled — what the model selector may show. */
export function enabledModelIds(tools, prefs) {
  const disabled = disabledModelSet(prefs)
  return uniqueModelIds(tools).filter(id => !disabled.has(id))
}

/**
 * Selector display name for one model id: the page's display-name override
 * wins, otherwise the collision-safe name derived from the tool list.
 */
export function modelDisplayName(id, tools, prefs) {
  const overrides = prefs && isRecord(prefs.displayNames) ? prefs.displayNames : {}
  const override = overrides[id]
  if (typeof override === 'string' && override.trim()) return override.trim()
  return tools ? displayNameForModel(id, tools) : displayNameForModel(id)
}

/** A model id of `default` means "the agent advertised no real model yet". */
export function isPlaceholderModel(id) {
  return String(id) === 'default'
}

// ---------------------------------------------------------------------------
// Atomic document store
// ---------------------------------------------------------------------------

/** Write one document atomically: temp sibling (0600) then rename over target. */
export async function writePrefsFile(file, prefs, logger = null) {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: DIR_MODE })
  try {
    await chmod(directory, DIR_MODE)
  } catch (error) {
    // A directory we cannot chmod (strange mount, foreign owner) must not stop
    // the write; the file itself still lands 0600.
    logger?.warn?.(`[acpx-bridge] unable to chmod ${directory} to 0700: ${error?.message ?? error}`)
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  const body = `${JSON.stringify(prefs, null, 2)}\n`
  try {
    await writeFile(temporary, body, { mode: FILE_MODE, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Serialized read-modify-write store for the preference document.
 *
 * Writes are queued one at a time: two overlapping toggles can never
 * interleave a read and a rename and lose one of them. The in-memory snapshot
 * is replaced only after the file commit succeeds, so a failed write leaves the
 * previous state visible and the caller sees the rejection.
 */
export class PrefsStore {
  constructor({ file = prefsFile(), logger = null, now = () => new Date() } = {}) {
    this.file = file
    this.logger = logger
    this.now = now
    this.current = { ...DEFAULT_PREFS, disabledModels: [], displayNames: {}, defaults: defaultDefaults() }
    this.queue = Promise.resolve()
    this.loaded = false
  }

  /** Read the document once at plugin start; a missing file means defaults. */
  async load() {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.loaded = true
        return this.read()
      }
      this.logger?.warn?.(`[acpx-bridge] unable to read ${this.file}: ${error?.message ?? error}`)
      this.loaded = true
      return this.read()
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.logger?.warn?.(`[acpx-bridge] ${this.file} is not valid JSON, using defaults: ${error?.message ?? error}`)
      this.loaded = true
      return this.read()
    }
    this.current = sanitizePrefs(parsed)
    this.loaded = true
    return this.read()
  }

  /** Isolated snapshot of the current document. */
  read() {
    return clonePrefs(this.current)
  }

  /** Merge one patch, commit atomically, and return the committed document. */
  update(patch) {
    return this._enqueue(async () => this._commit(mergePrefs(this.current, patch)))
  }

  /** Replace the document with the defaults (the settings page's reset). */
  reset() {
    return this._enqueue(async () => this._commit(sanitizePrefs(DEFAULT_PREFS)))
  }

  /** Await the whole queued backlog (used by tests). */
  whenIdle() {
    return this.queue
  }

  _enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async _commit(next) {
    const stamped = { ...next, updatedAt: this.now().toISOString() }
    await writePrefsFile(this.file, stamped, this.logger)
    this.current = stamped
    return clonePrefs(stamped)
  }
}
