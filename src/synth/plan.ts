import { resolve } from "node:path";
import { throwIfAborted } from "../shared/cancellation.js";
import { questionPrompt, readQuestionGeneratorPrompt } from "./prompts.js";
import { DEFAULT_CORPUS_DIR, DEFAULT_MAIN_DB } from "../shared/paths.js";
import { readPiConfig, sanitizePiConfig, type PiConfig, type SanitizedPiConfig } from "../shared/pi-runner.js";
import { DEFAULT_CALL_MAX_ATTEMPTS, DEFAULT_CALL_RETRY_DELAY_MS, validateCallMaxAttempts, validateCallRetryDelayMs } from "../shared/retry.js";
import { validateConcurrency, validateMaxAttempts, validateMaxTurns, validateSplit } from "../shared/schema.js";
import type { DatasetSplit, RoleRunner, SearchAnswerRunner, SkillSnapshot, SynthProfile } from "../shared/types.js";
import type { VideoSortMode } from "./corpus.js";
import { getSynthProfile } from "./profiles.js";
import { readQuestionSkill, resolveSynthBundle, type ResolvedSynthBundle, type SynthSkillOverrides } from "./skills.js";

export const DEFAULT_SYNTH_MAX_ATTEMPTS = 4;
export const SYNTH_TEST_SPLIT_FORBIDDEN_MESSAGE = "test 分区仅供 eval 流水线使用，请使用 npm run dm -- eval make";

export function assertSynthSplit(split: DatasetSplit): DatasetSplit {
  if (split === "test") throw new Error(SYNTH_TEST_SPLIT_FORBIDDEN_MESSAGE);
  return split;
}

type Immutable<T> = T extends readonly (infer U)[] ? readonly Immutable<U>[]
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

export interface SynthPlanOptions {
  mode: "batch" | "judge";
  signal?: AbortSignal;
  dbPath?: string;
  inputDir?: string;
  split?: DatasetSplit;
  profile?: SynthProfile;
  limit?: number;
  sort?: VideoSortMode;
  shuffle?: boolean;
  maxQuestionsPerVideo?: number;
  maxTurns?: number;
  maxAttempts?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  noSkill?: boolean;
  promptsDir?: string;
  skillOverrides?: SynthSkillOverrides;
  enableSearch?: boolean;
  config?: PiConfig;
  runRole?: RoleRunner;
  runSearchAnswer?: SearchAnswerRunner;
}

export interface ResolvedSynthPlan {
  readonly mode: "batch" | "judge";
  readonly dbPath: string;
  readonly inputDir: string;
  readonly profile: SynthProfile;
  /** undefined on judge means that question selection spans every partition. */
  readonly split: DatasetSplit | undefined;
  readonly effectiveSplit: DatasetSplit;
  readonly sort: VideoSortMode;
  readonly shuffle: boolean;
  readonly limit: number;
  readonly maxQuestionsPerVideo: number | undefined;
  readonly maxTurns: number;
  readonly maxAttempts: number;
  readonly concurrency: number;
  readonly callMaxAttempts: number;
  readonly callRetryDelayMs: number;
  readonly noSkill: boolean;
  readonly config: Immutable<PiConfig>;
  readonly sanitizedModel: Immutable<SanitizedPiConfig>;
  readonly bundle: Immutable<ResolvedSynthBundle>;
  readonly tools: Readonly<{ enableSearch: boolean; useToolRunner: boolean }>;
  readonly trainingEnabled: boolean;
  readonly evalEnabled: boolean;
  readonly exportPolicy: Readonly<Record<string, unknown>>;
}

