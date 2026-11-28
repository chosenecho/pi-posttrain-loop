import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import * as completions from "@earendil-works/pi-ai/api/openai-completions";
import type {
  DialogueRole,
  RoleRequest,
  RoleRunner,
  SearchAnswerResult,
  SearchAnswerRunner,
  ToolStep,
  ToolAttempt,
} from "./types.js";
import { combineSignals, createAttemptCancellation, throwIfAborted } from "./cancellation.js";
import { nonEmpty } from "./schema.js";
import { PublicError, toPublicError } from "./public-error.js";
import { normalizeApiBaseUrl, resolveApiEndpoint } from "./api-config.js";
import { createWebSearchAgentTool, type CreateWebSearchToolOptions, type WebSearchRunner } from "./web-search.js";


export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
const ROLE_THINKING_ENV: ReadonlyArray<[DialogueRole, string]> = [
  ["question", "LLM_QUESTION_THINKING_LEVEL"],
  ["answer", "LLM_ANSWER_THINKING_LEVEL"],
  ["judge", "LLM_JUDGE_THINKING_LEVEL"],
  ["followup", "LLM_FOLLOWUP_THINKING_LEVEL"],
];

export interface PiConfig {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  maxTokens: number;
  contextWindow: number;
  timeoutMs: number;
  thinkingLevel?: ThinkingLevel;
  roleThinkingLevels?: Partial<Record<DialogueRole, ThinkingLevel>>;
}

export type SanitizedPiConfig = Omit<PiConfig, "apiKey">;

export function sanitizePiConfig(config: PiConfig): SanitizedPiConfig {
  const { apiKey: _apiKey, ...rest } = config;
  return rest;
}

function envInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
  }
  return value;
}

function parseThinkingLevel(raw: string, envName: string): ThinkingLevel {
  if (!THINKING_LEVELS.includes(raw as ThinkingLevel)) {
    throw new Error(`${envName} 必须是 off、low、medium、high 或 max`);
  }
  return raw as ThinkingLevel;
}

export function readPiConfig(env: NodeJS.ProcessEnv = process.env): PiConfig {
  const apiKey = nonEmpty(env.LLM_API_KEY, "环境变量 LLM_API_KEY");
  if (apiKey === "replace-with-your-key") throw new Error("请在 .env 中填写自己的 LLM_API_KEY");
  const modelId = nonEmpty(env.LLM_MODEL, "环境变量 LLM_MODEL");
  const baseUrl = normalizeApiBaseUrl(env.LLM_BASE_URL, "环境变量 LLM_BASE_URL");
  const contextWindow = envInteger(env, "LLM_CONTEXT_WINDOW", 1048576, 1024, 10_000_000);
  const maxTokens = envInteger(env, "LLM_MAX_TOKENS", 2048, 1, contextWindow - 1);
  const thinkingLevel = parseThinkingLevel(env.LLM_THINKING_LEVEL ?? "high", "LLM_THINKING_LEVEL");

  const roleThinkingLevels: Partial<Record<DialogueRole, ThinkingLevel>> = {};
  for (const [role, envName] of ROLE_THINKING_ENV) {
    const raw = env[envName]?.trim();
    if (raw) {
      roleThinkingLevels[role] = parseThinkingLevel(raw, envName);
    }
  }

  return {
    apiKey,
    modelId,
    baseUrl,
    maxTokens,
    contextWindow,
    thinkingLevel,
    ...(Object.keys(roleThinkingLevels).length > 0 ? { roleThinkingLevels } : {}),
    timeoutMs: envInteger(env, "LLM_TIMEOUT_MS", 90000, 1, 3_600_000),
  };
}

/** Evaluation roles may inherit credentials only for the same API root. */
export function readEvalPiConfig(env: NodeJS.ProcessEnv = process.env): PiConfig {
  const endpoint = resolveApiEndpoint({
    baseUrl: env.EVAL_LLM_BASE_URL?.trim() || env.LLM_BASE_URL,
    apiKey: env.EVAL_LLM_API_KEY,
    fallbacks: [{ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY }],
    baseUrlLabel: "EVAL_LLM_BASE_URL / LLM_BASE_URL",
    apiKeyLabel: "EVAL_LLM_API_KEY",
  });
  return readPiConfig({
    ...env,
    LLM_BASE_URL: endpoint.baseUrl,
    LLM_API_KEY: endpoint.apiKey,
    LLM_MODEL: env.EVAL_LLM_MODEL?.trim() || env.LLM_MODEL,
  });
}

