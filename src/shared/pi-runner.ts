import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import * as completions from "@earendil-works/pi-ai/api/openai-completions";
import type {
  DialogueRole,
  QuestionMode,
  QuestionTaskSpec,
  RoleRequest,
  RoleRunner,
  SearchAnswerResult,
  SearchAnswerRunner,
  SynthProfile,
  ToolStep,
} from "./types.js";
import { nonEmpty } from "./schema.js";
import { PublicError, toPublicError } from "./public-error.js";
import { normalizeApiBaseUrl, resolveApiEndpoint } from "./api-config.js";
import { createWebSearchAgentTool, type CreateWebSearchToolOptions, type WebSearchRunner } from "./web-search.js";
import {
  createQuestionAgentTool,
  createQuestionnaireAgentTool,
  createTodoAgentTool,
} from "./pi-tools.js";

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

  return async ({ role, systemPrompt, input }) => {
    let httpStatus: number | undefined;
    // A fresh Agent for each invocation prevents cross-role and cross-question history leaks.
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const thinkingLevel = config.roleThinkingLevels?.[role as DialogueRole] ?? config.thinkingLevel ?? "high";
    const agent = new Agent({
      initialState: { systemPrompt, model, tools, thinkingLevel },
      // Execute the declared tools, then end; receipts are returned below without a second model call.
      finishTurn: () => ({ action: "end" }),
      streamFn: (selectedModel, context, options) => models.streamSimple(selectedModel, context, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
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
    try {
      await agent.prompt(JSON.stringify(input));
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
        throw new PublicError(timeout.aborted ? "model_timeout" : "model_incomplete", { httpStatus, stopReason: last.stopReason });
      }
      const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      if (!text.trim()) throw new PublicError("model_empty_output", { httpStatus });
      return text;
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError(timeout.aborted ? "model_timeout" : "model_request_failed", {
        httpStatus: httpStatus ?? toPublicError(error).httpStatus,
      });
    }
  };
}

export interface PiSearchRunnerOptions {
  /** Max web_search calls per answer attempt (default 3). */
  maxSearchCalls?: number;
  /** Result count per web_search call (default 5). */
  searchCount?: number;
  searchContextSize?: CreateWebSearchToolOptions["searchContextSize"];
  /** Target synth profile (auto-mounts `todo` on `todo` profile and `question`/`questionnaire` on `clarify` profile). */
  profile?: SynthProfile;
  /** Enable `web_search` tool on this runner (default true when webSearchRunner is provided). */
  enableSearch?: boolean;
  /** Max todo calls per answer attempt (default 12). */
  maxTodoCalls?: number;
  /** Max question/questionnaire calls per answer attempt (default 1). */
  maxClarifyCalls?: number;
  /** Optional LLM runner used by `question`/`questionnaire` user simulator. */
  simulatorRunner?: RoleRunner;
  /** Optional custom tool factory per request. */
  extraToolsFactory?: (ctx: {
    request: RoleRequest;
    recordStep: (step: Omit<ToolStep, "stepNo">) => void;
  }) => AgentTool[];
}

/**
 * Multi-step Pi runner for tool-enabled answers (`web_search`, `todo`, `question`, `questionnaire`):
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
  const maxTodoCalls = Math.max(1, Math.floor(options.maxTodoCalls ?? 12));
  const maxClarifyCalls = Math.max(1, Math.floor(options.maxClarifyCalls ?? 1));

  return async (request): Promise<SearchAnswerResult> => {
    const { role, systemPrompt, input } = request;
    let httpStatus: number | undefined;
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const thinkingLevel = config.roleThinkingLevels?.[role as DialogueRole] ?? config.thinkingLevel ?? "high";
    const capturedSteps: ToolStep[] = [];
    let toolRounds = 0;

    const recordStep = (step: Omit<ToolStep, "stepNo">): void => {
      capturedSteps.push({
        ...step,
        stepNo: capturedSteps.length + 1,
      });
    };

    // Strip internal simulator metadata (`_questionMode`, `_taskSpec`) before sending wire input to Answer Agent
    const {
      _questionMode: rawQuestionMode,
      _taskSpec: rawTaskSpec,
      ...cleanWireInput
    } = input;
    const questionMode = (typeof rawQuestionMode === "string" ? rawQuestionMode : undefined) as QuestionMode | undefined;
    const taskSpec = (rawTaskSpec && typeof rawTaskSpec === "object" ? rawTaskSpec : undefined) as QuestionTaskSpec | undefined;

    const tools: AgentTool[] = [];
    const enableSearch = options.enableSearch ?? Boolean(webSearchRunner);
    if (enableSearch && webSearchRunner) {
      tools.push(
        createWebSearchAgentTool(webSearchRunner, {
          maxCalls: maxSearchCalls,
          count: options.searchCount,
          searchContextSize: options.searchContextSize,
          onStep: (step) => recordStep(step),
        }),
      );
    }

    const mountTodo = options.profile === "todo" || questionMode === "todo_plan";
    if (mountTodo) {
      tools.push(
        createTodoAgentTool({
          maxCalls: maxTodoCalls,
          onStep: (step) => recordStep(step),
        }),
      );
    }

    const mountClarify = options.profile === "clarify" || questionMode === "clarify_question";
    if (mountClarify) {
      const simContext = {
        question: typeof cleanWireInput.question === "string" ? cleanWireInput.question : undefined,
        material: typeof cleanWireInput.material === "string" ? cleanWireInput.material : undefined,
        hiddenUserPersona: taskSpec?.hidden_user_persona,
        missingSlots: taskSpec?.missing_slots,
        runRole: options.simulatorRunner,
      };
      tools.push(
        createQuestionAgentTool({
          maxCalls: maxClarifyCalls,
          context: simContext,
          onStep: (step) => recordStep(step),
        }),
        createQuestionnaireAgentTool({
          maxCalls: maxClarifyCalls,
          context: simContext,
          onStep: (step) => recordStep(step),
        }),
      );
    }

    if (options.extraToolsFactory) {
      tools.push(...options.extraToolsFactory({ request, recordStep }));
    }

    const maxToolRounds = (mountTodo ? maxTodoCalls : 0) + (mountClarify ? maxClarifyCalls : 0) + maxSearchCalls + 2;

    const agent = new Agent({
      initialState: { systemPrompt, model, tools, thinkingLevel },
      finishTurn: (turn) => {
        if (turn.toolResults.length === 0) return { action: "end" };
        toolRounds++;
        // Extract any thinking emitted right before this tool-call batch
        const thinkingText = turn.message.content
          .filter((part): part is { type: "thinking"; thinking: string } => part.type === "thinking" && "thinking" in part)
          .map((part) => part.thinking.trim())
          .filter(Boolean)
          .join("\n");
        if (thinkingText) {
          const batchStart = Math.max(0, capturedSteps.length - turn.toolResults.length);
          for (let i = batchStart; i < capturedSteps.length; i++) {
            if (!capturedSteps[i]!.preCallThought) {
              capturedSteps[i]!.preCallThought = thinkingText;
            }
          }
        }
        if (toolRounds > maxToolRounds) {
          return { action: "end" };
        }
        return undefined;
      },
      streamFn: (selectedModel, context, streamOptions) => models.streamSimple(selectedModel, context, {
        ...streamOptions,
        signal: streamOptions?.signal ? AbortSignal.any([streamOptions.signal, timeout]) : timeout,
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

    try {
      await agent.prompt(JSON.stringify(cleanWireInput));
      const last = agent.state.messages.findLast((message) => message.role === "assistant");
      if (!last || last.role !== "assistant") {
        throw new PublicError("model_missing_message", { httpStatus });
      }
      if (last.stopReason !== "stop") {
        throw new PublicError(timeout.aborted ? "model_timeout" : "model_incomplete", { httpStatus, stopReason: last.stopReason });
      }
      const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      if (!text.trim()) throw new PublicError("model_empty_output", { httpStatus });
      return {
        answer: text,
        toolSteps: capturedSteps,
      };
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError(timeout.aborted ? "model_timeout" : "model_request_failed", {
        httpStatus: httpStatus ?? toPublicError(error).httpStatus,
      });
    }
  };
}