/** Resolve all execution defaults before opening the write store or constructing runners. */
export async function resolveSynthPlan(options: SynthPlanOptions): Promise<ResolvedSynthPlan> {
  throwIfAborted(options.signal);
  const profile = options.profile ?? "standard";
  const descriptor = getSynthProfile(profile);
  const split = options.mode === "judge" && options.split === undefined
    ? undefined
    : assertSynthSplit(validateSplit(options.split ?? "train", "--split"));
  const effectiveSplit = split ?? "train";
  const sort = options.sort ?? "id";
  if (sort === "core-first" && options.shuffle) throw new Error("--sort core-first 不能与 --shuffle 同时指定");
  const maxTurns = validateMaxTurns(options.maxTurns ?? descriptor.maxTurns);
  const maxAttempts = validateMaxAttempts(options.maxAttempts ?? DEFAULT_SYNTH_MAX_ATTEMPTS);
  const concurrency = validateConcurrency(options.concurrency ?? 10);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const bundle = await resolveSynthBundle({
    profile, noSkill: options.noSkill, maxTurns, includeQuestionGenerator: options.mode === "batch",
    promptsDir: options.promptsDir, overrides: options.skillOverrides,
  });
  throwIfAborted(options.signal);
  // Copy caller-owned configuration: mutation after resolution cannot change the run.
  const config = structuredClone(options.config ?? readPiConfig());
  const hasCustomPromptOverrides = Boolean(options.noSkill || (options.mode === "judge" && (
    options.promptsDir || options.skillOverrides?.answerStyle || options.skillOverrides?.qualityJudge
  )));
  const defaultSearch = descriptor.tools.defaultSearch && !hasCustomPromptOverrides && !options.runRole;
  const requestedSearch = options.enableSearch ?? defaultSearch;
  const trainingEnabled = effectiveSplit === "train" && bundle.rubricReady;
  const evalEnabled = effectiveSplit !== "train" && bundle.rubricReady;
  const exportPolicy = effectiveSplit === "train"
    ? { format: "messages_jsonl", ...(options.mode === "batch" ? { split: "train" } : {}), training_enabled: trainingEnabled }
    : { format: "messages_jsonl", split: effectiveSplit, purpose: effectiveSplit, training_enabled: false, eval_enabled: evalEnabled };
  return freeze({
    mode: options.mode,
    dbPath: resolve(options.dbPath ?? DEFAULT_MAIN_DB), inputDir: resolve(options.inputDir ?? DEFAULT_CORPUS_DIR),
    profile: descriptor.exportTag, split, effectiveSplit, sort, shuffle: Boolean(options.shuffle), limit: options.limit ?? 10,
    maxQuestionsPerVideo: options.maxQuestionsPerVideo ?? descriptor.maxQuestionsPerVideo,
    maxTurns, maxAttempts, concurrency, callMaxAttempts, callRetryDelayMs, noSkill: Boolean(options.noSkill),
    config, sanitizedModel: sanitizePiConfig(config), bundle,
    tools: { enableSearch: requestedSearch || descriptor.tools.alwaysSearch, useToolRunner: Boolean(options.runSearchAnswer || descriptor.tools.required || requestedSearch) },
    trainingEnabled, evalEnabled, exportPolicy,
  });
}


export async function resolveSynthQuestionPlan(options: {
  dbPath?: string;
  split?: DatasetSplit;
  profile?: SynthProfile;
  input?: string;
  inputDir?: string;
  sort?: VideoSortMode;
  shuffle?: boolean;
  concurrency?: number;
  questionSkillPath?: string;
  noSkill?: boolean;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  config?: PiConfig;
  signal?: AbortSignal;
}) {
  throwIfAborted(options.signal);
  if (options.input !== undefined && options.inputDir !== undefined) throw new Error("--input 与 --input-dir 不能同时指定");
  const sort = options.sort ?? "id";
  if (sort === "core-first" && options.shuffle) throw new Error("--sort core-first 不能与 --shuffle 同时指定");
  const profile = options.profile ?? "standard";
  const descriptor = getSynthProfile(profile);
  const split = assertSynthSplit(validateSplit(options.split ?? "train", "--split"));
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const inputDir = options.input === undefined ? resolve(options.inputDir ?? DEFAULT_CORPUS_DIR) : undefined;
  const concurrency = validateConcurrency(options.concurrency ?? 10);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const basePrompt = await readQuestionGeneratorPrompt();
  throwIfAborted(options.signal);
  let systemPrompt = basePrompt;
  const skills: SkillSnapshot[] = [];
  if (!options.noSkill) {
    const skillPath = resolve(options.questionSkillPath ?? descriptor.skills.questionSkill);
    const skill = await readQuestionSkill(skillPath);
    throwIfAborted(options.signal);
    systemPrompt = questionPrompt(basePrompt, skill.body);
    skills.push({ name: "question-design", path: skillPath, status: skill.status, body: skill.body, sha256: skill.sha256 });
  }
  const config = structuredClone(options.config ?? readPiConfig());
  return freeze({ dbPath, inputDir, split, profile, sort, shuffle: Boolean(options.shuffle), concurrency, callMaxAttempts, callRetryDelayMs, config, systemPrompt, skills });
}
