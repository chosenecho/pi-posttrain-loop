import { dirname, join, resolve } from "node:path";
import { combineSignals, throwIfAborted } from "../shared/cancellation.js";
import {
  appendTimestampToPath,
  formatLocalTimestamp,
  writeOutputFile,
} from "../shared/cli-helpers.js";
import { DEFAULT_CORPUS_DIR, DEFAULT_MAIN_DB } from "../shared/paths.js";
import { readPiConfig, type PiConfig } from "../shared/pi-runner.js";
import type { WebSearchRunner } from "../shared/web-search.js";
import { assertSynthSplit, resolveSynthPlan, resolveSynthQuestionPlan } from "./plan.js";
import { defaultMaxTurnsForProfile } from "./profiles.js";
import { createSynthRunners } from "./runners.js";
export { assertSynthSplit, DEFAULT_SYNTH_MAX_ATTEMPTS, SYNTH_TEST_SPLIT_FORBIDDEN_MESSAGE } from "./plan.js";
export { defaultMaxTurnsForProfile } from "./profiles.js";
import {
  nonEmpty,
  validateMaxTurns,
  validateSplit,
} from "../shared/schema.js";
import {
  ALL_SYNTH_PROFILES,
  TRAIN_SUITE_PROFILES,
  type DatasetSplit,
  type RoleRunner,
  type SearchAnswerRunner,
  type SynthProfile,
} from "../shared/types.js";
import { extractVideoKey, sha256Hex } from "../shared/utils.js";
import {
  queryProcessedVideoIndex,
  rankVideosCoreFirst,
  resolveSingleVideoInput,
  scanCorpusVideos,
  selectVideos,
  summarizeCorpusStatus,
  type VideoSortMode,
  type VideoUnit,
} from "./corpus.js";
import { runCorpusQuestionGeneration, type RunCorpusQuestionsSummary } from "./corpus-questions.js";
import { loadTargetQuestions, runDialogueBatch, type RunDialogueBatchSummary } from "./dialogue-loop.js";
import { assertNoEvalLeak, readEvalVideoKeys } from "./eval-guard.js";
import type { SynthSkillOverrides } from "./skills.js";
import { summarizeSplitCounts, syncCorpusSplits, type SplitBreakdown } from "./splits.js";
import { DataMakerStore, formatSamplesJsonl, type DedupPolicy } from "./store/index.js";

export interface SynthStatusReport {
  db: string;
  inputDir: string;
  split: DatasetSplit;
  profile?: SynthProfile;
  totalVideos: number;
  totalPartFiles: number;
  multiPartVideos: number;
  processedVideos: number;
  unprocessedVideos: number;
  processedByProfile: Record<SynthProfile, { processedVideos: number; unprocessedVideos: number }>;
  unjudgedQuestionsForMaxTurns: number;
  maxTurns: number;
  splits: SplitBreakdown;
  /** Predicted split counts include these videos; a generation/sync write persists their assignments. */
  pendingSplitSyncVideos: number;
}

