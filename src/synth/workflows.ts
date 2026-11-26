import { dirname, join, resolve } from "node:path";
import {
  appendTimestampToPath,
  formatLocalTimestamp,
  writeOutputFile,
} from "../shared/cli-helpers.js";
import { DEFAULT_CORPUS_DIR, DEFAULT_MAIN_DB } from "../shared/paths.js";
import { createPiRunner, readPiConfig, sanitizePiConfig, type PiConfig } from "../shared/pi-runner.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../shared/retry.js";
import {
  nonEmpty,
  validateConcurrency,
  validateMaxAttempts,
  validateMaxTurns,
  validateSplit,
} from "../shared/schema.js";
import type { DatasetSplit, RoleRunner, SynthProfile } from "../shared/types.js";
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
import { questionPrompt, readQuestionGeneratorPrompt } from "./prompts.js";
import { DEFAULT_QUESTION_SKILL, readQuestionSkill, resolveSynthBundle, type SynthSkillOverrides } from "./skills.js";
import { summarizeSplitCounts, syncCorpusSplits, type SplitBreakdown } from "./splits.js";
import { DataMakerStore, formatSamplesJsonl, type DedupPolicy } from "./store/index.js";

/** test 分区仅由独立 eval 流水线（eval.sqlite）生产，synth 侧一律拒绝。 */
export const SYNTH_TEST_SPLIT_FORBIDDEN_MESSAGE =
  "test 分区仅供 eval 流水线使用，请使用 npm run dm -- eval make";

export function assertSynthSplit(split: DatasetSplit): DatasetSplit {
  if (split === "test") {
    throw new Error(SYNTH_TEST_SPLIT_FORBIDDEN_MESSAGE);
  }
  return split;
}

export interface SynthStatusReport {
  db: string;
  inputDir: string;
  split: DatasetSplit;
  totalVideos: number;
  totalPartFiles: number;
  multiPartVideos: number;
  processedVideos: number;
  unprocessedVideos: number;
  unjudgedQuestionsForMaxTurns: number;
  maxTurns: number;
  splits: SplitBreakdown;
}

