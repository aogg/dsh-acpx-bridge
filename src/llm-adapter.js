/**
 * dsh LLM adapter backed by the acpx-bridge OpenAI-compatible endpoint.
 *
 * It advertises every model declared under the configured command tools (minus
 * the ones switched off on the settings page) so the dsh model selector can
 * pick one, then streams calls through the shared openai-stream module.
 *
 * The connection — endpoint (with the settings page override) and the API key
 * resolved from the credential seam — is recomputed on EVERY call instead of
 * being snapshotted at registration: saving a key or editing the endpoint on
 * the settings page must reach the very next request without a plugin restart.
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { toWireModel } from './config.js'
import { DEFAULT_PREFS, enabledModelIds, isModelDisabled, modelDisplayName } from './prefs.js'
import { streamChatCompletion } from './openai-stream.js'

const DEFAULT_CONTEXT_WINDOW = 131072
const DEFAULT_MAX_TOKENS = 8192

export class AcpxBridgeAdapter extends LlmAdapter {
  /**
   * @param resolved.tools - tool list, or a function returning the current one.
   * @param resolved.prefs - preference document, or a function returning it.
   * @param resolved.baseURL - static endpoint (legacy/plain construction).
   * @param resolved.apiKey - static key (legacy/plain construction).
   * @param resolved.wireModels - static wire mapping.
   * @param resolved.resolveConnection - async () => `{ baseURL, apiKey, wireModels }`;
   *   when present it wins and is awaited per call.
   */
  constructor(resolved = {}) {
    super()
    this.init = resolved
    this.tools = resolved.tools ?? []
    this.prefsSource = resolved.prefs ?? null
    this.connection = {
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      wireModels: resolved.wireModels ?? {},
    }
  }

  currentTools() {
    return typeof this.tools === 'function' ? this.tools() : this.tools
  }

  currentPrefs() {
    if (typeof this.prefsSource === 'function') return this.prefsSource() ?? DEFAULT_PREFS
    return this.prefsSource ?? DEFAULT_PREFS
  }

  /** The connection for the next request: async because the key resolves per call. */
  async connectionFor() {
    if (typeof this.init.resolveConnection === 'function') return this.init.resolveConnection()
    return this.connection
  }

  providerInfo(provider) {
    return { id: provider, name: 'acpx-bridge' }
  }

  async listModels(provider) {
    const tools = this.currentTools()
    const prefs = this.currentPrefs()
    return enabledModelIds(tools, prefs).map(id => ({
      provider,
      id,
      name: modelDisplayName(id, tools, prefs),
      description: 'acpx-bridge / OpenAI-compatible endpoint',
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model, _signal) {
    const prefs = this.currentPrefs()
    if (isModelDisabled(prefs, model)) {
      throw new LlmError(
        `acpx-bridge: model "${model}" is disabled on the acpx-bridge settings page`,
        'MODEL_DISABLED',
      )
    }
    const tools = this.currentTools()
    return {
      provider,
      id: model,
      name: modelDisplayName(model, tools, prefs),
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    }
  }

  /**
   * `stream` keeps the adapter contract (an AsyncIterable returned
   * synchronously) while awaiting the per-call connection inside the generator.
   */
  async *stream(options) {
    const connection = await this.connectionFor()
    yield* streamChatCompletion(
      { ...options, wireModel: toWireModel(options.model, connection.wireModels) },
      connection,
    )
  }
}