/** Supports text models exposing the OpenAI Chat Completions streaming protocol. */
export function createPiRunner(config: PiConfig, tools: AgentTool[] = []): RoleRunner {
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    provider: "pi-posttrain-loop",
    api: "openai-completions",
    baseUrl: config.baseUrl,
    input: ["text"],
    reasoning: true,
    thinkingLevelMap: { max: "max" },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: "pi-posttrain-loop",
    baseUrl: config.baseUrl,
    auth: { apiKey: {
      name: "LLM_API_KEY",
      resolve: async () => ({ auth: { apiKey: config.apiKey }, source: "LLM_API_KEY" }),
    } },
    models: [model],
    api: completions,
  }));

  return async ({ role, systemPrompt, input, signal }) => {
    throwIfAborted(signal);
    let httpStatus: number | undefined;
    // A fresh Agent for each invocation prevents cross-role and cross-question history leaks.
    const timeout = createAttemptCancellation(signal, config.timeoutMs);
    const thinkingLevel = config.roleThinkingLevels?.[role as DialogueRole] ?? config.thinkingLevel ?? "high";
    const agent = new Agent({
      initialState: { systemPrompt, model, tools: tools.map((tool) => withCancellation(tool, timeout.signal)), thinkingLevel },
      // Execute the declared tools, then end; receipts are returned below without a second model call.
      finishTurn: () => ({ action: "end" }),
      streamFn: (selectedModel, context, options) => models.streamSimple(selectedModel, context, {
        ...options,
        signal: combineSignals(timeout.signal, options?.signal),
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        maxRetries: 0,
        // Capture numeric status before the SDK flattens provider errors into body-bearing text.
        fetch: async (request, init) => {
          // Redirects could forward model inputs or credentials beyond the configured API root.
          const response = await globalThis.fetch(request, { ...init, redirect: "manual" });
          httpStatus = response.status;
          return response;
        },
      }),
    });
    const abortAgent = () => agent.abort();
    timeout.signal.addEventListener("abort", abortAgent, { once: true });
    try {
      throwIfAborted(timeout.signal);
      await agent.prompt(JSON.stringify(input));
      throwIfAborted(timeout.signal);
      const last = agent.state.messages.findLast((message) => message.role === "assistant");
      if (!last || last.role !== "assistant") {
        throw new PublicError("model_missing_message", { httpStatus });
      }
      if (last.stopReason === "toolUse" && tools.length > 0) {
        const results = agent.state.messages.filter((message) => message.role === "toolResult");
        if (results.length === 0) throw new PublicError("model_tool_missing_receipt", { httpStatus });
        const receipt = results.flatMap((message) => message.content)
          .filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (results.some((message) => message.isError)) throw new PublicError("model_tool_failed", { httpStatus });
        return receipt;
      }
      if (last.stopReason !== "stop") {
        throw new PublicError(timeout.signal.aborted ? "model_timeout" : "model_incomplete", { httpStatus, stopReason: last.stopReason });
      }
      const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      if (!text.trim()) throw new PublicError("model_empty_output", { httpStatus });
      return text;
    } catch (error) {
      throwIfAborted(timeout.signal);
      if (error instanceof PublicError) throw error;
      throw new PublicError(timeout.signal.aborted ? "model_timeout" : "model_request_failed", {
        httpStatus: httpStatus ?? toPublicError(error).httpStatus,
      });
    } finally {
      timeout.signal.removeEventListener("abort", abortAgent);
      agent.abort();
      await agent.waitForIdle();
      timeout.dispose();
    }
  };
}

/** The awaited tool promise is the cleanup contract; no race can declare an ignoring tool idle. */
function withCancellation(tool: AgentTool, signal: AbortSignal): AgentTool {
  return {
    ...tool,
    async execute(id, input, sdkSignal, onUpdate) {
      const combined = combineSignals(signal, sdkSignal);
      throwIfAborted(combined);
      const result = await tool.execute(id, input, combined, (update) => {
        if (!combined?.aborted) onUpdate?.(update);
      });
      throwIfAborted(combined);
      return result;
    },
  };
}

