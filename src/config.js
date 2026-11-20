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
  /** OpenAI-compatible API key. Empty by default; supply via env/cordis. */
  apiKey: z.string().default('').volatile(),
  /** OpenAI-compatible endpoint root (without /chat/completions). */
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
})

/** Read a schemastery volatile reference or a plain value. */
function read(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

/**
 * Turn the cordis Config (volatile refs or plain values) into plain options.
 * Environment variables take precedence only when the config value is blank,
 * so an explicit cordis value still wins.
 */
export function resolveConfig(config = {}) {
  const tools = read(config.tools) ?? DEFAULT_TOOLS
  const apiKey = read(config.apiKey) || process.env[API_KEY_ENV] || ''
  const baseURL = read(config.baseURL) || process.env[BASE_URL_ENV] || DEFAULT_BASE_URL
  return { tools, apiKey, baseURL: baseURL.replace(/\/+$/, '') }
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
 * Selector display name. `gs/deepseek-flash-deepseek.com` → `acpx/deepseek-flash`.
 */
export function displayNameForModel(id) {
  let name = String(id)
  if (name.includes('/')) name = name.slice(name.lastIndexOf('/') + 1)
  name = name.replace(/-deepseek\.com$/i, '')
  return `acpx/${name}`
}

/**
 * Wire model id sent to the OpenAI-compatible endpoint. The proxy expects the
 * bare model name (`deepseek-flash`), not the WorkBuddy routing key.
 */
export function toWireModel(id) {
  return displayNameForModel(id).replace(/^acpx\//, '')
}