export async function getSynthStatus(options: {
  dbPath?: string;
  inputDir?: string;
  split?: DatasetSplit;
  profile?: SynthProfile;
  maxTurns?: number;
} = {}): Promise<SynthStatusReport> {
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const inputDir = resolve(options.inputDir ?? DEFAULT_CORPUS_DIR);
  const targetSplit = validateSplit(options.split ?? "train", "--split");
  const maxTurns = validateMaxTurns(
    options.maxTurns ?? (options.profile ? defaultMaxTurnsForProfile(options.profile) : 3),
  );

  const store = new DataMakerStore(dbPath, { readOnly: true });
  try {
    const units = await scanCorpusVideos(inputDir);
    const persistedVideoKeys = new Set(store.listVideoSplits().map((row) => row.video_key));
    const { processedVideoKeys } = queryProcessedVideoIndex(store);
    const pendingVideoKeys = new Set([...units.map((unit) => extractVideoKey(unit.videoId)), ...processedVideoKeys]);
    const pendingSplitSyncVideos = [...pendingVideoKeys].filter((key) => !persistedVideoKeys.has(key)).length;
    const status = summarizeCorpusStatus(units, store, options.profile);
    const processedByProfile = Object.fromEntries(
      ALL_SYNTH_PROFILES.map((p) => {
        const s = summarizeCorpusStatus(units, store, p);
        return [p, { processedVideos: s.processedVideos, unprocessedVideos: s.unprocessedVideos }];
      }),
    ) as Record<SynthProfile, { processedVideos: number; unprocessedVideos: number }>;
    const splits = summarizeSplitCounts(store, units);
    const unjudged = loadTargetQuestions(store, {
      onlyUnjudged: true,
      maxTurns,
      split: targetSplit,
      ...(options.profile ? { generationProfile: options.profile } : {}),
    }).length;
    return {
      db: dbPath,
      inputDir,
      split: targetSplit,
      ...(options.profile ? { profile: options.profile } : {}),
      totalVideos: status.totalVideos,
      totalPartFiles: status.totalPartFiles,
      multiPartVideos: status.multiPartVideos,
      processedVideos: status.processedVideos,
      unprocessedVideos: status.unprocessedVideos,
      processedByProfile,
      unjudgedQuestionsForMaxTurns: unjudged,
      maxTurns,
      splits,
      pendingSplitSyncVideos,
    };
  } finally {
    store.close();
  }
}

export interface SynthBatchWorkflowOptions {
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
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  concurrency?: number;
  includeUnjudged?: boolean;
  noSkill?: boolean;
  promptsDir?: string;
  skillOverrides?: SynthSkillOverrides;
  exportPath?: string;
  exportSystemPrompt?: string;
  evalDbPath?: string;
  /** Default true (unless noSkill is true): mounts `web_search` on Answer Agent across all profiles. */
  enableSearch?: boolean;
  config?: PiConfig;
  runRole?: RoleRunner;
  runSearchAnswer?: SearchAnswerRunner;
  webSearchRunner?: WebSearchRunner;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export async function runSynthBatchWorkflow(options: SynthBatchWorkflowOptions): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  const plan = await resolveSynthPlan({ ...options, mode: "batch" });
  throwIfAborted(options.signal);
  const {
    profile, inputDir, dbPath, limit, maxQuestionsPerVideo, maxTurns, maxAttempts,
    callMaxAttempts, callRetryDelayMs, concurrency, bundle, trainingEnabled, evalEnabled,
    config, sanitizedModel, sort: sortMode, effectiveSplit: targetSplit,
  } = plan;
  const { runRole, runSearchAnswer } = createSynthRunners(plan, options);
  const log = options.onProgress;