export interface PiSearchRunnerOptions {
  /** Max web_search calls per answer attempt (default 3). */
  maxSearchCalls?: number;
  /** Result count per web_search call (default 5). */
  searchCount?: number;
  searchContextSize?: CreateWebSearchToolOptions["searchContextSize"];
  /** Enable the generic web_search tool (default true when a runner is provided). */
  enableSearch?: boolean;
  /** Remove or project caller-owned metadata before serializing model input. */
  transformInput?: (request: RoleRequest) => Record<string, unknown>;
  /** Per-request tool round allowance; defaults to maxSearchCalls + 2. */
  maxToolRounds?: number | ((request: RoleRequest) => number);
  /** Tools are created inside the attempt lifecycle and share its effective deadline. */
  extraToolsFactory?: (ctx: {
    request: RoleRequest;
    signal: AbortSignal;
    recordStep: (step: Omit<ToolStep, "stepNo">) => void;
    recordCallStep: (toolCallId: string, step: ToolStep) => void;
  }) => AgentTool[];
}

/**
 * Multi-step Pi runner for caller-supplied tools and optional generic web search:
 * mounts the configured Pi tools for each attempt, lets the model invoke tools and consume tool outputs,
 * and captures every tool step (with sequential `stepNo` and pre-call thinking) alongside the final text answer.
 */
