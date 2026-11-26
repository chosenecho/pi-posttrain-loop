import { resolve } from "node:path";
import { writeOutputFile } from "../shared/cli-helpers.js";
import { DEFAULT_MAIN_DB } from "../shared/paths.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../shared/retry.js";
import { nonEmpty, validateConcurrency, validateMaxTurns, validateSplit } from "../shared/schema.js";
import type { DatasetSplit, DedupPolicy } from "../shared/types.js";
import {
  DEFAULT_REASONING_CHECK_CONFIG,
  parseProfileFilter,
  type ProfileFilter,
  type ReasoningCheckConfig,
  type ThinkTier,
} from "./checks.js";
import {
  createReasoningRunners,
  DEFAULT_REASONING_JUDGE_SKILL,
  DEFAULT_REASONING_PROMPTS_DIR,
  DEFAULT_REASONING_WRITER_SKILL,
  readReasoningJudgeSkill,
  readReasoningPiConfigs,
  readReasoningPrompts,
  readReasoningWriterSkill,
  runReasoningBackfill,
  selectStratifiedTurns,
} from "./engine.js";
import {
  buildExportManifest,
  buildReasoningExportDataset,
  formatReasoningJsonl,
  formatReviewMarkdown,
  type ReasoningExportFormat,
} from "./export.js";
import { ReasoningStore, type CandidateTurnQueryOptions, type ReasoningStatusSummary } from "./store.js";

export interface ReasoningQueryFilterOptions {
  runIds?: number[];
  excludeRunIds?: number[];
  split?: DatasetSplit;
  profile?: ProfileFilter;
  tiers?: ThinkTier[];
  dedup?: DedupPolicy;
  minTurns?: number;
  maxTurns?: number;
}

function buildQueryOptions(filter: ReasoningQueryFilterOptions): CandidateTurnQueryOptions {
  const dedup: DedupPolicy = filter.dedup ?? "latest";
  if (dedup !== "latest" && dedup !== "earliest" && dedup !== "error") {
    throw new Error("--dedup 必须为 latest、earliest 或 error");
  }
  const split = filter.split !== undefined ? validateSplit(filter.split, "--split") : undefined;
  const profile = filter.profile !== undefined ? parseProfileFilter(filter.profile, "--profile") : "all";
  const minTurns = filter.minTurns !== undefined ? validateMaxTurns(filter.minTurns) : undefined;
  const maxTurns = filter.maxTurns !== undefined ? validateMaxTurns(filter.maxTurns) : undefined;
  return {
    allFormal: filter.runIds === undefined,
    runIds: filter.runIds,
    excludeRunIds: filter.excludeRunIds,
    split,
    profile,
    tiers: filter.tiers,
    dedup,
    minTurns,
    maxTurns,
  };
}

export async function writeReasoningReviewFile(
  store: ReasoningStore,
  reviewMdPath: string,
  reasoningRunId?: number,
): Promise<{ reviewMd: string; reviewRunId: number; reviewTraceCount: number }> {
  const targetRunId = reasoningRunId ?? store.getLatestReasoningRunId();
  if (targetRunId === undefined) {
    throw new Error("库中尚无 reasoning_runs 记录，无法生成审阅稿");
  }
  const run = store.getReasoningRun(targetRunId);
  if (!run) {
    throw new Error(`未找到 reasoning_run_id=${targetRunId}`);
  }
  const traces = store.queryRunTracesWithContext(targetRunId);
  const reviewMd = formatReviewMarkdown(run, traces);
  const resolvedPath = await writeOutputFile(nonEmpty(reviewMdPath, "--review-md"), reviewMd);
  return { reviewMd: resolvedPath, reviewRunId: targetRunId, reviewTraceCount: traces.length };
}