  const store = new DataMakerStore(dbPath);
  const signal = combineSignals(options.signal, store.signal);
  try {
    throwIfAborted(signal);
    store.markInterruptedRuns();

    const allUnits = await scanCorpusVideos(inputDir);
    throwIfAborted(signal);
    const splitMap = syncCorpusSplits(store, allUnits);
    const { processedVideoKeys } = queryProcessedVideoIndex(store, profile);
    const unprocessedPool = allUnits.filter((u) => !processedVideoKeys.has(extractVideoKey(u.videoId)));
    const splitPool = selectVideos(unprocessedPool, {
      shuffle: plan.shuffle,
      split: targetSplit,
      splitMap,
    });
    const orderedPool = sortMode === "core-first" ? await rankVideosCoreFirst(splitPool) : splitPool;
    throwIfAborted(signal);
    const selectedVideos = orderedPool.slice(0, limit);

    let questionSummary: RunCorpusQuestionsSummary | undefined;
    let targetQuestionIds: number[] = [];

    if (selectedVideos.length > 0) {
      log?.(`=== 阶段 1/2：出题（分区 ${targetSplit}，profile=${profile}，选中 ${selectedVideos.length} 个未处理视频，并发 ${concurrency}，模型 ${config.modelId}）===`);
      questionSummary = await runCorpusQuestionGeneration({
        store,
        signal,
        config,
        systemPrompt: bundle.questionPrompt!,
        skills: bundle.questionSkills.map((skill) => ({ ...skill })),
        candidates: selectedVideos,
        concurrency,
        split: targetSplit,
        profile,
        callMaxAttempts,
        callRetryDelayMs,
        maxQuestionsPerVideo,
        onProgress: log,
      });
      throwIfAborted(signal);
      targetQuestionIds = questionSummary.generatedQuestionIds;
    }

    if (options.includeUnjudged) {
      const pendingIds = loadTargetQuestions(store, {
        onlyUnjudged: true,
        maxTurns,
        split: targetSplit,
        generationProfile: profile,
      }).map((row) => row.id);
      targetQuestionIds = [...new Set([...targetQuestionIds, ...pendingIds])];
    }

    if (targetQuestionIds.length === 0) {
      return {
        db: dbPath,
        inputDir,
        split: targetSplit,
        profile,
        selectedVideos: selectedVideos.length,
        savedQuestions: questionSummary?.savedQuestions ?? 0,
        questionRunId: questionSummary?.runId ?? null,
        judgeRunId: null,
        message: selectedVideos.length === 0
          ? `分区 ${targetSplit} 中没有未处理的新视频`
          : "本批视频未产出新问题（可能均为已有重复题或空题）",
        errors: questionSummary?.errors ?? 0,
        integrityOk: questionSummary?.integrityOk ?? true,
      };
    }

    log?.(`=== 阶段 2/2：问答质检（分区 ${targetSplit}，profile=${profile}，${targetQuestionIds.length} 题，最多 ${maxTurns} 轮，每轮最多 ${maxAttempts} 次，并发 ${concurrency}）===`);
    const dialogueSummary: RunDialogueBatchSummary = await runDialogueBatch({
      store,
      signal,
      runRole,
      ...(runSearchAnswer ? { runSearchAnswer } : {}),
      prompts: bundle.dialoguePrompts,
      maxAttempts,
      maxTurns,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      split: targetSplit,
      questionIds: targetQuestionIds,
      config: {
        mode: plan.noSkill ? "sqlite-batch-no-skill" : "sqlite-batch",
        split: targetSplit,
        profile,
        model: sanitizedModel,
        promptDirectory: bundle.promptDir,
        questionRunId: questionSummary?.runId ?? null,
        inputSchemaVersion: maxTurns > 1 ? "v2-multiturn-json" : "v1-minimal-json",
      },
      skills: [...bundle.dialogueSkills],
      exportPolicy: plan.exportPolicy,
      onProgress: log,
    });

    throwIfAborted(signal);
    let exportedPath: string | undefined;
    if (options.exportPath !== undefined) {
      if (targetSplit === "train") {
        const evalDbPath = resolve(options.evalDbPath ?? join(dirname(dbPath), "eval.sqlite"));
        const evalVideoKeys = readEvalVideoKeys(evalDbPath);
        if (evalVideoKeys.size > 0) {
          const exported = store.exportMergedDataset({ runIds: [dialogueSummary.runId], split: "train" });
          const materialInfo = store.getMaterialVideoAndSplitMap();
          const videoKeys = exported.train.map((r) => materialInfo.get(r.materialId)?.videoKey ?? String(r.materialId));
          assertNoEvalLeak(videoKeys, evalVideoKeys, "批次训练导出");
        }
      }
      const jsonl = store.exportRunJsonl(dialogueSummary.runId, { systemPrompt: options.exportSystemPrompt });
      exportedPath = await writeOutputFile(nonEmpty(options.exportPath, "--export"), jsonl);
      throwIfAborted(signal);
    }

    const totalErrors = (questionSummary?.errors ?? 0) + dialogueSummary.errors;
    const integrityOk = (questionSummary?.integrityOk ?? true) && dialogueSummary.integrityOk;

    return {
      db: dbPath,
      inputDir,
      split: targetSplit,
      profile,
      questionRunId: questionSummary?.runId ?? null,
      selectedVideos: selectedVideos.length,
      processedVideos: questionSummary?.processedVideos ?? 0,
      savedQuestions: questionSummary?.savedQuestions ?? 0,
      questionErrors: questionSummary?.errors ?? 0,
      judgeRunId: dialogueSummary.runId,
      judgedQuestions: dialogueSummary.questions,
      maxTurns,
      maxAttempts,
      concurrency,
      outcomes: dialogueSummary.outcomes,
      results: dialogueSummary.results,
      judgeErrors: dialogueSummary.errors,
      trainingEnabled,
      ...(targetSplit !== "train" ? { evalEnabled } : {}),
      integrityOk,
      errors: totalErrors,
      ...(exportedPath ? { exportedPath } : {}),
    };
  } finally {
    store.close();
  }
}

