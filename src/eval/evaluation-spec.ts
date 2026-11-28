import { createHash } from "node:crypto";
import { normalizeApiBaseUrl } from "../shared/api-config.js";
import { nonEmpty } from "../shared/schema.js";
import { readCandidateIdentityConfig } from "./candidate-config.js";
import type { EvalHistoryMode, EvalRunRecord, SuiteItemRecord, SuiteVersionRecord } from "./store/types.js";

export const CANDIDATE_ADAPTER_CONTRACT_VERSION = "openai-chat/v1";

export interface ResolvedEvaluationSpec {
  readonly version: 2;
  readonly hash: string;
  readonly suiteId: number;
  readonly suiteSha256: string;
  readonly itemIds: readonly number[];
  readonly candidate: string;
  /** Normalized API root, including its path. */
  readonly endpoint: string;
  readonly modelId: string;
  readonly historyMode: EvalHistoryMode;
  readonly systemPrompt: string | null;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly stripThinkTags: boolean;
  readonly adapterContractVersion: string;
}

export interface EvaluationSpecOverrides {
  candidate: string;
  baseUrl?: string;
  modelId?: string;
  historyMode?: EvalHistoryMode;
  systemPrompt?: string | null;
  temperature?: number;
  maxTokens?: number;
  stripThinkTags?: boolean;
  limit?: number;
  itemIds?: readonly number[];
  adapterContractVersion?: string;
}

export class EvaluationSpecError extends Error {
  constructor(readonly code: "resume_config_conflict" | "legacy_spec_incomplete" | "evaluation_spec_invalid" | "candidate_identity_mismatch", detail: string) {
    super(`${detail} [${code}]`);
    this.name = "EvaluationSpecError";
  }
}

function specFields(spec: Omit<ResolvedEvaluationSpec, "hash">) {
  // Keep a fixed key order and exclude operational data, credentials and the hash itself.
  return {
    version: spec.version, suiteId: spec.suiteId, suiteSha256: spec.suiteSha256,
    itemIds: [...spec.itemIds], candidate: spec.candidate, endpoint: spec.endpoint,
    modelId: spec.modelId, historyMode: spec.historyMode, systemPrompt: spec.systemPrompt,
    temperature: spec.temperature, maxTokens: spec.maxTokens, stripThinkTags: spec.stripThinkTags,
    adapterContractVersion: spec.adapterContractVersion,
  };
}

function immutableSpec(fields: Omit<ResolvedEvaluationSpec, "hash">): ResolvedEvaluationSpec {
  const ordered = specFields(fields);
  return Object.freeze({
    ...ordered,
    itemIds: Object.freeze(ordered.itemIds),
    hash: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
  });
}

function selectedItemIds(items: readonly SuiteItemRecord[], options: Pick<EvaluationSpecOverrides, "limit" | "itemIds">): number[] {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit 必须是正整数");
  }
  let ids = items.map((item) => item.id);
  if (options.itemIds !== undefined) {
    const available = new Set(ids);
    ids = [...options.itemIds];
    if (ids.some((id) => !available.has(id)) || new Set(ids).size !== ids.length) {
      throw new EvaluationSpecError("evaluation_spec_invalid", "条目 ID 列表含有套卷外条目或重复条目");
    }
  }
  if (options.limit !== undefined) ids = ids.slice(0, options.limit);
  if (ids.length === 0) throw new EvaluationSpecError("evaluation_spec_invalid", "套卷没有任何选中条目");
  return ids;
}

/** Missing legacy snapshots stay missing; current defaults never reconstruct historical identity. */
export function readEvaluationSpec(run: Pick<EvalRunRecord, "config">): ResolvedEvaluationSpec | undefined {
  const raw = run.config.evaluationSpec;
  if (raw === undefined || raw === null) return undefined;
  const invalid = () => new EvaluationSpecError("evaluation_spec_invalid", "已保存的评测规格结构或 hash 校验失败");
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const spec = raw as Record<string, unknown>;
  const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (spec.version !== 2 || !positiveInteger(spec.suiteId) || !text(spec.suiteSha256)
    || !Array.isArray(spec.itemIds) || spec.itemIds.length === 0 || !spec.itemIds.every(positiveInteger)
    || new Set(spec.itemIds).size !== spec.itemIds.length || !text(spec.candidate) || !text(spec.endpoint)
    || !text(spec.modelId) || (spec.historyMode !== "gold" && spec.historyMode !== "self")
    || (spec.systemPrompt !== null && !text(spec.systemPrompt))
    || typeof spec.temperature !== "number" || !Number.isFinite(spec.temperature) || spec.temperature < 0 || spec.temperature > 2
    || !positiveInteger(spec.maxTokens) || spec.maxTokens > 131_072
    || typeof spec.stripThinkTags !== "boolean" || !text(spec.adapterContractVersion) || !text(spec.hash)) throw invalid();
  try {
    if (normalizeApiBaseUrl(spec.endpoint, "候选模型 API 地址") !== spec.endpoint) throw invalid();
  } catch {
    throw invalid();
  }
  const restored = immutableSpec(spec as unknown as ResolvedEvaluationSpec);
  if (restored.hash !== spec.hash) throw invalid();
  return restored;
}