export async function writeReasoningExportFiles(
  store: ReasoningStore,
  input: {
    dbPath: string;
    queryOptions: CandidateTurnQueryOptions;
    reasoningRunId?: number;
    outPath: string;
    valOutPath?: string;
    valRatio?: number;
    manifestPath?: string;
    format?: ReasoningExportFormat;
    expandTurns?: boolean;
    systemPrompt?: string;
    shuffle?: boolean;
    seed?: number;
  },
): Promise<Record<string, unknown>> {
  const format: ReasoningExportFormat = input.format ?? "inline";
  if (format !== "reasoning_content" && format !== "inline") {
    throw new Error("--format 必须为 reasoning_content 或 inline");
  }
  if ((input.valOutPath !== undefined) !== (input.valRatio !== undefined)) {
    throw new Error("--val-out 与 --val-ratio 必须成对指定");
  }

  const exportResult = buildReasoningExportDataset(store, {
    ...input.queryOptions,
    reasoningRunId: input.reasoningRunId,
    expandTurns: input.expandTurns ?? true,
    format,
    systemPrompt: input.systemPrompt,
    shuffle: Boolean(input.shuffle),
    seed: input.seed,
    valRatio: input.valRatio,
  });

  const trainJsonl = formatReasoningJsonl(exportResult.train.map((r) => r.sample));
  const outPath = await writeOutputFile(nonEmpty(input.outPath, "--out"), trainJsonl);

  let valOutPath: string | undefined;
  let valJsonl: string | undefined;
  if (input.valOutPath !== undefined) {
    valJsonl = formatReasoningJsonl(exportResult.val.map((r) => r.sample));
    valOutPath = await writeOutputFile(nonEmpty(input.valOutPath, "--val-out"), valJsonl);
  }

  const manifest = buildExportManifest({
    dbPath: input.dbPath,
    outPath,
    trainJsonl,
    valOutPath,
    valJsonl,
    reasoningRunId: input.reasoningRunId,
    hasSystemPrompt: input.systemPrompt !== undefined,
    shuffled: Boolean(input.shuffle),
    seed: input.seed,
    result: exportResult,
  });

  if (input.manifestPath !== undefined) {
    await writeOutputFile(nonEmpty(input.manifestPath, "--manifest"), JSON.stringify(manifest, null, 2) + "\n");
  }
  return manifest;
}

export function getReasoningStatus(
  options: ReasoningQueryFilterOptions & { dbPath?: string } = {},
): ReasoningStatusSummary & { db: string } {
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const queryOptions = buildQueryOptions(options);
  const store = new ReasoningStore(dbPath, { readOnly: true });
  try {
    return {
      db: dbPath,
      ...store.getStatusSummary(queryOptions),
    };
  } finally {
    store.close();
  }
}

export interface ReasoningExportWorkflowOptions extends ReasoningQueryFilterOptions {
  dbPath?: string;
  reasoningRunId?: number;
  outPath?: string;
  valOutPath?: string;
  valRatio?: number;
  manifestPath?: string;
  reviewMdPath?: string;
  format?: ReasoningExportFormat;
  expandTurns?: boolean;
  systemPrompt?: string;
  shuffle?: boolean;
  seed?: number;
}

export async function runReasoningExportWorkflow(
  options: ReasoningExportWorkflowOptions,
): Promise<Record<string, unknown>> {
  if (options.outPath === undefined && options.reviewMdPath === undefined) {
    throw new Error("至少需要指定 --out 或 --review-md");
  }
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const queryOptions = buildQueryOptions(options);
  const store = new ReasoningStore(dbPath, { readOnly: true });
  try {
    const report: Record<string, unknown> = { db: dbPath, mode: "export" };
    if (options.reviewMdPath !== undefined) {
      Object.assign(report, await writeReasoningReviewFile(store, options.reviewMdPath, options.reasoningRunId));
    }
    if (options.outPath !== undefined) {
      report.export = await writeReasoningExportFiles(store, {
        dbPath,
        queryOptions,
        reasoningRunId: options.reasoningRunId,
        outPath: options.outPath,
        valOutPath: options.valOutPath,
        valRatio: options.valRatio,
        manifestPath: options.manifestPath,
        format: options.format,
        expandTurns: options.expandTurns,
        systemPrompt: options.systemPrompt,
        shuffle: options.shuffle,
        seed: options.seed,
      });
    }
    return report;
  } finally {
    store.close();
  }
}

export interface ReasoningBackfillWorkflowOptions extends ReasoningQueryFilterOptions {
  dbPath?: string;
  onlyMissing?: boolean;
  limit?: number;
  stratified?: boolean;
  seed?: number;
  concurrency?: number;
  maxRewrites?: number;
  noLlmJudge?: boolean;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  writerThinking?: string;
  judgeThinking?: string;
  maxChars?: number;
  maxVerbatimRun?: number;
  writerSkillPath?: string;
  judgeSkillPath?: string;
  promptsDir?: string;
  reviewMdPath?: string;
  exportOutPath?: string;
  valOutPath?: string;
  valRatio?: number;
  manifestPath?: string;
  format?: ReasoningExportFormat;
  expandTurns?: boolean;
  systemPrompt?: string;
  shuffle?: boolean;
  env?: NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
}