export interface SynthSuiteWorkflowOptions {
  dbPath?: string;
  inputDir?: string;
  split?: DatasetSplit;
  profiles?: SynthProfile[];
  limit?: number;
  sort?: VideoSortMode;
  shuffle?: boolean;
  maxAttempts?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  concurrency?: number;
  includeUnjudged?: boolean;
  evalDbPath?: string;
  enableSearch?: boolean;
  config?: PiConfig;
  runRole?: RoleRunner;
  runSearchAnswer?: SearchAnswerRunner;
  webSearchRunner?: WebSearchRunner;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * Runs all 6 Skill-driven profiles (`short`, `medium`, `long`, `xlong`, `trap`, `search`) across the target
 * video batch so each video naturally produces questions & dialogues across all suites.
 */
export async function runSynthSuiteWorkflow(
  options: SynthSuiteWorkflowOptions = {},
): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  const config = structuredClone(options.config ?? readPiConfig());
  const profiles: SynthProfile[] = options.profiles && options.profiles.length > 0
    ? options.profiles
    : [...TRAIN_SUITE_PROFILES];
  const targetSplit = assertSynthSplit(validateSplit(options.split ?? "train", "--split"));
  const sort: VideoSortMode | undefined = options.sort ?? (options.shuffle ? undefined : "core-first");
  const limit = options.limit ?? 10;

  const perProfile: Record<string, Record<string, unknown>> = {};
  let totalSavedQuestions = 0;
  let totalResults = 0;
  let totalErrors = 0;
  let allIntegrityOk = true;

  for (const profile of profiles) {
    throwIfAborted(options.signal);
    options.onProgress?.(`\n>>> [suite] 开始执行 profile=${profile}（limit=${limit}，split=${targetSplit}）`);
    const summary = await runSynthBatchWorkflow({
      dbPath: options.dbPath,
      inputDir: options.inputDir,
      split: targetSplit,
      profile,
      limit,
      sort,
      shuffle: options.shuffle,
      maxTurns: defaultMaxTurnsForProfile(profile),
      maxAttempts: options.maxAttempts,
      callMaxAttempts: options.callMaxAttempts,
      callRetryDelayMs: options.callRetryDelayMs,
      concurrency: options.concurrency,
      includeUnjudged: options.includeUnjudged,
      evalDbPath: options.evalDbPath,
      enableSearch: options.enableSearch,
      config,
      signal: options.signal,
      runRole: options.runRole,
      runSearchAnswer: options.runSearchAnswer,
      webSearchRunner: options.webSearchRunner,
      onProgress: options.onProgress,
    });
    throwIfAborted(options.signal);
    perProfile[profile] = summary;
    totalSavedQuestions += Number(summary.savedQuestions ?? 0);
    totalResults += Number(summary.results ?? 0);
    totalErrors += Number(summary.errors ?? 0);
    if (summary.integrityOk === false) allIntegrityOk = false;
  }

  return {
    split: targetSplit,
    profiles,
    limit,
    sort: sort ?? "shuffle",
    totalSavedQuestions,
    totalResults,
    errors: totalErrors,
    integrityOk: allIntegrityOk,
    perProfile,
  };
}

