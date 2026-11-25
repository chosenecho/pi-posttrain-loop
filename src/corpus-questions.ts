import {
  computeQuestionQuota,
  loadVideoChunks,
  queryProcessedVideoIndex,
  type LoadedVideoUnit,
  type VideoUnit,
} from "./corpus.js";
import { DataMakerStore } from "./db.js";
import { createPiRunner, type PiConfig } from "./pi-runner.js";
import { createUnifiedSaveQuestionsTool, type SaveReceipt } from "./question-store.js";
import {
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "./retry.js";
import { errorMessage, validateConcurrency, validateSplit } from "./schema.js";
import { ensureVideoSplit } from "./splits.js";
import type { DatasetSplit } from "./types.js";

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

/**
 * Generates questions concurrently for a list of VideoUnits (merging multi-P parts into 1 material per video)
 * inside a single `question_generation` run, skipping cross-directory duplicate content by SHA-256.
 */
export async function runCorpusQuestionGeneration(
  options: RunCorpusQuestionsOptions,
): Promise<RunCorpusQuestionsSummary> {
  const { store, config, systemPrompt, skills, candidates } = options;
  const concurrency = validateConcurrency(options.concurrency);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? 1);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const targetSplit = options.split !== undefined ? validateSplit(options.split) : undefined;
  const force = Boolean(options.force);
  const { apiKey: _apiKey, ...sanitizedModel } = config;
  const { processedSha256s } = queryProcessedVideoIndex(store);

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

    const maxQuestions = computeQuestionQuota(
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
        shouldRetry: () => receipt === undefined,
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
            {
              maxQuestions,
            },
          );
          const output = await createPiRunner(config, [tool])({
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
            throw new Error(`模型未调用保存工具，尚未入库。模型输出：${output}`);
          }
          return output;
        },
        onRetry: (attempt, max, error) => {
          const delayText = callRetryDelayMs % 1000 === 0
            ? `${callRetryDelayMs / 1000}s`
            : `${callRetryDelayMs}ms`;
          options.onProgress?.(
            `[${loaded.videoId}] 出题调用失败（第 ${attempt}/${max} 次），${delayText} 后重试：${errorMessage(error)}`,
          );
        },
      });
      const savedReceipt = receipt!;
      store.finishModelCall(callId, result);
      savedTotal += savedReceipt.saved_count;
      skippedDupQuestions += savedReceipt.skipped_count;
      const qRows = store.db.prepare(
        "SELECT id FROM questions WHERE material_id = ? AND generation_run_id = ? ORDER BY id",
      ).all(material.id, runId) as Array<{ id: number }>;
      perVideoQuestionIds[index].push(...qRows.map((r) => Number(r.id)));
      options.onProgress?.(
        `[${loaded.videoId}] 完成（${loaded.partCount}P，${loaded.content.length}字，上限${maxQuestions}题）：新增 ${savedReceipt.saved_count} 题，跳过 ${savedReceipt.skipped_count} 题`,
      );
      return "processed";
    } catch (error) {
      const rawMsg = errorMessage(error);
      const finalMsg = callMaxAttempts > 1 ? `重试 ${callMaxAttempts} 次后仍失败：${rawMsg}` : rawMsg;
      const callRow = store.db.prepare("SELECT status FROM model_calls WHERE id = ?").get(callId) as { status: string };
      if (callRow.status === "running") {
        store.failModelCall(callId, finalMsg, { outputText: lastRawOutput ?? null });
      }
      errors++;
      options.onProgress?.(`[${loaded.videoId}] 错误${callMaxAttempts > 1 ? "（已丢弃本分块）" : ""}：${finalMsg}`);
      return "error";
    }
  }

  async function processVideo(unit: VideoUnit, index: number): Promise<void> {
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
  }

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < candidates.length) {
      const idx = nextIndex++;
      await processVideo(candidates[idx], idx);
    }
  }));

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
