import http from "node:http";
import https from "node:https";
import { nonEmpty } from "../schema.js";
import { PublicError, toPublicError } from "../shared/public-error.js";
import { resolveApiEndpoint } from "../shared/api-config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CandidateRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export type CandidateRunner = (request: CandidateRequest) => Promise<string>;

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
  const modelId = nonEmpty(
    overrides.modelId ?? env.CANDIDATE_LLM_MODEL ?? env.LLM_MODEL,
    "候选模型名称（--model / CANDIDATE_LLM_MODEL / LLM_MODEL）",
  );
  const temperature = overrides.temperature ?? 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("--temperature 必须在 [0, 2] 范围内");
  }
  const maxTokens = overrides.maxTokens ?? Number(env.CANDIDATE_LLM_MAX_TOKENS ?? env.LLM_MAX_TOKENS ?? 2048);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131_072) {
    throw new Error("--max-tokens 必须是 1–131072 的整数");
  }
  const timeoutMs = overrides.timeoutMs ?? Number(env.CANDIDATE_LLM_TIMEOUT_MS ?? env.LLM_TIMEOUT_MS ?? 90_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("--timeout-ms 必须是 1–3600000 的整数");
  }

  return {
    baseUrl,
    modelId,
    apiKey,
    temperature,
    maxTokens,
    timeoutMs,
    stripThinkTags: overrides.stripThinkTags ?? true,
  };
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
  timeoutMs: number,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const transport = url.protocol === "https:" ? https : http;
    const payload = Buffer.from(body, "utf8");
    let settled = false;
    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(payload.byteLength),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        res.on("error", (err) => finishError(err));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const ctHeader = res.headers["content-type"];
          const contentType = Array.isArray(ctHeader) ? ctHeader.join(", ") : (ctHeader ?? "");
          resolve({
            status: res.statusCode ?? 0,
            contentType,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    const timer = setTimeout(() => {
      const err = new PublicError("model_timeout");
      req.destroy(err);
      finishError(err);
    }, timeoutMs);

    req.on("error", (err) => finishError(err));
    req.write(payload);
    req.end();
  });
}

/**
 * Native multi-turn OpenAI-compatible `/chat/completions` client for evaluating candidate models
 * (`base`, `sft-v1`, `dpo-v1`, etc.) in exact ChatML message format without transcript leakage.
 */
export function createOpenAiCandidateRunner(config: OpenAiCandidateConfig): CandidateRunner {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async ({ messages, temperature, maxTokens }) => {
    let requestTimedOut = false;
    try {
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
        const controller = new AbortController();
        const timer = setTimeout(() => {
          requestTimedOut = true;
          controller.abort(new PublicError("model_timeout"));
        }, config.timeoutMs);
        try {
          const response = await config.fetchFn(endpoint, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });
          rawResponse = {
            status: response.status,
            contentType: response.headers.get("content-type") ?? "",
            bodyText: await response.text(),
          };
        } finally {
          clearTimeout(timer);
        }
      } else {
        rawResponse = await postJsonViaNodeHttp(endpoint, headers, body, config.timeoutMs);
      }

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
      throw requestTimedOut ? new PublicError("model_timeout") : toPublicError(error, "candidate_request_failed");
    }
  };
}