export function resolveEvaluationSpec(options: {
  suite: SuiteVersionRecord;
  items: readonly SuiteItemRecord[];
  requested: EvaluationSpecOverrides;
  existingRun?: EvalRunRecord;
  environment?: NodeJS.ProcessEnv;
}): ResolvedEvaluationSpec {
  const { suite, items, requested } = options;
  if (options.existingRun) {
    const run = options.existingRun;
    const stored = readEvaluationSpec(run);
    if (!stored) throw new EvaluationSpecError("legacy_spec_incomplete", "旧运行缺少可验证的完整评测规格；请创建关联新运行");
    if (stored.suiteId !== run.suiteId || stored.candidate !== run.candidate || stored.modelId !== run.model
      || stored.historyMode !== run.historyMode || stored.systemPrompt !== run.systemPrompt) {
      throw new EvaluationSpecError("evaluation_spec_invalid", "运行记录与保存的评测规格身份不一致");
    }
    const conflict = (field: string): never => { throw new EvaluationSpecError("resume_config_conflict", `续跑的 ${field} 与原评测规格不一致`); };
    if (suite.id !== stored.suiteId) conflict("suiteId");
    if (suite.sha256 !== stored.suiteSha256) conflict("suiteSha256");
    if (nonEmpty(requested.candidate, "--candidate") !== stored.candidate) conflict("candidate");
    const available = new Set(items.map((item) => item.id));
    if (stored.itemIds.some((id) => !available.has(id))) conflict("itemIds");
    if (requested.limit !== undefined || requested.itemIds !== undefined) {
      if (JSON.stringify(selectedItemIds(items, requested)) !== JSON.stringify(stored.itemIds)) conflict("itemIds");
    }
    if (requested.baseUrl !== undefined && normalizeApiBaseUrl(requested.baseUrl, "候选模型 API 地址") !== stored.endpoint) conflict("endpoint");
    if (requested.modelId !== undefined && nonEmpty(requested.modelId, "--model") !== stored.modelId) conflict("modelId");
    if (requested.historyMode !== undefined && requested.historyMode !== stored.historyMode) conflict("historyMode");
    if (requested.systemPrompt !== undefined) {
      const prompt = requested.systemPrompt === null ? null : nonEmpty(requested.systemPrompt, "systemPrompt");
      if (prompt !== stored.systemPrompt) conflict("systemPrompt");
    }
    if (requested.temperature !== undefined && requested.temperature !== stored.temperature) conflict("temperature");
    if (requested.maxTokens !== undefined && requested.maxTokens !== stored.maxTokens) conflict("maxTokens");
    if (requested.stripThinkTags !== undefined && requested.stripThinkTags !== stored.stripThinkTags) conflict("stripThinkTags");
    if (requested.adapterContractVersion !== undefined && requested.adapterContractVersion !== stored.adapterContractVersion) conflict("adapterContractVersion");
    return stored;
  }
  const config = readCandidateIdentityConfig({
    baseUrl: requested.baseUrl, modelId: requested.modelId, temperature: requested.temperature,
    maxTokens: requested.maxTokens, stripThinkTags: requested.stripThinkTags,
  }, options.environment ?? process.env);
  const historyMode = requested.historyMode ?? "gold";
  if (historyMode !== "gold" && historyMode !== "self") throw new Error("historyMode 必须为 gold 或 self");
  return immutableSpec({
    version: 2, suiteId: suite.id, suiteSha256: suite.sha256,
    itemIds: selectedItemIds(items, requested), candidate: nonEmpty(requested.candidate, "--candidate"),
    endpoint: normalizeApiBaseUrl(config.baseUrl, "候选模型 API 地址"), modelId: config.modelId,
    historyMode, systemPrompt: requested.systemPrompt == null ? null : nonEmpty(requested.systemPrompt, "systemPrompt"),
    temperature: config.temperature, maxTokens: config.maxTokens, stripThinkTags: config.stripThinkTags !== false,
    adapterContractVersion: nonEmpty(requested.adapterContractVersion ?? CANDIDATE_ADAPTER_CONTRACT_VERSION, "adapterContractVersion"),
  });
}
