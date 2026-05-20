import type { MemoryProvider } from "../types.js";
import { DefaultAzureCredential } from "@azure/identity";
import { getEnvVar } from "../config.js";
import { fetchWithTimeout } from "./_fetch.js";
import {
  DEFAULT_AZURE_API_VERSION,
  buildAuthHeaders,
  buildBearerAuthHeaders,
  buildChatUrl,
  detectAzure,
  normalizeBaseUrl,
} from "./_openai-shared.js";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_AZURE_TOKEN_SCOPE = "https://cognitiveservices.azure.com/.default";

type OpenAIAuthMode = "api-key" | "azure-default-credential";
type AzureTokenCredential = {
  getToken(scopes: string | string[]): Promise<{ token: string } | null>;
};

/**
 * OpenAI-compatible LLM provider.
 *
 * Uses raw fetch (no SDK) to support any OpenAI-compatible endpoint:
 *   - OpenAI official
 *   - Azure OpenAI (auto-detected from .openai.azure.com host)
 *   - DeepSeek
 *   - 硅基流动 (SiliconFlow)
 *   - vLLM / LM Studio / Ollama (with OpenAI compatibility layer)
 *   - Any other proxy implementing /v1/chat/completions
 *
 * Required env vars:
 *   OPENAI_API_KEY  — API key
 *   AZURE_OPENAI_API_KEY — Azure OpenAI API key alias for chat completions
 *   AZURE_OPENAI_AUTH=default — use Azure DefaultAzureCredential instead of an API key
 *
 * Optional:
 *   OPENAI_BASE_URL          — base URL without path (default: https://api.openai.com).
 *                              Azure: https://<resource>.openai.azure.com/openai/deployments/<deployment>
 *   OPENAI_MODEL             — model name (default: gpt-4o-mini)
 *   OPENAI_API_VERSION       — Azure api-version query param (default: 2024-08-01-preview)
 *   AZURE_OPENAI_API_VERSION — Azure-specific alias for OPENAI_API_VERSION
 *   AZURE_OPENAI_TOKEN_SCOPE — Entra token scope for Azure OpenAI
 *   OPENAI_TIMEOUT_MS        — outbound fetch timeout in ms (OpenAI-scoped alias,
 *                              takes precedence over AGENTMEMORY_LLM_TIMEOUT_MS
 *                              for back-compat with the v0.9.17 shipping name).
 *   AGENTMEMORY_LLM_TIMEOUT_MS — outbound fetch timeout in ms shared across all
 *                              raw-fetch LLM + embedding providers. Used when
 *                              OPENAI_TIMEOUT_MS is not set. Default: 60000.
 *   MAX_TOKENS               — max output tokens (default: from config or 4096)
 *   OPENAI_REASONING_EFFORT  — "low" | "medium" | "high" | "none"
 *                              Passthrough for reasoning models (e.g. Ollama Cloud
 *                              thinking models). Set to "none" to ensure
 *                              message.content is populated instead of only
 *                              message.reasoning.
 */
export class OpenAIProvider implements MemoryProvider {
  name = "openai";
  private apiKey: string | null;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;
  private reasoningEffort?: string;
  private timeoutMs: number;
  private isAzure: boolean;
  private azureApiVersion: string;
  private authMode: OpenAIAuthMode;
  private azureCredential?: AzureTokenCredential;
  private azureTokenScope: string;

  constructor(
    apiKey: string | null,
    model: string,
    maxTokens: number,
    baseURL?: string,
    authMode: OpenAIAuthMode = "api-key",
    azureCredential?: AzureTokenCredential,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.baseUrl = normalizeBaseUrl(baseURL || getEnvVar("OPENAI_BASE_URL"));
    this.reasoningEffort = getEnvVar("OPENAI_REASONING_EFFORT") || undefined;
    this.timeoutMs = resolveTimeout();
    this.azureApiVersion =
      getEnvVar("AZURE_OPENAI_API_VERSION") ||
      getEnvVar("OPENAI_API_VERSION") ||
      DEFAULT_AZURE_API_VERSION;
    this.isAzure = detectAzure(this.baseUrl);
    this.authMode = authMode;
    this.azureCredential = azureCredential;
    this.azureTokenScope =
      getEnvVar("AZURE_OPENAI_TOKEN_SCOPE") || DEFAULT_AZURE_TOKEN_SCOPE;
    if (this.authMode === "azure-default-credential" && !this.isAzure) {
      throw new Error(
        "Azure DefaultAzureCredential auth requires an Azure OpenAI endpoint",
      );
    }
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const url = buildChatUrl(this.baseUrl, this.isAzure, this.azureApiVersion);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    body[usesMaxCompletionTokens(this.model) ? "max_completion_tokens" : "max_tokens"] =
      this.maxTokens;
    if (this.reasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }

    // Bound the request via the shared fetchWithTimeout helper, which
    // owns the AbortController + clearTimeout cleanup for every raw-fetch
    // provider (minimax, openrouter, gemini, openrouter-embed, etc.).
    // OPENAI_TIMEOUT_MS keeps its v0.9.17 meaning (OpenAI-scoped alias,
    // takes precedence); when unset we fall through to
    // AGENTMEMORY_LLM_TIMEOUT_MS and finally the 60s default. See #446.
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: await this.authHeaders(),
          body: JSON.stringify(body),
        },
        this.timeoutMs,
      );
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        throw new Error(
          `OpenAI API request timed out after ${this.timeoutMs}ms — set OPENAI_TIMEOUT_MS (or AGENTMEMORY_LLM_TIMEOUT_MS) to raise the bound or check the provider status.`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
    };
    const message = data.choices?.[0]?.message;
    const content = message?.content;
    if (content) {
      return content;
    }
    // Fallback: some thinking models return reasoning but no content
    const reasoning = message?.reasoning;
    if (reasoning) {
      return reasoning;
    }
    throw new Error(
      `OpenAI returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.authMode === "azure-default-credential") {
      const credential = this.azureCredential ?? new DefaultAzureCredential();
      const token = await credential.getToken(this.azureTokenScope);
      if (!token?.token) {
        throw new Error(
          `Azure DefaultAzureCredential did not return a token for ${this.azureTokenScope}`,
        );
      }
      return buildBearerAuthHeaders(token.token);
    }
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY or AZURE_OPENAI_API_KEY is required for API-key auth");
    }
    return buildAuthHeaders(this.apiKey, this.isAzure);
  }
}

// Resolves the outbound-fetch timeout for the OpenAI LLM path.
// Precedence (preserving v0.9.17 behaviour):
//   1. OPENAI_TIMEOUT_MS       — OpenAI-scoped alias (back-compat)
//   2. AGENTMEMORY_LLM_TIMEOUT_MS — global LLM/embedding timeout (#446)
//   3. 60 000 ms default
function resolveTimeout(): number {
  const openaiRaw = getEnvVar("OPENAI_TIMEOUT_MS");
  const openai = parsePositiveInt(openaiRaw);
  if (openai !== undefined) return openai;

  const globalRaw = getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS");
  const globalMs = parsePositiveInt(globalRaw);
  if (globalMs !== undefined) return globalMs;

  return DEFAULT_TIMEOUT_MS;
}

function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // Reject malformed values like "30ms" or "1_000" — parseInt would
  // silently return 30 / 1, swallowing user typos as valid timeouts.
  // The regex enforces pure digits (no sign, no trailing units, no
  // separators) before we hand off to Number.
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function usesMaxCompletionTokens(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model);
}