export async function runReasoningBackfillWorkflow(
  options: ReasoningBackfillWorkflowOptions = {},
): Promise<Record<string, unknown>> {
  if ((options.valOutPath !== undefined) !== (options.valRatio !== undefined)) {
    throw new Error("--val-out 与 --val-ratio 必须成对指定");
  }
  if (options.valOutPath !== undefined && options.exportOutPath === undefined) {
    throw new Error("--val-out 必须搭配 --export 使用");
  }

  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const queryOptions = buildQueryOptions(options);
  const checkConfig: ReasoningCheckConfig = {
    maxChars: options.maxChars ?? DEFAULT_REASONING_CHECK_CONFIG.maxChars,
    maxVerbatimRun: options.maxVerbatimRun ?? DEFAULT_REASONING_CHECK_CONFIG.maxVerbatimRun,
  };
  const concurrency = validateConcurrency(options.concurrency ?? 10);
  const maxRewrites = options.maxRewrites ?? 3;
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const writerSkillPath = resolve(options.writerSkillPath ?? DEFAULT_REASONING_WRITER_SKILL);
  const judgeSkillPath = resolve(options.judgeSkillPath ?? DEFAULT_REASONING_JUDGE_SKILL);
  const promptsDir = resolve(options.promptsDir ?? DEFAULT_REASONING_PROMPTS_DIR);
  const useLlmJudge = !options.noLlmJudge;

  const [writerSkill, judgeSkill, prompts] = await Promise.all([
    readReasoningWriterSkill(writerSkillPath),
    useLlmJudge ? readReasoningJudgeSkill(judgeSkillPath) : Promise.resolve(undefined),
    readReasoningPrompts(promptsDir),
  ]);

  const baseEnv = options.env ?? process.env;
  const piConfigs = readReasoningPiConfigs({
    ...baseEnv,
    ...(options.writerThinking !== undefined ? { REASONING_THINKING_LEVEL: options.writerThinking } : {}),
    ...(options.judgeThinking !== undefined ? { REASONING_JUDGE_THINKING_LEVEL: options.judgeThinking } : {}),
  });
  const runners = createReasoningRunners(piConfigs);

  const store = new ReasoningStore(dbPath);
  try {
    const recovered = store.recoverInterruptedRuns();
    const allCandidates = store.queryCandidateTurns({
      ...queryOptions,
      onlyMissing: Boolean(options.onlyMissing),
    });

    const selectedCandidates = options.limit !== undefined
      ? (options.stratified
          ? selectStratifiedTurns(allCandidates, options.limit, options.seed ?? 42)
          : allCandidates.slice(0, options.limit))
      : allCandidates;

    if (selectedCandidates.length === 0) {
      return {
        db: dbPath,
        recovered,
        selectedTurns: 0,
        message: "没有待补写的通过对话轮次",
      };
    }

    const backfill = await runReasoningBackfill({
      store,
      candidates: selectedCandidates,
      writerPrompt: prompts.writer,
      writerSkill,
      writerSkillPath,
      judgePrompt: useLlmJudge ? prompts.judge : undefined,
      judgeSkill,
      judgeSkillPath: useLlmJudge ? judgeSkillPath : undefined,
      runWriter: runners.runWriter,
      runJudge: useLlmJudge ? runners.runJudge : undefined,
      writerModel: piConfigs.writer.modelId,
      judgeModel: useLlmJudge ? piConfigs.judge.modelId : null,
      checkConfig,
      maxRewrites,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      configSnapshot: {
        writerBaseUrl: piConfigs.writer.baseUrl,
        writerThinkingLevel: piConfigs.writer.thinkingLevel,
        ...(useLlmJudge
          ? { judgeBaseUrl: piConfigs.judge.baseUrl, judgeThinkingLevel: piConfigs.judge.thinkingLevel }
          : {}),
        stratified: Boolean(options.stratified),
        onlyMissing: Boolean(options.onlyMissing),
        profile: queryOptions.profile,
        ...(queryOptions.tiers ? { tiers: queryOptions.tiers } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
      },
      onProgress: ({ completed, total, turn, decision }) => {
        options.onProgress?.(
          `[cot ${completed}/${total}] result=${turn.resultId} turn=${turn.turnNo}/${turn.turnCount} profile=${turn.sourceProfile} tier=${turn.lengthTier} -> ${decision}\n`,
        );
      },
    });

    const summary: Record<string, unknown> = {
      db: dbPath,
      recovered,
      reasoningRunId: backfill.reasoningRunId,
      writerModel: piConfigs.writer.modelId,
      judgeModel: useLlmJudge ? piConfigs.judge.modelId : null,
      selectedTurns: backfill.selectedTurns,
      stats: backfill.stats,
    };

    if (options.reviewMdPath !== undefined) {
      const reviewInfo = await writeReasoningReviewFile(store, options.reviewMdPath, backfill.reasoningRunId);
      summary.reviewMd = reviewInfo.reviewMd;
    }

    if (options.exportOutPath !== undefined) {
      const exportReasoningRunId = options.onlyMissing ? undefined : backfill.reasoningRunId;
      summary.export = await writeReasoningExportFiles(store, {
        dbPath,
        queryOptions,
        reasoningRunId: exportReasoningRunId,
        outPath: options.exportOutPath,
        valOutPath: options.valOutPath,
        valRatio: options.valRatio,
        manifestPath: options.manifestPath,
        format: options.format,
        expandTurns: options.expandTurns,
        systemPrompt: options.systemPrompt,
        shuffle: options.shuffle,
        seed: options.seed,
      });
    }

    return summary;
  } finally {
    store.close();
  }
}
