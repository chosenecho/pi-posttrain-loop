import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runConcurrentPool } from "../shared/concurrency.js";
import { createPiRunner, sanitizePiConfig, type PiConfig } from "../shared/pi-runner.js";
import { PublicError, publicErrorMessage } from "../shared/public-error.js";
import {
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../shared/retry.js";
import { validateConcurrency, validateSplit } from "../shared/schema.js";
import { TRAIN_SUITE_PROFILES, type DatasetSplit, type RoleRunner } from "../shared/types.js";
import {
  computeQuestionQuota,
  loadVideoChunks,
  queryProcessedVideoIndex,
  type LoadedVideoUnit,
  type VideoUnit,
} from "./corpus.js";
import { createUnifiedSaveQuestionsTool, type SaveReceipt } from "./question-store.js";
import { ensureVideoSplit } from "./splits.js";
import type { DataMakerStore } from "./store/index.js";

export interface RunCorpusQuestionsOptions {
  store: DataMakerStore;
  config: PiConfig;
  systemPrompt: string;
  skills: Array<Record<string, unknown>>;
  candidates: VideoUnit[];
  concurrency: number;
  split?: DatasetSplit;
  profile?: string;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  force?: boolean;
  maxQuestionsPerVideo?: number;
  maxChunkChars?: number;
  /** Optional injectable runner factory for unit tests. */
  createRunner?: (tools: AgentTool[]) => RoleRunner;
  onProgress?: (message: string) => void;
}

export interface RunCorpusQuestionsSummary {
  runId: number;
  selectedVideos: number;
  processedVideos: number;
  skippedBySha256: number;
  savedQuestions: number;
  skippedDuplicateQuestions: number;
  generatedQuestionIds: number[];
  errors: number;
  integrityOk: boolean;
}

export async function runCorpusQuestionGeneration(
  options: RunCorpusQuestionsOptions,
): Promise<RunCorpusQuestionsSummary> {
  const { store, config, systemPrompt, skills, candidates } = options;
  const concurrency = validateConcurrency(options.concurrency);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? 1);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const targetSplit = options.split !== undefined ? validateSplit(options.split) : undefined;
  const force = Boolean(options.force);
  const sanitizedModel = sanitizePiConfig(config);
  const { processedSha256s } = queryProcessedVideoIndex(store, options.profile);

  for (const unit of candidates) {
    ensureVideoSplit(store, unit.videoId, targetSplit ? { preferredSplit: targetSplit } : {});
  }

  const runId = store.createRun({
    kind: "question_generation",
    maxAttempts: 1,
    maxTurns: 1,
    config: {
      model: sanitizedModel,
      concurrency,
      ...(targetSplit ? { split: targetSplit } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      ...(callMaxAttempts > 1 ? { callMaxAttempts, callRetryDelayMs } : {}),
      videoCount: candidates.length,
      inputSchemaVersion: "v2-video-merged-tool",
    },
    prompts: { question: systemPrompt },
    skills,
    exportPolicy: {
      format: "messages_jsonl",
      ...(targetSplit ? { split: targetSplit } : {}),
      training_enabled: false,
    },
  });

  let processed = 0;
  let skippedBySha = 0;
  let savedTotal = 0;
  let skippedDupQuestions = 0;
  let errors = 0;
  const seenBatchSha256 = new Set<string>(force ? [] : processedSha256s);
  const perVideoQuestionIds: number[][] = Array.from({ length: candidates.length }, () => []);

  async function processChunk(loaded: LoadedVideoUnit, index: number): Promise<"processed" | "skipped" | "error"> {
    if (!force && seenBatchSha256.has(loaded.sha256)) {
      skippedBySha++;
      options.onProgress?.(`[${loaded.videoId}] 跳过（全文指纹与已处理视频完全相同）`);
      return "skipped";
    }
    seenBatchSha256.add(loaded.sha256);

    const isSkillDrivenProfile = options.profile !== undefined
      && (TRAIN_SUITE_PROFILES as readonly string[]).includes(options.profile.trim().toLowerCase());
    // For the 5-profile Skill-driven suite, question count is controlled by each profile's
    // question-design Skill; code only enforces a runaway safety ceiling (or explicit --max-questions).
    const maxQuestions = isSkillDrivenProfile
      ? (options.maxQuestionsPerVideo ?? 8)
      : computeQuestionQuota(
          loaded.content.length,
          loaded.partCount,
          options.maxQuestionsPerVideo,
        );

    const material = store.upsertMaterial({
      videoId: loaded.videoId,
      content: loaded.content,
      sourcePath: loaded.sourcePath,
    });

    const callId = store.startModelCall({
      runId,
      role: "question",
      materialId: material.id,
      inputRefs: {
        material: { material_id: material.id, field: "content" },
        video_id: loaded.videoId,
        part_count: loaded.partCount,
        max_questions: maxQuestions,
      },
    });

    let receipt: SaveReceipt | undefined;
    let lastRawOutput: string | undefined;
    try {
      const result = await runWithRetry({
        maxAttempts: callMaxAttempts,
        delayMs: callRetryDelayMs,
        run: async () => {
          receipt = undefined;
          lastRawOutput = undefined;
          const tool = createUnifiedSaveQuestionsTool(
            store,
            material.id,
            loaded.videoId,
            runId,
            (savedReceipt) => {
              receipt = savedReceipt;
            },
            { maxQuestions, profile: options.profile },
          );
          const runner = options.createRunner
            ? options.createRunner([tool])
            : createPiRunner(config, [tool]);
          const output = await runner({
            role: "question",
            systemPrompt,
            input: {
              video_id: loaded.videoId,
              part_count: loaded.partCount,
              max_questions: maxQuestions,
              transcript: material.content,
            },
          });
          lastRawOutput = output;
          if (!receipt) {
            throw new PublicError("model_save_tool_missing");
          }
          return output;
        },
        onRetry: (attempt, max, error) => {
          const delayText = callRetryDelayMs % 1000 === 0
            ? `${callRetryDelayMs / 1000}s`
            : `${callRetryDelayMs}ms`;
          options.onProgress?.(
            `[${loaded.videoId}][question:call:${callId}] 出题调用失败（第 ${attempt}/${max} 次），${delayText} 后重试：${publicErrorMessage(error)}`,
          );
        },
      });
      const savedReceipt = receipt!;
      store.finishModelCall(callId, result);
      savedTotal += savedReceipt.saved_count;
      skippedDupQuestions += savedReceipt.skipped_count;
      perVideoQuestionIds[index].push(...store.listQuestionIdsForMaterialRun(material.id, runId));
      options.onProgress?.(
        `[${loaded.videoId}] 完成（${loaded.partCount}P，${loaded.content.length}字，上限${maxQuestions}题）：新增 ${savedReceipt.saved_count} 题，跳过 ${savedReceipt.skipped_count} 题`,
      );
      return "processed";
    } catch (error) {
      const rawMsg = publicErrorMessage(error);
      const finalMsg = callMaxAttempts > 1 ? `重试 ${callMaxAttempts} 次后仍失败：${rawMsg}` : rawMsg;
      if (store.getModelCallStatus(callId) === "running") {
        store.failModelCall(callId, finalMsg, { outputText: lastRawOutput ?? null });
      }
      errors++;
      options.onProgress?.(`[${loaded.videoId}][question:call:${callId}] 错误${callMaxAttempts > 1 ? "（已丢弃本分块）" : ""}：${finalMsg}`);
      return "error";
    }
  }

  await runConcurrentPool(candidates, concurrency, async (unit, index) => {
    const chunks = await loadVideoChunks(unit, { maxChunkChars: options.maxChunkChars });
    if (chunks.length > 1) {
      options.onProgress?.(`[${unit.videoId}] 多P长合集（共${unit.partPaths.length}P）自动切分为 ${chunks.length} 个分块处理`);
    }
    let anyProcessed = false;
    for (const chunk of chunks) {
      const status = await processChunk(chunk, index);
      if (status === "processed") anyProcessed = true;
    }
    if (anyProcessed) {
      processed++;
    }
  });

  store.finishRun(runId, processed === 0 && errors > 0 ? "error" : "completed", {
    error: errors > 0 ? `${errors} 个视频出题失败` : null,
  });

  const generatedQuestionIds: number[] = [];
  const seenIds = new Set<number>();
  for (const ids of perVideoQuestionIds) {
    for (const id of ids) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        generatedQuestionIds.push(id);
      }
    }
  }

  return {
    runId,
    selectedVideos: candidates.length,
    processedVideos: processed,
    skippedBySha256: skippedBySha,
    savedQuestions: savedTotal,
    skippedDuplicateQuestions: skippedDupQuestions,
    generatedQuestionIds,
    errors,
    integrityOk: store.checkIntegrity().ok,
  };
}