export function createPiSearchRunner(
  config: PiConfig,
  webSearchRunner?: WebSearchRunner,
  options: PiSearchRunnerOptions = {},
): SearchAnswerRunner {
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    provider: "pi-posttrain-loop",
    api: "openai-completions",
    baseUrl: config.baseUrl,
    input: ["text"],
    reasoning: true,
    thinkingLevelMap: { max: "max" },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: "pi-posttrain-loop",
    baseUrl: config.baseUrl,
    auth: { apiKey: {
      name: "LLM_API_KEY",
      resolve: async () => ({ auth: { apiKey: config.apiKey }, source: "LLM_API_KEY" }),
    } },
    models: [model],
    api: completions,
  }));

  const maxSearchCalls = Math.max(1, Math.floor(options.maxSearchCalls ?? 3));

  return async (request): Promise<SearchAnswerResult> => {
    const { role, systemPrompt, input, signal } = request;
    throwIfAborted(signal);
    let httpStatus: number | undefined;
    const timeout = createAttemptCancellation(signal, config.timeoutMs);
    try {
      const thinkingLevel = config.roleThinkingLevels?.[role as DialogueRole] ?? config.thinkingLevel ?? "high";
      const capturedSteps: ToolStep[] = [];
      const attemptId = randomUUID();
      const toolAttempts: ToolAttempt[] = [];
      const projectedSteps = new Map<ToolAttempt, ToolStep>();
      let batchId = 0;
      let batchCalls = new Map<string, ToolAttempt>();
      const recordCallStep = (toolCallId: string, step: ToolStep) => {
        if (timeout.signal.aborted) return;
        const call = batchCalls.get(toolCallId);
        if (call) projectedSteps.set(call, step);
      };
      let toolRounds = 0;

      const recordStep = (step: Omit<ToolStep, "stepNo">): void => {
        if (timeout.signal.aborted) return;
        capturedSteps.push({
          ...step,
          stepNo: capturedSteps.length + 1,
        });
      };

      const cleanWireInput = options.transformInput?.(request) ?? input;

      const tools: AgentTool[] = [];
      const enableSearch = options.enableSearch ?? Boolean(webSearchRunner);
      if (enableSearch && webSearchRunner) {
        tools.push(
          createWebSearchAgentTool(webSearchRunner, {
            maxCalls: maxSearchCalls,
            count: options.searchCount,
            searchContextSize: options.searchContextSize,
            onCallStep: recordCallStep,
            signal: timeout.signal,
          }),
        );
      }

      if (options.extraToolsFactory) {
        tools.push(...options.extraToolsFactory({ request, signal: timeout.signal, recordStep, recordCallStep }));
      }
      const maxToolRounds = typeof options.maxToolRounds === "function"
        ? options.maxToolRounds(request) : options.maxToolRounds ?? (maxSearchCalls + 2);

      const agent = new Agent({
        initialState: { systemPrompt, model, tools: tools.map((tool) => withCancellation(tool, timeout.signal)), thinkingLevel },
        finishTurn: (turn) => {
          if (timeout.signal.aborted) return { action: "end" };
          if (turn.toolResults.length === 0) return { action: "end" };
          toolRounds++;
          if (toolRounds > maxToolRounds) {
            return { action: "end" };
          }
          return undefined;
        },
        streamFn: (selectedModel, context, streamOptions) => models.streamSimple(selectedModel, context, {
          ...streamOptions,
          signal: combineSignals(timeout.signal, streamOptions?.signal),
          maxTokens: config.maxTokens,
          timeoutMs: config.timeoutMs,
          maxRetries: 0,
          fetch: async (req, init) => {
            const response = await globalThis.fetch(req, { ...init, redirect: "manual" });
            httpStatus = response.status;
            return response;
          },
        }),
      });

      let auditFailed = false;
      let auditFailure: unknown;
      const reportAttempt = (attempt: ToolAttempt) => {
        if (!request.onToolAttempt || auditFailed) return;
        try {
          request.onToolAttempt(structuredClone(attempt));
        } catch (error) {
          // Keep the real store failure without letting an SDK listener exception skip draining.
          auditFailed = true;
          auditFailure = error;
          agent.abort();
        }
      };
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          const calls = event.message.content.filter((part) => part.type === "toolCall");
          if (calls.length === 0) return;
          batchId++;
          batchCalls = new Map();
          const thought = event.message.content
            .filter((part) => part.type === "thinking")
            .map((part) => part.thinking.trim()).filter(Boolean).join("\n");
          calls.forEach((call, sourceIndex) => {
            const attempt: ToolAttempt = {
              attemptId, batchId, toolCallId: call.id, sourceIndex,
              toolName: call.name, arguments: call.arguments,
              status: "attempted", ...(thought ? { preCallThought: thought } : {}),
            };
            toolAttempts.push(attempt);
            batchCalls.set(call.id, attempt);
            reportAttempt(attempt);
          });
        } else if (event.type === "tool_execution_end") {
          const call = batchCalls.get(event.toolCallId);
          if (!call) return;
          const skipped = event.result?.details?.skipped || event.result?.details?.error === "limit_reached";
          call.status = timeout.signal.aborted ? "cancelled" : skipped ? "limit_reached" : event.isError
            ? event.durationMs === undefined ? "invalid_arguments" : "failed" : "succeeded";
          call.durationMs = event.durationMs;
          if (call.status !== "succeeded") {
            call.errorCode = timeout.signal.aborted ? (timeout.signal.reason as PublicError).code : skipped ? "tool_limit_reached"
              : event.durationMs === undefined ? "tool_arguments_invalid" : "tool_execution_failed";
          }
          reportAttempt(call);
        }
      });
      const abortAgent = () => agent.abort();
      timeout.signal.addEventListener("abort", abortAgent, { once: true });
      try {
        throwIfAborted(timeout.signal);
        await agent.prompt(JSON.stringify(cleanWireInput));
        if (auditFailed) throw auditFailure;
        throwIfAborted(timeout.signal);
        const last = agent.state.messages.findLast((message) => message.role === "assistant");
        if (!last || last.role !== "assistant") {
          throw new PublicError("model_missing_message", { httpStatus });
        }
        if (last.stopReason !== "stop") {
          throw new PublicError(timeout.signal.aborted ? "model_timeout" : "model_incomplete", { httpStatus, stopReason: last.stopReason });
        }
        const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        if (!text.trim()) throw new PublicError("model_empty_output", { httpStatus });
        return {
          answer: text,
          toolSteps: [
            ...toolAttempts.flatMap((call) => {
              const step = projectedSteps.get(call);
              return call.status === "succeeded" && step
                ? [{ ...step, ...(call.preCallThought ? { preCallThought: call.preCallThought } : {}) }] : [];
            }),
            ...capturedSteps,
          ].map((step, index) => ({ ...step, stepNo: index + 1 })),
          toolAttempts,
        };
      } catch (error) {
        if (auditFailed) throw auditFailure;
        throwIfAborted(timeout.signal);
        if (error instanceof PublicError) throw error;
        throw new PublicError(timeout.signal.aborted ? "model_timeout" : "model_request_failed", {
          httpStatus: httpStatus ?? toPublicError(error).httpStatus,
        });
      } finally {
        timeout.signal.removeEventListener("abort", abortAgent);
        agent.abort();
        try {
          try { await agent.waitForIdle(); }
          catch { throw new PublicError("adapter_cleanup_failed"); }
        } finally {
          try {
            for (const call of toolAttempts) {
              if (call.status !== "attempted") continue;
              call.status = timeout.signal.aborted ? "cancelled" : "failed";
              call.errorCode = timeout.signal.aborted ? (timeout.signal.reason as PublicError).code : "tool_execution_failed";
              reportAttempt(call);
            }
          } finally { unsubscribe(); }
        }
      }
    } finally {
      timeout.dispose();
    }
  };
}
