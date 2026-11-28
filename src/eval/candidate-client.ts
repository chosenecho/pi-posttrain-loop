import http from "node:http";
import https from "node:https";
import { resolveApiEndpoint } from "../shared/api-config.js";
import { createAttemptCancellation, rethrowIfAborted, throwIfAborted } from "../shared/cancellation.js";
import { PublicError, toPublicError } from "../shared/public-error.js";
import { DEFAULT_CALL_MAX_ATTEMPTS, DEFAULT_CALL_RETRY_DELAY_MS, validateCallMaxAttempts, validateCallRetryDelayMs } from "../shared/retry.js";
import { validateConcurrency } from "../shared/schema.js";
import { readCandidateIdentityConfig } from "./candidate-config.js";
import { CANDIDATE_ADAPTER_CONTRACT_VERSION, EvaluationSpecError, type ResolvedEvaluationSpec } from "./evaluation-spec.js";

export { readCandidateIdentityConfig, type CandidateIdentityConfig } from "./candidate-config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CandidateRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type CandidateRunner = (request: CandidateRequest) => Promise<string>;

export interface CandidateOperationalConfig {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly callMaxAttempts: number;
  readonly callRetryDelayMs: number;
}

export interface BoundCandidate {
  readonly specHash: string;
  run(request: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<string>;
}

export type CandidateFactory = (spec: ResolvedEvaluationSpec, runtime: CandidateOperationalConfig) => BoundCandidate;

/** Explicit compatibility adapter for a caller-owned runner. Its identity is a caller assertion. */
export function bindCandidate(spec: ResolvedEvaluationSpec, runner: CandidateRunner): BoundCandidate {
  return Object.freeze({
    specHash: spec.hash,
    run: async ({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }) => {
      throwIfAborted(signal);
      const answer = await runner({ messages, temperature: spec.temperature, maxTokens: spec.maxTokens, signal });
      throwIfAborted(signal);
      return answer;
    },
  });
}

export function readCandidateOperationalConfig(
  spec: ResolvedEvaluationSpec,
  overrides: Partial<CandidateOperationalConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): CandidateOperationalConfig {
  const { apiKey } = resolveApiEndpoint({
    baseUrl: spec.endpoint, apiKey: overrides.apiKey,
    fallbacks: [
      { baseUrl: env.CANDIDATE_LLM_BASE_URL ?? env.LLM_BASE_URL, apiKey: env.CANDIDATE_LLM_API_KEY },
      { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY },
    ],
    baseUrlLabel: "候选模型 API 地址", apiKeyLabel: "候选模型密钥", allowEmptyKey: true,
  });
  const timeoutMs = overrides.timeoutMs ?? Number(env.CANDIDATE_LLM_TIMEOUT_MS ?? env.LLM_TIMEOUT_MS ?? 90_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("--timeout-ms 必须是 1–3600000 的整数");
  }
  return Object.freeze({
    apiKey, timeoutMs,
    concurrency: validateConcurrency(overrides.concurrency ?? 4),
    callMaxAttempts: validateCallMaxAttempts(overrides.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS),
    callRetryDelayMs: validateCallRetryDelayMs(overrides.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS),
  });
}

/** Production requests can only obtain model, sampling and output rules from the resolved spec. */
export const createOpenAiCandidate: CandidateFactory = (spec, runtime) => {
  if (spec.adapterContractVersion !== CANDIDATE_ADAPTER_CONTRACT_VERSION) {
    throw new EvaluationSpecError("candidate_identity_mismatch", "生产 candidate adapter 的契约版本与规格不匹配");
  }
  const runner = createOpenAiCandidateRunner({
    baseUrl: spec.endpoint, modelId: spec.modelId, temperature: spec.temperature,
    maxTokens: spec.maxTokens, stripThinkTags: spec.stripThinkTags,
    apiKey: runtime.apiKey, timeoutMs: runtime.timeoutMs,
  });
  return Object.freeze({ specHash: spec.hash, run: ({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }) => runner({ messages, signal }) });
};

export interface OpenAiCandidateConfig {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  stripThinkTags?: boolean;
  /** Injectable fetch implementation for unit tests. */
  fetchFn?: typeof fetch;
}

export function readCandidateConfig(
  overrides: {
    baseUrl?: string;
    modelId?: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    stripThinkTags?: boolean;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): OpenAiCandidateConfig {
  const { baseUrl, apiKey } = resolveApiEndpoint({
    baseUrl: overrides.baseUrl ?? env.CANDIDATE_LLM_BASE_URL ?? env.LLM_BASE_URL,
    apiKey: overrides.apiKey ?? env.CANDIDATE_LLM_API_KEY,
    fallbacks: [{ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY }],
    baseUrlLabel: "候选模型 API 地址（--base-url / CANDIDATE_LLM_BASE_URL / LLM_BASE_URL）",
    apiKeyLabel: "候选模型密钥（--api-key / CANDIDATE_LLM_API_KEY）",
    allowEmptyKey: true,
  });
  const identity = readCandidateIdentityConfig(overrides, env);
  const timeoutMs = overrides.timeoutMs ?? Number(env.CANDIDATE_LLM_TIMEOUT_MS ?? env.LLM_TIMEOUT_MS ?? 90_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("--timeout-ms 必须是 1–3600000 的整数");
  }

  return { ...identity, baseUrl, apiKey, timeoutMs };
}

/**
 * Strips leading `<think>...</think>` blocks emitted by local reasoning-enabled OpenAI endpoints
 * only when non-empty final answer content follows the block.
 */
export function stripLeadingThinkBlock(text: string): string {
  const match = /^\s*<think>[\s\S]*?<\/think>\s*([\s\S]+)$/i.exec(text);
  return match ? match[1]!.trim() : text.trim();
}

interface RawHttpResponse {
  status: number;
  contentType: string;
  bodyText: string;
}

/**
 * Uses `node:http` / `node:https` directly when no custom `fetchFn` is injected so long-running
 * non-streaming micro-batched inference servers are not aborted by undici's hard-coded 300s headersTimeout.
 */
function postJsonViaNodeHttp(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<RawHttpResponse> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const transport = url.protocol === "https:" ? https : http;
    const payload = Buffer.from(body, "utf8");
    let response: RawHttpResponse | undefined;
    let failure: unknown;
    const req = transport.request(
      {
        protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
        path: `${url.pathname}${url.search}`, method: "POST",
        headers: { ...headers, "content-length": String(payload.byteLength) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
        res.on("error", (error) => { failure ??= error; req.destroy(error); });
        res.on("end", () => {
          const ctHeader = res.headers["content-type"];
          response = {
            status: res.statusCode ?? 0,
            contentType: Array.isArray(ctHeader) ? ctHeader.join(", ") : (ctHeader ?? ""),
            bodyText: Buffer.concat(chunks).toString("utf8"),
          };
        });
      },
    );
    const onAbort = () => {
      try { throwIfAborted(signal); } catch (error) { failure = error; }
      req.destroy(failure instanceof Error ? failure : new PublicError("operation_aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error) => { failure ??= error; });
    // Settle only after the actual request closes, including abort and response stream errors.
    req.once("close", () => {
      signal.removeEventListener("abort", onAbort);
      try { throwIfAborted(signal); } catch (error) { failure = error; }
      if (failure !== undefined) reject(failure);
      else if (response) resolve(response);
      else reject(new PublicError("candidate_request_failed"));
    });
    if (signal.aborted) onAbort();
    else req.end(payload);
  });
}

/**
 * Native multi-turn OpenAI-compatible `/chat/completions` client for evaluating candidate models
 * (`base`, `sft-v1`, `dpo-v1`, etc.) in exact ChatML message format without transcript leakage.
 */
export function createOpenAiCandidateRunner(config: OpenAiCandidateConfig): CandidateRunner {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async ({ messages, temperature, maxTokens, signal }) => {
    const cancellation = createAttemptCancellation(signal, config.timeoutMs);
    try {
      throwIfAborted(cancellation.signal);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (config.apiKey && config.apiKey !== "EMPTY") {
        headers.authorization = `Bearer ${config.apiKey}`;
      }
      const body = JSON.stringify({
        model: config.modelId,
        messages,
        temperature: temperature ?? config.temperature,
        max_tokens: maxTokens ?? config.maxTokens,
        stream: false,
      });

      let rawResponse: RawHttpResponse;
      if (config.fetchFn) {
        const response = await config.fetchFn(endpoint, {
          method: "POST", headers, body, signal: cancellation.signal,
        });
        rawResponse = {
          status: response.status, contentType: response.headers.get("content-type") ?? "",
          bodyText: await response.text(),
        };
      } else {
        rawResponse = await postJsonViaNodeHttp(endpoint, headers, body, cancellation.signal);
      }
      throwIfAborted(cancellation.signal);

      const { status, contentType, bodyText } = rawResponse;

      if (status < 200 || status >= 300) {
        throw new PublicError("candidate_http_error", { httpStatus: status });
      }

      if (contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html/i.test(bodyText)) {
        throw new PublicError("candidate_html_response", { httpStatus: status });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new PublicError("candidate_invalid_json", { httpStatus: status });
      }

      const payload = parsed as {
        error?: { message?: string } | string;
        choices?: Array<{
          finish_reason?: string | null;
          message?: { content?: unknown };
        }>;
      };
      if (payload.error) {
        throw new PublicError("candidate_api_error", { httpStatus: status });
      }

      const choice = payload.choices?.[0];
      if (!choice) {
        throw new PublicError("candidate_missing_choice", { httpStatus: status });
      }
      const rawContent = choice.message?.content;
      let text = "";
      if (typeof rawContent === "string") {
        text = rawContent;
      } else if (Array.isArray(rawContent)) {
        text = rawContent
          .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
          .join("");
      }

      const cleaned = config.stripThinkTags !== false ? stripLeadingThinkBlock(text) : text.trim();
      if (!cleaned) {
        throw new PublicError("candidate_empty_output", { httpStatus: status, stopReason: choice.finish_reason });
      }
      return cleaned;
    } catch (error) {
      rethrowIfAborted(error, cancellation.signal);
      throw toPublicError(error, "candidate_request_failed");
    } finally {
      cancellation.dispose();
    }
  };
}
