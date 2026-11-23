/**
 * Configuration for dsh-acpx-bridge.
 *
 * Secrets are never stored in this file. `apiKey` defaults to an empty string
 * and is expected from the environment (`ACPX_BRIDGE_API_KEY`) or from a cordis
 * config using `!!js process.env.ACPX_BRIDGE_API_KEY`. See cordis.patch.yml.
 */

import z from '@deepseek-ai/schemastery'

/** Globally unique provider route registered into dsh's model selector. */
export const PROVIDER = 'acpx-bridge'

export const API_KEY_ENV = 'ACPX_BRIDGE_API_KEY'
export const BASE_URL_ENV = 'ACPX_BRIDGE_BASE_URL'

/**
 * Verified WorkBuddy OpenAI-compatible proxy endpoint. This is an address, not
 * a credential; the credential is supplied via the environment at runtime.
 */
export const DEFAULT_BASE_URL = 'http://default.cli-proxy-api.port.8317.proxy_sslip.10.8.7.2.sslip.io/v1'

/** Default model routing id (the id WorkBuddy models.json uses). */
export const DEFAULT_MODEL_ID = 'gs/deepseek-flash-deepseek.com'

/** One "command tool" == one acpx agent profile, with its selectable models. */
export const DEFAULT_TOOLS = [
  { name: 'deepseek-harness', models: [DEFAULT_MODEL_ID] },
]

const ToolSchema = z.object({
  name: z.string().required(),
  models: z.array(z.string()).default([]),
})

export const Config = z.object({
  /** Command tools (acpx agents) and the models offered under each one. */
  tools: z.array(ToolSchema).default(DEFAULT_TOOLS).volatile(),
  /**
   * Optional `<selector model id> -> <wire model id>` overrides. Only needed
   * when the endpoint expects a different id than the one in the selector;
   * otherwise the full configured id is sent as-is.
   */
  wireModels: z.dict(z.string()).default({}).volatile(),
  /** OpenAI-compatible API key. Empty by default; supply via env/cordis. */
  apiKey: z.string().default('').volatile(),
  /** OpenAI-compatible endpoint root (without /chat/completions). */
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
})

/** Read a schemastery volatile reference or a plain value. */
function read(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/** Public form of {@link read}: volatile reference or plain value. */
export function readConfigValue(value) {
  return read(value)
}

function trimTrailingSlashes(value) {
  return String(value).replace(/\/+$/, '')
}

/**
 * Turn the cordis Config (volatile refs or plain values) into plain options.
 * Environment variables take precedence only when the config value is blank,
 * so an explicit cordis value still wins.
 */
export function resolveConfig(config = {}) {
  const tools = read(config.tools) ?? DEFAULT_TOOLS
  const wireModels = read(config.wireModels) ?? {}
  const apiKey = read(config.apiKey) || process.env[API_KEY_ENV] || ''
  const baseURL = read(config.baseURL) || process.env[BASE_URL_ENV] || DEFAULT_BASE_URL
  return { tools, wireModels, apiKey, baseURL: trimTrailingSlashes(baseURL) }
}

/**
 * Where the endpoint came from, for the settings page's source label.
 * The page-level override is applied on top of this by src/index.js.
 * @param config - raw cordis config (volatile refs or plain values).
 * @returns `{ effective, source, fallback }`, source one of config/env/default.
 */
export function endpointInfo(config = {}) {
  const configured = read(config.baseURL)
  if (typeof configured === 'string' && configured.trim()) {
    return { effective: trimTrailingSlashes(configured.trim()), source: 'config', fallback: DEFAULT_BASE_URL }
  }
  const fromEnv = process.env[BASE_URL_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return { effective: trimTrailingSlashes(fromEnv.trim()), source: 'env', fallback: DEFAULT_BASE_URL }
  }
  return { effective: DEFAULT_BASE_URL, source: 'default', fallback: DEFAULT_BASE_URL }
}

/** Deduplicated list of every model id declared under every command tool. */
export function allModelIds(tools) {
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

/**
 * Short base label of a model id: `gs/deepseek-flash-deepseek.com` →
 * `deepseek-flash`, `my/opencode/deepseek-v4.1-flash-free` →
 * `deepseek-v4.1-flash-free`.
 */
export function baseDisplayName(id) {
  let name = String(id)
  if (name.includes('/')) name = name.slice(name.lastIndexOf('/') + 1)
  return name.replace(/-deepseek\.com$/i, '')
}

/**
 * Selector display names for every configured model, guaranteed unique.
 *
 * The name is `acpx/<last path segment>`. When two different model ids share
 * that segment, both are disambiguated with the owning command tool as
 * `acpx/<agent>:<segment>` so the selector never shows two identical entries.
 * Returns a Map<modelId, displayName>.
 */
export function modelDisplayNames(tools) {
  /** @type {Map<string, string[]>} modelId -> owning tool names */
  const owners = new Map()
  for (const tool of tools ?? []) {
    for (const id of tool.models ?? []) {
      const list = owners.get(id) ?? []
      if (!list.includes(tool.name)) list.push(tool.name)
      owners.set(id, list)
    }
  }

  /** @type {Map<string, string[]>} base label -> model ids sharing it */
  const byBase = new Map()
  for (const id of owners.keys()) {
    const base = baseDisplayName(id)
    byBase.set(base, [...(byBase.get(base) ?? []), id])
  }

  const names = new Map()
  for (const [base, ids] of byBase) {
    if (ids.length === 1) {
      names.set(ids[0], `acpx/${base}`)
      continue
    }
    for (const id of ids) {
      const owner = (owners.get(id) ?? ['unknown'])[0]
      names.set(id, `acpx/${owner}:${base}`)
    }
  }
  return names
}

/**
 * Selector display name for one model id. Pass `tools` to get the
 * collision-safe name used in the model selector.
 */
export function displayNameForModel(id, tools) {
  if (tools) {
    const names = modelDisplayNames(tools)
    if (names.has(id)) return names.get(id)
  }
  return `acpx/${baseDisplayName(id)}`
}

/**
 * Wire model id sent to the OpenAI-compatible endpoint.
 *
 * The endpoint is addressed by the *full* configured id (e.g.
 * `my/opencode/deepseek-v4.1-flash-free`), so the id is forwarded verbatim.
 * `wireModels` is an explicit escape hatch for endpoints that expect another
 * spelling; it wins when present.
 */
export function toWireModel(id, wireModels) {
  const key = String(id)
  const mapped = wireModels && typeof wireModels === 'object' ? wireModels[key] : undefined
  return mapped !== undefined && mapped !== '' ? String(mapped) : key
}