export interface SynthQuestionsWorkflowOptions {
  dbPath?: string;
  input?: string;
  inputDir?: string;
  split?: DatasetSplit;
  profile?: SynthProfile;
  limit?: number;
  sort?: VideoSortMode;
  shuffle?: boolean;
  maxQuestionsPerVideo?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  force?: boolean;
  videoIdOverride?: string;
  questionSkillPath?: string;
  noSkill?: boolean;
  config?: PiConfig;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export async function runSynthQuestionsWorkflow(options: SynthQuestionsWorkflowOptions): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  const plan = await resolveSynthQuestionPlan(options);
  throwIfAborted(options.signal);
  const { dbPath, inputDir, profile, concurrency, callMaxAttempts, callRetryDelayMs, config, systemPrompt, sort: sortMode, split: targetSplit } = plan;
  const skills = plan.skills.map((skill) => ({ ...skill }));
  const store = new DataMakerStore(dbPath);
  const signal = combineSignals(options.signal, store.signal);
  try {
    throwIfAborted(signal);
    store.markInterruptedRuns();
    const { processedVideoKeys } = queryProcessedVideoIndex(store, profile);

    let candidates: VideoUnit[];
    if (inputDir !== undefined) {
      const allUnits = await scanCorpusVideos(inputDir);
      throwIfAborted(signal);
      const splitMap = syncCorpusSplits(store, allUnits);
      const pool = options.force
        ? allUnits
        : allUnits.filter((u) => !processedVideoKeys.has(extractVideoKey(u.videoId)));
      const splitPool = selectVideos(pool, {
        shuffle: Boolean(options.shuffle),
        split: targetSplit,
        splitMap,
      });
      const orderedPool = sortMode === "core-first" ? await rankVideosCoreFirst(splitPool) : splitPool;
      throwIfAborted(signal);
      candidates = options.limit !== undefined ? orderedPool.slice(0, options.limit) : orderedPool;
      if (candidates.length === 0) {
        return {
          db: dbPath,
          split: targetSplit,
          totalVideos: allUnits.length,
          selectedVideos: 0,
          errors: 0,
          integrityOk: true,
          message: "没有需要处理的未出题视频",
        };
      }
    } else {
      const unit = await resolveSingleVideoInput(options.input!, {
        videoIdOverride: options.videoIdOverride,
        mergeSiblingParts: true,
      });
      throwIfAborted(signal);
      if (!options.force && processedVideoKeys.has(extractVideoKey(unit.videoId))) {
        return {
          db: dbPath,
          videoId: unit.videoId,
          partCount: unit.partPaths.length,
          skipped: true,
          errors: 0,
          integrityOk: true,
          reason: "该视频已在库中完成出题；如需重出请加 --force",
        };
      }
      candidates = [unit];
    }

    options.onProgress?.(`数据库：${dbPath}\n分区：${targetSplit}；profile：${profile}；选中视频：${candidates.length}；并发：${concurrency}；模型：${config.modelId}`);

    const summary = await runCorpusQuestionGeneration({
      store,
      signal,
      config,
      systemPrompt,
      skills,
      candidates,
      concurrency,
      split: targetSplit,
      profile,
      callMaxAttempts,
      callRetryDelayMs,
      force: Boolean(options.force),
      maxQuestionsPerVideo: options.maxQuestionsPerVideo,
      onProgress: options.onProgress,
    });

    throwIfAborted(signal);
    return {
      db: dbPath,
      split: targetSplit,
      profile,
      runId: summary.runId,
      selectedVideos: summary.selectedVideos,
      processedVideos: summary.processedVideos,
      skippedBySha256: summary.skippedBySha256,
      savedQuestions: summary.savedQuestions,
      skippedDuplicateQuestions: summary.skippedDuplicateQuestions,
      errors: summary.errors,
      integrityOk: summary.integrityOk,
    };
  } finally {
    store.close();
  }
}

export interface SynthJudgeWorkflowOptions {
  dbPath?: string;
  split?: DatasetSplit;
  profile?: SynthProfile;
  maxAttempts?: number;
  maxTurns?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  videoId?: string;
  questionIds?: number[];
  onlyUnjudged?: boolean;
  noSkill?: boolean;
  promptsDir?: string;
  skillOverrides?: SynthSkillOverrides;
  exportPath?: string;
  exportSystemPrompt?: string;
  /** Default true when using default Skill-driven profiles (false when custom prompts/skills or noSkill are used). */
  enableSearch?: boolean;
  config?: PiConfig;
  runRole?: RoleRunner;
  runSearchAnswer?: SearchAnswerRunner;
  webSearchRunner?: WebSearchRunner;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export async function runSynthJudgeWorkflow(options: SynthJudgeWorkflowOptions): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  const plan = await resolveSynthPlan({ ...options, mode: "judge" });
  throwIfAborted(options.signal);
  const {
    profile, dbPath, maxTurns, maxAttempts, concurrency, callMaxAttempts, callRetryDelayMs,
    bundle, sanitizedModel, trainingEnabled, split: targetSplit,
  } = plan;
  const { runRole, runSearchAnswer } = createSynthRunners(plan, options);

