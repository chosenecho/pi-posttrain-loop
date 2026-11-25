import http from "node:http";
import https from "node:https";
import { nonEmpty } from "../schema.js";

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

function normalizeBaseUrl(raw: string | undefined, label: string): string {
  const trimmed = nonEmpty(raw, label).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} 必须是有效的 HTTP(S) API 根地址`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} 必须使用 HTTP(S) API 根地址，认证信息请通过 API Key 传入`);
  }
  if (/\/chat\/completions$/.test(url.pathname)) {
    throw new Error(`${label} 请填 API 根地址（如 http://127.0.0.1:8000/v1），不要附带 /chat/completions`);
  }
  return trimmed;
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
  const baseUrl = normalizeBaseUrl(
    overrides.baseUrl ?? env.CANDIDATE_LLM_BASE_URL ?? env.LLM_BASE_URL,
    "候选模型 API 地址（--base-url / CANDIDATE_LLM_BASE_URL / LLM_BASE_URL）",
  );
  const modelId = nonEmpty(
    overrides.modelId ?? env.CANDIDATE_LLM_MODEL ?? env.LLM_MODEL,
    "候选模型名称（--model / CANDIDATE_LLM_MODEL / LLM_MODEL）",
  );
  // Local vLLM / Ollama endpoints often accept any non-empty placeholder key like "EMPTY"
  const rawKey = overrides.apiKey ?? env.CANDIDATE_LLM_API_KEY ?? env.LLM_API_KEY ?? "";
  const apiKey = rawKey.trim() || "EMPTY";

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
  statusText: string;
  contentType: string;
  bodyText: string;
}

function formatErrorWithCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause) return error.message;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    const detail = code ? `${code}: ${cause.message}` : cause.message;
    return `${error.message} (${detail})`;
  }
  return `${error.message} (${String(cause)})`;
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
            statusText: res.statusMessage ?? "",
            contentType,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    const timer = setTimeout(() => {
      const err = new Error(`请求超时（${timeoutMs}ms）`);
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

  function redact(message: string): string {
    if (!config.apiKey || config.apiKey === "EMPTY") return message;
    return message.replaceAll(config.apiKey, "[REDACTED]");
  }

  return async ({ messages, temperature, maxTokens }) => {
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
        const timer = setTimeout(() => controller.abort(new Error(`请求超时（${config.timeoutMs}ms）`)), config.timeoutMs);
        try {
          const response = await config.fetchFn(endpoint, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });
          rawResponse = {
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get("content-type") ?? "",
            bodyText: await response.text(),
          };
        } finally {
          clearTimeout(timer);
        }
      } else {
        rawResponse = await postJsonViaNodeHttp(endpoint, headers, body, config.timeoutMs);
      }

      const { status, statusText, contentType, bodyText } = rawResponse;

      if (status < 200 || status >= 300) {
        const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 240);
        throw new Error(`HTTP ${status} ${statusText}: ${snippet || "(empty body)"}`);
      }

      if (contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html/i.test(bodyText)) {
        throw new Error(`上游返回 HTML 网页而非 API JSON（content-type=${contentType || "unknown"}）`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new Error(`候选模型接口返回非合法 JSON：${bodyText.slice(0, 200)}`);
      }

      const payload = parsed as {
        error?: { message?: string } | string;
        choices?: Array<{
          finish_reason?: string | null;
          message?: { content?: unknown };
        }>;
      };
      if (payload.error) {
        const msg = typeof payload.error === "string"
          ? payload.error
          : payload.error.message ?? JSON.stringify(payload.error);
        throw new Error(`候选模型接口报错：${msg}`);
      }

      const choice = payload.choices?.[0];
      if (!choice) {
        throw new Error("候选模型接口响应缺少 choices[0]");
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
        throw new Error(`候选模型返回空正文（finish_reason=${String(choice.finish_reason ?? "unknown")}）`);
      }
      return cleaned;
    } catch (error) {
      throw new Error(redact(formatErrorWithCause(error)));
    }
  };
}
