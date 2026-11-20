/**
 * dsh LLM adapter backed by the acpx-bridge OpenAI-compatible endpoint.
 *
 * It advertises every model declared under the configured command tools so the
 * dsh model selector can pick one, then streams calls through the shared
 * openai-stream module.
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { allModelIds, displayNameForModel, toWireModel } from './config.js'
import { streamChatCompletion } from './openai-stream.js'

const DEFAULT_CONTEXT_WINDOW = 131072
const DEFAULT_MAX_TOKENS = 8192

export class AcpxBridgeAdapter extends LlmAdapter {
  constructor(resolved) {
    super()
    this.connection = {
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
    }
    // May be a function so volatile config updates are visible on the next read.
    this.tools = resolved.tools ?? []
  }

  currentTools() {
    return typeof this.tools === 'function' ? this.tools() : this.tools
  }

  providerInfo(provider) {
    return { id: provider, name: 'acpx-bridge' }
  }

  async listModels(provider) {
    return allModelIds(this.currentTools()).map(id => ({
      provider,
      id,
      name: displayNameForModel(id),
      description: 'acpx-bridge / OpenAI-compatible endpoint',
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: displayNameForModel(model),
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    }
  }

  stream(options) {
    return streamChatCompletion(
      { ...options, wireModel: toWireModel(options.model) },
      this.connection,
    )
  }
}
