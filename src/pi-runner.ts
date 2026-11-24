import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import * as completions from "@earendil-works/pi-ai/api/openai-completions";
import type { DialogueRole, RoleRunner } from "./types.js";
import { nonEmpty } from "./schema.js";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
const ROLE_THINKING_ENV: ReadonlyArray<[DialogueRole, string]> = [
  ["question", "LLM_QUESTION_THINKING_LEVEL"],
  ["answer", "LLM_ANSWER_THINKING_LEVEL"],
  ["judge", "LLM_JUDGE_THINKING_LEVEL"],
  ["followup", "LLM_FOLLOWUP_THINKING_LEVEL"],
  ["rubric", "LLM_RUBRIC_THINKING_LEVEL"],
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
  const baseUrl = nonEmpty(env.LLM_BASE_URL, "环境变量 LLM_BASE_URL").replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("LLM_BASE_URL 必须是有效的 HTTP(S) API 根地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("LLM_BASE_URL 使用 HTTP(S) API 根地址，认证信息放在 LLM_API_KEY 中");
  }
  if (/\/chat\/completions$/.test(url.pathname)) throw new Error("LLM_BASE_URL 填 API 根地址，而非 /chat/completions");
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

/** MVP supports text models exposing the OpenAI Chat Completions streaming protocol. */
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
    // Pricing is deliberately unspecified; this MVP does not report monetary costs.
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

  function redact(message: string): string {
    return config.apiKey ? message.replaceAll(config.apiKey, "[REDACTED]") : message;
  }

  return async ({ role, systemPrompt, input }) => {
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
      }),
    });
    try {
      await agent.prompt(JSON.stringify(input));
      const last = agent.state.messages.findLast((message) => message.role === "assistant");
      if (!last || last.role !== "assistant") {
        throw new Error(agent.state.errorMessage ?? "模型未返回 assistant 消息");
      }
      if (last.stopReason === "toolUse" && tools.length > 0) {
        const results = agent.state.messages.filter((message) => message.role === "toolResult");
        if (results.length === 0) throw new Error("工具调用未返回回执");
        const receipt = results.flatMap((message) => message.content)
          .filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (results.some((message) => message.isError)) throw new Error(receipt);
        return receipt;
      }
      if (last.stopReason !== "stop") {
        throw new Error(last.errorMessage ?? `模型响应未完整结束：${last.stopReason}`);
      }
      const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      if (!text.trim()) throw new Error("模型返回空正文");
      return text;
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
  };
}