  const store = new DataMakerStore(dbPath);
  const signal = combineSignals(options.signal, store.signal);
  try {
    throwIfAborted(signal);
    const onlyUnjudged = Boolean(options.onlyUnjudged);
    if (onlyUnjudged) {
      store.markInterruptedRuns();
      const pending = loadTargetQuestions(store, {
        videoId: options.videoId,
        questionIds: options.questionIds,
        onlyUnjudged: true,
        maxTurns,
        split: targetSplit,
      });
      if (pending.length === 0) {
        return {
          db: dbPath,
          ...(targetSplit ? { split: targetSplit } : {}),
          maxTurns,
          onlyUnjudged: true,
          selectedQuestions: 0,
          errors: 0,
          integrityOk: true,
          message: "没有需要处理的未质检问题",
        };
      }
    }

    const summary = await runDialogueBatch({
      store,
      signal,
      runRole,
      ...(runSearchAnswer ? { runSearchAnswer } : {}),
      prompts: bundle.dialoguePrompts,
      maxAttempts,
      maxTurns,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      split: targetSplit,
      videoId: options.videoId,
      questionIds: options.questionIds,
      onlyUnjudged,
      config: {
        mode: plan.noSkill ? "sqlite-judge-no-skill" : "sqlite-judge",
        ...(targetSplit ? { split: targetSplit } : {}),
        profile,
        model: sanitizedModel,
        promptDirectory: bundle.promptDir,
        inputSchemaVersion: maxTurns > 1 ? "v2-multiturn-json" : "v1-minimal-json",
      },
      skills: [...bundle.dialogueSkills],
      exportPolicy: plan.exportPolicy,
      onProgress: options.onProgress,
    });

    throwIfAborted(signal);
    let exportedPath: string | undefined;
    if (options.exportPath !== undefined) {
      const jsonl = store.exportRunJsonl(summary.runId, { systemPrompt: options.exportSystemPrompt });
      exportedPath = await writeOutputFile(nonEmpty(options.exportPath, "--export"), jsonl);
      throwIfAborted(signal);
    }

    return {
      ...summary,
      trainingEnabled,
      ...(exportedPath ? { exportedPath } : {}),
    };
  } finally {
    store.close();
  }
}

export interface SynthExportWorkflowOptions {
  dbPath?: string;
  evalDbPath?: string;
  runIds?: number[];
  allFormal?: boolean;
  split?: DatasetSplit;
  excludeRunIds?: number[];
  minTurns?: number;
  maxTurns?: number;
  dedup?: DedupPolicy;
  shuffle?: boolean;
  seed?: number;
  outPath: string;
  valOutPath?: string;
  valRatio?: number;
  manifestPath?: string;
  timestamp?: boolean;
  systemPrompt?: string;
  generalizeTools?: boolean;
  negativeToolsRatio?: number;
  signal?: AbortSignal;
}