export async function getSynthStatus(options: {
  dbPath?: string;
  inputDir?: string;
  split?: DatasetSplit;
  maxTurns?: number;
} = {}): Promise<SynthStatusReport> {
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const inputDir = resolve(options.inputDir ?? DEFAULT_CORPUS_DIR);
  const targetSplit = validateSplit(options.split ?? "train", "--split");
  const maxTurns = validateMaxTurns(options.maxTurns ?? 3);

  const store = new DataMakerStore(dbPath);
  try {
    const units = await scanCorpusVideos(inputDir);
    syncCorpusSplits(store, units);
    const status = summarizeCorpusStatus(units, store);
    const splits = summarizeSplitCounts(store, units);
    const unjudged = loadTargetQuestions(store, { onlyUnjudged: true, maxTurns, split: targetSplit }).length;
    return {
      db: dbPath,
      inputDir,
      split: targetSplit,
      totalVideos: status.totalVideos,
      totalPartFiles: status.totalPartFiles,
      multiPartVideos: status.multiPartVideos,
      processedVideos: status.processedVideos,
      unprocessedVideos: status.unprocessedVideos,
      unjudgedQuestionsForMaxTurns: unjudged,
      maxTurns,
      splits,
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
  config?: PiConfig;
  runRole?: RoleRunner;
  onProgress?: (message: string) => void;
}

export async function runSynthBatchWorkflow(options: SynthBatchWorkflowOptions): Promise<Record<string, unknown>> {
  const profile = options.profile ?? "standard";
  const targetSplit = assertSynthSplit(validateSplit(options.split ?? "train", "--split"));
  const sortMode = options.sort ?? "id";
  if (sortMode === "core-first" && options.shuffle) {
    throw new Error("--sort core-first 不能与 --shuffle 同时指定");
  }

  const inputDir = resolve(options.inputDir ?? DEFAULT_CORPUS_DIR);
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const limit = options.limit ?? 10;
  const maxQuestionsPerVideo = options.maxQuestionsPerVideo ?? (profile === "trap" ? 3 : undefined);
  const defaultMaxTurns = profile === "standard" ? 3 : 2;
  const maxTurns = validateMaxTurns(options.maxTurns ?? defaultMaxTurns);
  const maxAttempts = validateMaxAttempts(options.maxAttempts ?? 3);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const concurrency = validateConcurrency(options.concurrency ?? 10);

  const bundle = await resolveSynthBundle({
    profile,
    noSkill: options.noSkill,
    maxTurns,
    includeQuestionGenerator: true,
    promptsDir: options.promptsDir,
    overrides: options.skillOverrides,
  });

  const trainingEnabled = targetSplit === "train" && bundle.rubricReady;
  const evalEnabled = targetSplit !== "train" && bundle.rubricReady;

  const config = options.config ?? readPiConfig();
  const sanitizedModel = sanitizePiConfig(config);
  const runRole = options.runRole ?? createPiRunner(config);
  const log = options.onProgress;

  const store = new DataMakerStore(dbPath);
  try {
    store.markInterruptedRuns();

    const allUnits = await scanCorpusVideos(inputDir);
    const splitMap = syncCorpusSplits(store, allUnits);
    const { processedVideoKeys } = queryProcessedVideoIndex(store);
    const unprocessedPool = allUnits.filter((u) => !processedVideoKeys.has(extractVideoKey(u.videoId)));
    const splitPool = selectVideos(unprocessedPool, {
      shuffle: Boolean(options.shuffle),
      split: targetSplit,
      splitMap,
    });
    const orderedPool = sortMode === "core-first" ? await rankVideosCoreFirst(splitPool) : splitPool;
    const selectedVideos = orderedPool.slice(0, limit);

    let questionSummary: RunCorpusQuestionsSummary | undefined;
    let targetQuestionIds: number[] = [];

    if (selectedVideos.length > 0) {
      log?.(`=== 阶段 1/2：出题（分区 ${targetSplit}，profile=${profile}，选中 ${selectedVideos.length} 个未处理视频，并发 ${concurrency}，模型 ${config.modelId}）===`);
      questionSummary = await runCorpusQuestionGeneration({
        store,
        config,
        systemPrompt: bundle.questionPrompt!,
        skills: bundle.questionSkills as unknown as Array<Record<string, unknown>>,
        candidates: selectedVideos,
        concurrency,
        split: targetSplit,
        profile,
        callMaxAttempts,
        callRetryDelayMs,
        maxQuestionsPerVideo,
        onProgress: log,
      });
      targetQuestionIds = questionSummary.generatedQuestionIds;
    }

    if (options.includeUnjudged) {
      const pendingIds = loadTargetQuestions(store, {
        onlyUnjudged: true,
        maxTurns,
        split: targetSplit,
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
      runRole,
      prompts: bundle.dialoguePrompts,
      maxAttempts,
      maxTurns,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      split: targetSplit,
      questionIds: targetQuestionIds,
      config: {
        mode: options.noSkill ? "sqlite-batch-no-skill" : "sqlite-batch",
        split: targetSplit,
        profile,
        model: sanitizedModel,
        promptDirectory: bundle.promptDir,
        questionRunId: questionSummary?.runId ?? null,
        inputSchemaVersion: maxTurns > 1 ? "v2-multiturn-json" : "v1-minimal-json",
      },
      skills: bundle.dialogueSkills,
      exportPolicy: targetSplit === "train"
        ? { format: "messages_jsonl", split: "train", training_enabled: trainingEnabled }
        : {
            format: "messages_jsonl",
            split: targetSplit,
            purpose: targetSplit,
            training_enabled: false,
            eval_enabled: evalEnabled,
          },
      onProgress: log,
    });

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

export interface SynthQuestionsWorkflowOptions {
  dbPath?: string;
  input?: string;
  inputDir?: string;
  split?: DatasetSplit;
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
}

export async function runSynthQuestionsWorkflow(options: SynthQuestionsWorkflowOptions): Promise<Record<string, unknown>> {
  const hasInput = options.input !== undefined;
  const hasInputDir = options.inputDir !== undefined;
  if (hasInput && hasInputDir) {
    throw new Error("--input 与 --input-dir 不能同时指定");
  }
  const sortMode = options.sort ?? "id";
  if (sortMode === "core-first" && options.shuffle) {
    throw new Error("--sort core-first 不能与 --shuffle 同时指定");
  }
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const targetSplit = assertSynthSplit(validateSplit(options.split ?? "train", "--split"));
  const concurrency = validateConcurrency(options.concurrency ?? 10);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const inputDir = !hasInput ? resolve(options.inputDir ?? DEFAULT_CORPUS_DIR) : undefined;

  const basePrompt = await readQuestionGeneratorPrompt();
  let systemPrompt = basePrompt;
  const skills: Array<Record<string, unknown>> = [];
  if (!options.noSkill) {
    const skillPath = resolve(options.questionSkillPath ?? DEFAULT_QUESTION_SKILL);
    const qSkill = await readQuestionSkill(skillPath);
    systemPrompt = questionPrompt(basePrompt, qSkill.body);
    skills.push({ name: "question-design", path: skillPath, status: qSkill.status, body: qSkill.body, sha256: qSkill.sha256 });
  }

  const config = options.config ?? readPiConfig();
  const store = new DataMakerStore(dbPath);
  try {
    store.markInterruptedRuns();
    const { processedVideoKeys } = queryProcessedVideoIndex(store);

    let candidates: VideoUnit[];
    if (inputDir !== undefined) {
      const allUnits = await scanCorpusVideos(inputDir);
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

    options.onProgress?.(`数据库：${dbPath}\n分区：${targetSplit}；选中视频：${candidates.length}；并发：${concurrency}；模型：${config.modelId}`);

    const summary = await runCorpusQuestionGeneration({
      store,
      config,
      systemPrompt,
      skills,
      candidates,
      concurrency,
      split: targetSplit,
      callMaxAttempts,
      callRetryDelayMs,
      force: Boolean(options.force),
      maxQuestionsPerVideo: options.maxQuestionsPerVideo,
      onProgress: options.onProgress,
    });

    return {
      db: dbPath,
      split: targetSplit,
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
  config?: PiConfig;
  runRole?: RoleRunner;
  onProgress?: (message: string) => void;
}

export async function runSynthJudgeWorkflow(options: SynthJudgeWorkflowOptions): Promise<Record<string, unknown>> {
  const profile = options.profile ?? "standard";
  const dbPath = resolve(options.dbPath ?? DEFAULT_MAIN_DB);
  const targetSplit = options.split !== undefined ? assertSynthSplit(validateSplit(options.split, "--split")) : undefined;
  const maxAttempts = validateMaxAttempts(options.maxAttempts ?? 3);
  const defaultMaxTurns = profile === "standard" ? 3 : 2;
  const maxTurns = validateMaxTurns(options.maxTurns ?? defaultMaxTurns);
  const concurrency = validateConcurrency(options.concurrency ?? 10);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const bundle = await resolveSynthBundle({
    profile,
    noSkill: options.noSkill,
    maxTurns,
    includeQuestionGenerator: false,
    promptsDir: options.promptsDir,
    overrides: options.skillOverrides,
  });

  const config = options.config ?? readPiConfig();
  const sanitizedModel = sanitizePiConfig(config);
  const runRole = options.runRole ?? createPiRunner(config);

  const store = new DataMakerStore(dbPath);
  try {
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

    const effectiveSplit = targetSplit ?? "train";
    const trainingEnabled = effectiveSplit === "train" && bundle.rubricReady;
    const evalEnabled = effectiveSplit !== "train" && bundle.rubricReady;

    const summary = await runDialogueBatch({
      store,
      runRole,
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
        mode: options.noSkill ? "sqlite-judge-no-skill" : "sqlite-judge",
        ...(targetSplit ? { split: targetSplit } : {}),
        profile,
        model: sanitizedModel,
        promptDirectory: bundle.promptDir,
        inputSchemaVersion: maxTurns > 1 ? "v2-multiturn-json" : "v1-minimal-json",
      },
      skills: bundle.dialogueSkills,
      exportPolicy: effectiveSplit === "train"
        ? { format: "messages_jsonl", training_enabled: trainingEnabled }
        : {
            format: "messages_jsonl",
            split: effectiveSplit,
            purpose: effectiveSplit,
            training_enabled: false,
            eval_enabled: evalEnabled,
          },
      onProgress: options.onProgress,
    });

    let exportedPath: string | undefined;
    if (options.exportPath !== undefined) {
      const jsonl = store.exportRunJsonl(summary.runId, { systemPrompt: options.exportSystemPrompt });
      exportedPath = await writeOutputFile(nonEmpty(options.exportPath, "--export"), jsonl);
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
}

export async function runSynthExportWorkflow(options: SynthExportWorkflowOptions): Promise<Record<string, unknown>> {
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
    await writeOutputFile(outPath, trainJsonl);

    let valOutPath: string | undefined;
    let valSha256: string | undefined;
    if (options.valOutPath !== undefined) {
      valOutPath = resolveExportPath(nonEmpty(options.valOutPath, "--val-out"));
      const valJsonl = formatSamplesJsonl(merged.val.map((r) => r.sample));
      await writeOutputFile(valOutPath, valJsonl);
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
    }

    return report;
  } finally {
    store.close();
  }
}
