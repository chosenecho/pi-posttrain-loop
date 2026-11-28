import { normalizeApiBaseUrl } from "../shared/api-config.js";
import { nonEmpty } from "../shared/schema.js";

export interface CandidateIdentityConfig {
  baseUrl: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  stripThinkTags?: boolean;
}

/** Semantic defaults are resolved only for a new run, independently from runtime credentials. */
export function readCandidateIdentityConfig(
  overrides: Partial<CandidateIdentityConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): CandidateIdentityConfig {
  const baseUrl = normalizeApiBaseUrl(overrides.baseUrl ?? env.CANDIDATE_LLM_BASE_URL ?? env.LLM_BASE_URL, "候选模型 API 地址");
  const modelId = nonEmpty(overrides.modelId ?? env.CANDIDATE_LLM_MODEL ?? env.LLM_MODEL, "候选模型名称");
  const temperature = overrides.temperature ?? 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("--temperature 必须在 [0, 2] 范围内");
  const maxTokens = overrides.maxTokens ?? Number(env.CANDIDATE_LLM_MAX_TOKENS ?? env.LLM_MAX_TOKENS ?? 2048);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131_072) throw new Error("--max-tokens 必须是 1–131072 的整数");
  return { baseUrl, modelId, temperature, maxTokens, stripThinkTags: overrides.stripThinkTags ?? true };
}