export async function runSynthExportWorkflow(options: SynthExportWorkflowOptions): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  if ((options.valOutPath !== undefined) !== (options.valRatio !== undefined)) {
    throw new Error("--val-out 与 --val-ratio 必须成对指定");
  }

  const hasRunIds = options.runIds !== undefined && options.runIds.length > 0;
  const allFormal = Boolean(options.allFormal) || !hasRunIds;
  if (hasRunIds && Boolean(options.allFormal)) {
    throw new Error("请在 --run、--runs、--all-formal 中最多指定一种选取模式");
  }

  const targetSplit = options.split !== undefined ? assertSynthSplit(validateSplit(options.split, "--split")) : undefined;

  const exportTimestamp = options.timestamp ? formatLocalTimestamp() : undefined;
  const resolveExportPath = (rawPath: string): string => {
    const resolved = resolve(rawPath);
    return exportTimestamp ? appendTimestampToPath(resolved, exportTimestamp) : resolved;
  };

  const outPath = resolveExportPath(nonEmpty(options.outPath, "--out"));
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const dedup: DedupPolicy = options.dedup ?? "latest";

  const store = new DataMakerStore(dbPath, { readOnly: true });
  try {
    const merged = store.exportMergedDataset({
      runIds: options.runIds,
      allFormal,
      split: targetSplit,
      excludeRunIds: options.excludeRunIds,
      minTurns: options.minTurns,
      maxTurns: options.maxTurns,
      dedup,
      shuffle: Boolean(options.shuffle),
      seed: options.seed,
      valRatio: options.valRatio,
      systemPrompt: options.systemPrompt,
      generalizeTools: options.generalizeTools,
      negativeToolsRatio: options.negativeToolsRatio,
    });

    const isTrainingExport = targetSplit === undefined || targetSplit === "train";
    if (isTrainingExport) {
      const evalDbPath = resolve(options.evalDbPath ?? join(dirname(dbPath), "eval.sqlite"));
      const evalVideoKeys = readEvalVideoKeys(evalDbPath);
      if (evalVideoKeys.size > 0) {
        const materialInfo = store.getMaterialVideoAndSplitMap();
        const exportedVideoKeys = [...merged.train, ...merged.val].map(
          (r) => materialInfo.get(r.materialId)?.videoKey ?? String(r.materialId),
        );
        assertNoEvalLeak(exportedVideoKeys, evalVideoKeys, "训练导出");
      }
    }

    const trainJsonl = formatSamplesJsonl(merged.train.map((r) => r.sample));
    throwIfAborted(options.signal);
    await writeOutputFile(outPath, trainJsonl);
    throwIfAborted(options.signal);

    let valOutPath: string | undefined;
    let valSha256: string | undefined;
    if (options.valOutPath !== undefined) {
      valOutPath = resolveExportPath(nonEmpty(options.valOutPath, "--val-out"));
      const valJsonl = formatSamplesJsonl(merged.val.map((r) => r.sample));
      await writeOutputFile(valOutPath, valJsonl);
      throwIfAborted(options.signal);
      valSha256 = sha256Hex(valJsonl);
    }

    const manifestPath = options.manifestPath !== undefined
      ? resolveExportPath(nonEmpty(options.manifestPath, "--manifest"))
      : undefined;

    const report: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      ...(exportTimestamp ? { timestamp: exportTimestamp } : {}),
      db: dbPath,
      mode: allFormal
        ? "all-formal"
        : options.runIds && options.runIds.length > 1
          ? "runs"
          : "single-run",
      ...(targetSplit !== undefined ? { split: targetSplit } : allFormal ? { split: "train" } : {}),
      dedup,
      includedRunIds: merged.includedRunIds,
      countsByRunId: merged.countsByRunId,
      duplicateQuestionsResolved: merged.duplicateQuestionsResolved,
      turnCountDistribution: merged.turnCountDistribution,
      materialCount: merged.materialCount,
      trainMaterialCount: merged.trainMaterialCount,
      valMaterialCount: merged.valMaterialCount,
      exported: merged.train.length,
      trainSamples: merged.train.length,
      valSamples: merged.val.length,
      hasSystemPrompt: options.systemPrompt !== undefined,
      shuffled: Boolean(options.shuffle),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      out: outPath,
      outSha256: sha256Hex(trainJsonl),
      ...(valOutPath ? { valOut: valOutPath, valSha256 } : {}),
      ...(manifestPath ? { manifest: manifestPath } : {}),
    };

    if (manifestPath !== undefined) {
      await writeOutputFile(manifestPath, JSON.stringify(report, null, 2) + "\n");
      throwIfAborted(options.signal);
    }

    return report;
  } finally {
    store.close();
  }
}
