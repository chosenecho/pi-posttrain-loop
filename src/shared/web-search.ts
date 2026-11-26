import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { nonEmpty } from "./schema.js";
import type { ToolStep } from "./types.js";

const execFileAsync = promisify(execFile);

export type SearchContextSize = "low" | "medium" | "high";

export interface WebSearchRequest {
  query: string;
  count?: number;
  searchContextSize?: SearchContextSize;
}

export interface WebSearchResponse {
  query: string;
  text: string;
  isError: boolean;
}

export type WebSearchRunner = (request: WebSearchRequest) => Promise<WebSearchResponse>;

export interface MagpieWebSearchOptions {
  /** Override magpie executable path (defaults to MAGPIE_BIN env or "magpie"). */
  binPath?: string;
  /** Default result count passed to `magpie tool web_search --count` (1–20, default 5). */
  defaultCount?: number;
  /** Default context size passed to `magpie tool web_search --search_context_size` (default "low"). */
  defaultContextSize?: SearchContextSize;
  /** Max characters preserved in the returned tool text snippet (default 4000). */
  maxOutputChars?: number;
  /** Timeout per search CLI invocation in ms (default 30000). */
  timeoutMs?: number;
  /** Max concurrent magpie search subprocesses (default 8). */
  maxConcurrency?: number;
  /** Enable in-memory deduplication cache across identical queries (default true). */
  enableCache?: boolean;
}

interface MagpieToolJsonOutput {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

function createSemaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < max) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    active++;
  };

  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export function truncateSearchText(text: string, maxChars = 4000): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 12)).trimEnd()}\n...(已截断)`;
}

export function parseMagpieWebSearchOutput(rawStdout: string, query: string, maxChars = 4000): WebSearchResponse {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    return { query, text: "未检索到相关公开资料。", isError: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as MagpieToolJsonOutput;
    const parts = Array.isArray(parsed.content)
      ? parsed.content
          .filter((item) => typeof item?.text === "string" && item.text.trim().length > 0)
          .map((item) => item.text!.trim())
      : [];
    const text = parts.length > 0
      ? truncateSearchText(parts.join("\n\n"), maxChars)
      : "未检索到相关公开资料。";
    return {
      query,
      text,
      isError: Boolean(parsed.isError),
    };
  } catch {
    return {
      query,
      text: truncateSearchText(trimmed, maxChars),
      isError: false,
    };
  }
}

export function normalizeSearchCacheKey(
  query: string,
  count: number,
  searchContextSize: SearchContextSize,
): string {
  const normalizedQuery = query.trim().replace(/\s+/g, " ").toLowerCase();
  return `${count}:${searchContextSize}:${normalizedQuery}`;
}

/**
 * Calls the local Magpie MCP gateway's `web_search` tool via `magpie tool web_search --json`.
 * Includes bounded concurrency and in-memory query deduplication so retries don't double-fetch.
 */
export function createMagpieWebSearchRunner(options: MagpieWebSearchOptions = {}): WebSearchRunner {
  const binPath = options.binPath?.trim() || process.env.MAGPIE_BIN?.trim() || "magpie";
  const defaultCount = options.defaultCount ?? 5;
  const defaultContextSize: SearchContextSize = options.defaultContextSize ?? "low";
  const maxOutputChars = options.maxOutputChars ?? 4000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const enableCache = options.enableCache ?? true;
  const withLimit = createSemaphore(options.maxConcurrency ?? 8);
  const cache = new Map<string, Promise<WebSearchResponse>>();

  return async (request: WebSearchRequest): Promise<WebSearchResponse> => {
    const query = nonEmpty(request.query, "web_search query");
    const count = Math.min(20, Math.max(1, Math.floor(request.count ?? defaultCount)));
    const searchContextSize = request.searchContextSize ?? defaultContextSize;
    const cacheKey = normalizeSearchCacheKey(query, count, searchContextSize);

    if (enableCache) {
      const existing = cache.get(cacheKey);
      if (existing) return existing;
    }

    const promise = withLimit(async (): Promise<WebSearchResponse> => {
      const args = [
        "tool",
        "web_search",
        "--query",
        query,
        "--count",
        String(count),
        "--search_context_size",
        searchContextSize,
        "--json",
      ];
      try {
        const { stdout } = await execFileAsync(binPath, args, {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        });
        return parseMagpieWebSearchOutput(stdout, query, maxOutputChars);
      } catch (error) {
        if (enableCache) cache.delete(cacheKey);
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`本地 magpie web_search 调用失败（query="${query}"）：${msg}`);
      }
    });

    if (enableCache) cache.set(cacheKey, promise);
    return promise;
  };
}

export interface CreateWebSearchToolOptions {
  /** Max search calls allowed within a single answer generation turn (default 3). */
  maxCalls?: number;
  /** Result count per search call (default 5). */
  count?: number;
  searchContextSize?: SearchContextSize;
  onStep?: (step: ToolStep) => void;
}

/**
 * Builds a generic `web_search` AgentTool backed by `WebSearchRunner` for pi-agent-core.
 * The canonical tool name is always `web_search` with parameter `query`; export-time
 * generalization can map it onto generic tool aliases consistently.
 */
export function createWebSearchAgentTool(
  runner: WebSearchRunner,
  options: CreateWebSearchToolOptions = {},
): AgentTool {
  const maxCalls = Math.max(1, Math.floor(options.maxCalls ?? 3));
  let stepCount = 0;

  return {
    name: "web_search",
    label: "联网搜索",
    description: "搜索公开网络资料、统计数据、法规条款、文献出处或现实事件细节。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "简洁准确的搜索关键词",
          minLength: 1,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_toolCallId, input) {
      if (!input || typeof input !== "object" || !("query" in input)) {
        throw new Error("web_search 必须提供 query 字符串参数");
      }
      const query = nonEmpty((input as { query: unknown }).query, "web_search query");
      if (stepCount >= maxCalls) {
        const text = `本轮搜索次数已达上限（${maxCalls} 次），请基于已有检索结果直接作答或如实说明未查到。`;
        return {
          content: [{ type: "text", text }],
          details: { query, skipped: true },
        };
      }
      const response = await runner({
        query,
        count: options.count,
        searchContextSize: options.searchContextSize,
      });
      stepCount++;
      options.onStep?.({
        stepNo: stepCount,
        toolName: "web_search",
        arguments: { query },
        toolOutput: response.text,
      });
      return {
        content: [{ type: "text", text: response.text }],
        details: response,
      };
    },
  };
}
