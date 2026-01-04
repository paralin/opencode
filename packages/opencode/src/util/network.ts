import * as Log from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/core/util/error"
import { Schema } from "effect"

export namespace Network {
  const log = Log.create({ service: "network" })

  // State is managed externally via setOffline() to avoid circular dependencies with Config
  let offlineMode = true

  export function setOffline(value: boolean) {
    offlineMode = value
    log.info("offline mode", { enabled: offlineMode })
  }

  export function isOffline() {
    return offlineMode
  }

  export const OfflineError = NamedError.create(
    "NetworkOfflineError",
    Schema.Struct({
      url: Schema.String,
      feature: Schema.optional(Schema.String),
    }),
  )

  /**
   * Check if a URL is allowed based on offline mode settings.
   * In offline mode, only LLM provider API URLs are allowed.
   */
  export function isAllowedUrl(url: string): boolean {
    if (!offlineMode) return true

    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()

    // Allow LLM provider APIs - these are the core functionality
    const allowedProviderHosts = [
      // Anthropic
      "api.anthropic.com",
      // OpenAI
      "api.openai.com",
      // Google
      "generativelanguage.googleapis.com",
      "aiplatform.googleapis.com",
      // Google Vertex
      "vertexai.googleapis.com",
      // AWS Bedrock (various regions)
      ".amazonaws.com",
      // Azure OpenAI (various resource names)
      ".openai.azure.com",
      ".cognitiveservices.azure.com",
      // Cohere
      "api.cohere.com",
      "api.cohere.ai",
      // Mistral
      "api.mistral.ai",
      // Groq
      "api.groq.com",
      // Perplexity
      "api.perplexity.ai",
      // Together AI
      "api.together.xyz",
      // Fireworks
      "api.fireworks.ai",
      // DeepSeek
      "api.deepseek.com",
      // XAI
      "api.x.ai",
      // Cerebras
      "api.cerebras.ai",
      // DeepInfra
      "api.deepinfra.com",
      // OpenRouter
      "openrouter.ai",
      // Ollama (local)
      "localhost",
      "127.0.0.1",
      // LM Studio (local)
      "0.0.0.0",
      // Cloudflare AI Gateway
      "gateway.ai.cloudflare.com",
      // Replicate
      "api.replicate.com",
      // Hugging Face
      "api-inference.huggingface.co",
      // AI21
      "api.ai21.com",
      // Minimax
      "api.minimax.chat",
      // Zhipu / GLM
      "open.bigmodel.cn",
      // Moonshot
      "api.moonshot.cn",
      // Baichuan
      "api.baichuan-ai.com",
      // 01.AI / Yi
      "api.lingyiwanwu.com",
      // Qwen / Dashscope
      "dashscope.aliyuncs.com",
      // SAP AI Core
      "api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com",
      // Novita AI
      "api.novita.ai",
    ]

    for (const allowed of allowedProviderHosts) {
      if (allowed.startsWith(".")) {
        if (host.endsWith(allowed)) return true
      } else {
        if (host === allowed) return true
      }
    }

    return false
  }

  /**
   * Guard a network request - throws OfflineError if URL is not allowed in offline mode
   */
  export function guard(url: string, feature?: string): void {
    if (!isAllowedUrl(url)) {
      log.warn("blocked network request in offline mode", { url, feature })
      throw new OfflineError({ url, feature })
    }
  }

  /**
   * Check if a feature is available (not blocked by offline mode)
   */
  export function isFeatureAvailable(feature: OfflineFeature): boolean {
    return !offlineMode
  }

  export type OfflineFeature =
    | "share"
    | "import-url"
    | "github-integration"
    | "lsp-download"
    | "auto-update"
    | "models-dev-sync"
}

export function online() {
  const nav = globalThis.navigator
  if (!nav || typeof nav.onLine !== "boolean") return true
  return nav.onLine
}

export function proxied() {
  return !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy)
}
