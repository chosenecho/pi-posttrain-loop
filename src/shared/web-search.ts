import { execFile } from "node:child_process";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { nonEmpty } from "./schema.js";
import type { ToolStep } from "./types.js";
import { combineSignals, createAttemptCancellation, throwIfAborted } from "./cancellation.js";
import { createCallBudget, type CallBudget } from "./call-budget.js";

import { PublicError } from "./public-error.js";

export type SearchContextSize = "low" | "medium" | "high";

export interface WebSearchRequest {
  query: string;
  count?: number;
  searchContextSize?: SearchContextSize;
  signal?: AbortSignal;
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
  /** Arguments before the Magpie command, for executable wrappers (e.g. node path/to/gateway.js). */
  argsPrefix?: readonly string[];
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

function createSemaphore(limit: number): (signal?: AbortSignal) => Promise<() => void> {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<{ grant: () => void }> = [];
  const release = () => {
    const next = queue.shift();
    if (next) next.grant(); // Transfer the live permit directly: no re-acquisition window.
    else active--;
  };
  const permit = () => {
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  };
  return async (signal) => {
    throwIfAborted(signal);
    if (active < max) { active++; return permit(); }
    return new Promise<() => void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const entry = { grant: () => { cleanup(); resolve(permit()); } };
      const onAbort = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        cleanup();
        try { throwIfAborted(signal); } catch (error) { reject(error); }
      };
      queue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}

/** execFile reports abort before close on some platforms; a permit stays held until both settle. */
function runMagpieProcess(binPath: string, args: string[], signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let closed = false;
    let callbackDone = false;
    let failure: Error | null = null;
    let output = "";
    const settle = () => {
      if (!closed || !callbackDone) return;
      if (failure) reject(failure);
      else resolve(output);
    };
    const child = execFile(binPath, args, {
      signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8",
    }, (error, stdout) => {
      failure = error;
      output = stdout;
      callbackDone = true;
      settle();
    });
    child.once("close", () => { closed = true; settle(); });
  });
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
 * Includes a cancellable permit queue and a completed-success cache; in-flight calls remain independent.
 */
export function createMagpieWebSearchRunner(options: MagpieWebSearchOptions = {}): WebSearchRunner {
  const binPath = options.binPath?.trim() || process.env.MAGPIE_BIN?.trim() || "magpie";
  const defaultCount = options.defaultCount ?? 5;
  const defaultContextSize: SearchContextSize = options.defaultContextSize ?? "low";
  const maxOutputChars = options.maxOutputChars ?? 4000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const enableCache = options.enableCache ?? true;
  const acquire = createSemaphore(options.maxConcurrency ?? 8);
  const cache = new Map<string, WebSearchResponse>();

  return async (request: WebSearchRequest): Promise<WebSearchResponse> => {
    throwIfAborted(request.signal);
    const query = nonEmpty(request.query, "web_search query");
    const count = Math.min(20, Math.max(1, Math.floor(request.count ?? defaultCount)));
    const searchContextSize = request.searchContextSize ?? defaultContextSize;
    const cacheKey = normalizeSearchCacheKey(query, count, searchContextSize);
    const cancellation = createAttemptCancellation(request.signal, timeoutMs);
    let release: (() => void) | undefined;
    try {
      throwIfAborted(cancellation.signal);
      const existing = enableCache ? cache.get(cacheKey) : undefined;
      if (existing) return { ...existing, query };
      release = await acquire(cancellation.signal);
      throwIfAborted(cancellation.signal);
      const args = [
        ...(options.argsPrefix ?? []),
        "tool", "web_search", "--query", query,
        "--count", String(count), "--search_context_size", searchContextSize, "--json",
      ];
      const stdout = await runMagpieProcess(binPath, args, cancellation.signal);
      throwIfAborted(cancellation.signal);
      const response = parseMagpieWebSearchOutput(stdout, query, maxOutputChars);
      if (enableCache && !response.isError) cache.set(cacheKey, response);
      return response;
    } catch (error) {
      throwIfAborted(cancellation.signal);
      if (error instanceof PublicError) throw error;
      throw new PublicError("tool_execution_failed");
    } finally {
      // runMagpieProcess settles only after close, including aborted child processes.
      release?.();
      cancellation.dispose();
    }
  };
}

export interface CreateWebSearchToolOptions {
  /** Max search calls allowed within a single answer generation turn (default 3). */
  maxCalls?: number;
  /** Result count per search call (default 5). */
  count?: number;
  searchContextSize?: SearchContextSize;
  onStep?: (step: ToolStep) => void;
  /** Internal identity-aware success projection; onStep retains its existing shape. */
  onCallStep?: (toolCallId: string, step: ToolStep) => void;
  budget?: CallBudget;
  signal?: AbortSignal;
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
  const budget = options.budget ?? createCallBudget(maxCalls);

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
    async execute(toolCallId, input, sdkSignal) {
      const signal = combineSignals(options.signal, sdkSignal);
      throwIfAborted(signal);
      if (!input || typeof input !== "object" || !("query" in input)) {
        throw new Error("web_search 必须提供 query 字符串参数");
      }
      const query = nonEmpty((input as { query: unknown }).query, "web_search query");
      const claim = budget.claim(toolCallId);
      if (!claim) {
        const text = `本轮搜索次数已达上限（${maxCalls} 次），请基于已有检索结果直接作答或如实说明未查到。`;
        return {
          content: [{ type: "text", text }],
          isError: true,
          details: { query, skipped: true },
        };
      }
      const response = await runner({
        query,
        count: options.count,
        searchContextSize: options.searchContextSize,
        signal,
      });
      throwIfAborted(signal);
      const step: ToolStep = {
        stepNo: claim.sequence,
        toolName: "web_search",
        arguments: { query },
        toolOutput: response.text,
      };
      if (!response.isError) {
        options.onStep?.(step);
        options.onCallStep?.(toolCallId, step);
      }
      return {
        isError: response.isError,
        content: [{ type: "text", text: response.text }],
        details: response,
      };
    },
  };
}
