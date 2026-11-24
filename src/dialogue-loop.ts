import { DataMakerStore, type TrainingMessage } from "./db.js";
import {
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "./retry.js";
import {
  errorMessage,
  nonEmpty,
  parseEvalRubric,
  parseFollowup,
  parseReview,
  validateConcurrency,
  validateMaxAttempts,
  validateSplit,
} from "./schema.js";
import type { DatasetSplit, DialogueRole, RoleRunner } from "./types.js";

export type LengthTier = "short" | "medium" | "long";

/**
 * Low-discrepancy 10-slot per-video turn schedule:
 * 30% single-turn (1), 50% two-turn (2), 20% three-turn (3).
 * Starts with 2 so single-question videos/fixtures default to 2 turns when maxTurns >= 2.
 */
export const TURN_DISTRIBUTION_CYCLE = [2, 1, 2, 3, 2, 1, 2, 3, 1, 2] as const;

/**
 * Low-discrepancy 4-slot length tier cycle:
 * 25% short (150–350 chars), 50% medium (400–750 chars), 25% long (800–1300 chars).
 * Rotating by turnNo also ensures two consecutive turns in a dialogue never repeat "long" or "short".
 */
export const LENGTH_TIER_CYCLE: readonly LengthTier[] = ["medium", "short", "medium", "long"] as const;

export const LENGTH_TIER_SPECS: Record<LengthTier, { label: string; minChars: number; maxChars: number }> = {
  short: {
    label: "short（150–350字：直奔结论、快刀斩乱麻，1–2个短自然段讲清核心判断，严禁超过400字）",
    minChars: 150,
    maxChars: 350,
  },
  medium: {
    label: "medium（400–750字：常规主力篇幅，2–3个自然段讲透一个核心机制或概念辨析，严禁超过850字）",
    minChars: 400,
    maxChars: 750,
  },
  long: {
    label: "long（800–1300字：深度展开多层拆解、流派对比与论证，控制在1400字以内）",
    minChars: 800,
    maxChars: 1300,
  },
};

export interface QuestionSchedulePlan {
  questionId: number;
  materialId: number;
  indexInMaterial: number;
  targetTurns: number;
  turnLengthTiers: LengthTier[];
}

/**
 * Assigns each question within a video (materialId) a target turn count (1:2:3 = 30%:50%:20%, capped by maxTurns)
 * and a per-turn answer length tier (short:medium:long = 25%:50%:25%).
 */
export function planQuestionSchedule(
  questions: Pick<LoadedQuestion, "id" | "materialId">[],
  options: { maxTurns: number; distributeTurns?: boolean },
): Map<number, QuestionSchedulePlan> {
  const maxTurns = options.maxTurns;
  const distributeTurns = Boolean(options.distributeTurns);
  const countByMaterial = new Map<number, number>();
  const plans = new Map<number, QuestionSchedulePlan>();

  for (const q of questions) {
    const idx = countByMaterial.get(q.materialId) ?? 0;
    countByMaterial.set(q.materialId, idx + 1);
    const rawTurns = distributeTurns
      ? TURN_DISTRIBUTION_CYCLE[idx % TURN_DISTRIBUTION_CYCLE.length]
      : maxTurns;
    const targetTurns = Math.max(1, Math.min(maxTurns, rawTurns));
    const turnLengthTiers: LengthTier[] = [];
    for (let turnNo = 1; turnNo <= targetTurns; turnNo++) {
      const tier = LENGTH_TIER_CYCLE[(idx + turnNo - 1) % LENGTH_TIER_CYCLE.length];
      turnLengthTiers.push(tier);
    }
    plans.set(q.id, {
      questionId: q.id,
      materialId: q.materialId,
      indexInMaterial: idx,
      targetTurns,
      turnLengthTiers,
    });
  }

  return plans;
}

export interface LoadedQuestion {
  id: number;
  materialId: number;
  videoId: string;
  materialContent: string;
  question: string;
}

export interface DialoguePrompts {
  answer: string;
  judge: string;
  followup?: string;
  rubric?: string;
}

export interface RunDialogueBatchOptions {
  store: DataMakerStore;
  runRole: RoleRunner;
  prompts: DialoguePrompts;
  maxAttempts: number;
  maxTurns: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  distributeTurns?: boolean;
  distributeLength?: boolean;
  config: Record<string, unknown>;
  skills?: unknown[];
  exportPolicy?: Record<string, unknown>;
  split?: DatasetSplit;
  videoId?: string;
  questionIds?: number[];
  onlyUnjudged?: boolean;
  onProgress?: (message: string) => void;
}

export interface RunDialogueBatchSummary {
  runId: number;
  questions: number;
  maxAttempts: number;
  maxTurns: number;
  concurrency: number;
  outcomes: Record<string, number>;
  results: number;
  errors: number;
  integrityOk: boolean;
  plannedTurnDistribution?: Record<number, number>;
  plannedLengthDistribution?: Record<LengthTier, number>;
  rubricsExtracted?: number;
  rubricErrors?: number;
}

export function loadTargetQuestions(
  store: DataMakerStore,
  filter: {
    videoId?: string;
    questionIds?: number[];
    onlyUnjudged?: boolean;
    maxTurns?: number;
    split?: DatasetSplit;
  },
): LoadedQuestion[] {
  const targetSplit = filter.split !== undefined ? validateSplit(filter.split) : undefined;
  let sql = `
    SELECT q.id, q.material_id, m.video_id, m.content, q.question
    FROM questions q
    JOIN materials m ON m.id = q.material_id
  `;
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filter.videoId !== undefined) {
    clauses.push("m.video_id = ?");
    params.push(filter.videoId);
  }
  if (filter.questionIds !== undefined && filter.questionIds.length > 0) {
    clauses.push(`q.id IN (${filter.questionIds.map(() => "?").join(", ")})`);
    params.push(...filter.questionIds);
  }
  if (filter.onlyUnjudged) {
    clauses.push(`NOT EXISTS (
      SELECT 1
      FROM run_items i
      JOIN runs r ON r.id = i.run_id
      WHERE i.question_id = q.id
        AND r.kind = 'answer_judge'
        AND r.max_turns = ?
        AND i.status IN ('pass', 'drop', 'exhausted')
    )`);
    params.push(filter.maxTurns ?? 1);
  }
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }
  sql += " ORDER BY q.material_id, q.id";

  const rows = store.db.prepare(sql).all(...params) as Array<{
    id: number;
    material_id: number;
    video_id: string;
    content: string;
    question: string;
  }>;

  const materialSplitMap = targetSplit !== undefined ? store.getMaterialVideoAndSplitMap() : undefined;

  return rows
    .filter((row) => {
      if (targetSplit === undefined || !materialSplitMap) return true;
      const matSplit = materialSplitMap.get(Number(row.material_id))?.split ?? "train";
      return matSplit === targetSplit;
    })
    .map((row) => ({
      id: Number(row.id),
      materialId: Number(row.material_id),
      videoId: row.video_id,
      materialContent: row.content,
      question: row.question,
    }));
}

/**
 * Unified SQLite-backed dialogue loop supporting both single-turn (maxTurns=1)
 * and turn-by-turn multi-turn (maxTurns>=2) generation with bounded per-question concurrency
 * and strict all-or-nothing results. No database write transaction is ever held while awaiting model network requests.
 */
export async function runDialogueBatch(options: RunDialogueBatchOptions): Promise<RunDialogueBatchSummary> {
  const { store, runRole } = options;
  const maxAttempts = validateMaxAttempts(options.maxAttempts);
  const concurrency = validateConcurrency(options.concurrency ?? 1);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? 1);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const maxTurns = options.maxTurns;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) {
    throw new Error("maxTurns 必须是 1–20 的整数");
  }
  const answerPrompt = nonEmpty(options.prompts.answer, "回答系统提示词");
  const judgePrompt = nonEmpty(options.prompts.judge, "质检系统提示词");
  const followupPrompt = maxTurns > 1
    ? nonEmpty(options.prompts.followup, "多轮追问系统提示词")
    : undefined;
  const rubricPrompt = options.prompts.rubric !== undefined
    ? nonEmpty(options.prompts.rubric, "评分要点系统提示词")
    : undefined;

  store.markInterruptedRuns();

  const questions = loadTargetQuestions(store, {
    videoId: options.videoId,
    questionIds: options.questionIds,
    onlyUnjudged: options.onlyUnjudged,
    maxTurns,
    split: options.split,
  });
  if (questions.length === 0) {
    throw new Error("未找到匹配的起始问题");
  }

  const promptSnapshot: Record<string, string> = {
    answer: answerPrompt,
    judge: judgePrompt,
    ...(followupPrompt !== undefined ? { followup: followupPrompt } : {}),
    ...(rubricPrompt !== undefined ? { rubric: rubricPrompt } : {}),
  };

  const distributeTurns = Boolean(options.distributeTurns);
  const distributeLength = Boolean(options.distributeLength);
  const scheduleByQuestion = planQuestionSchedule(questions, {
    maxTurns,
    distributeTurns,
  });

  const plannedTurnDistribution: Record<number, number> = {};
  const plannedLengthDistribution: Record<LengthTier, number> = { short: 0, medium: 0, long: 0 };
  for (const plan of scheduleByQuestion.values()) {
    plannedTurnDistribution[plan.targetTurns] = (plannedTurnDistribution[plan.targetTurns] ?? 0) + 1;
    for (const tier of plan.turnLengthTiers) {
      plannedLengthDistribution[tier]++;
    }
  }

  const runId = store.createRun({
    kind: "answer_judge",
    maxAttempts,
    maxTurns,
    config: {
      ...options.config,
      concurrency,
      ...(callMaxAttempts > 1 ? { callMaxAttempts, callRetryDelayMs } : {}),
      ...(options.onlyUnjudged ? { onlyUnjudged: true } : {}),
      ...(distributeTurns ? { distributeTurns: true, plannedTurnDistribution } : {}),
      ...(distributeLength ? { distributeLength: true, plannedLengthDistribution } : {}),
    },
    prompts: promptSnapshot,
    skills: options.skills ?? [],
    exportPolicy: options.exportPolicy ?? { format: "messages_jsonl", training_enabled: false },
  });

  const runItemIdByQuestion = store.createRunItems(runId, questions.map((q) => q.id));
  let itemErrors = 0;
  let rubricsExtracted = 0;
  let rubricErrors = 0;

  // Per-(materialId, role) warmup gate so concurrent workers on a brand-new video
  // let the first material-bearing call populate the upstream KV prefix cache before fanning out.
  const warmupGates = new Map<string, Promise<void>>();

  async function withMaterialWarmup<T>(
    materialId: number,
    role: "answer" | "judge" | "followup" | "rubric",
    fn: () => Promise<T>,
  ): Promise<T> {
    if (concurrency <= 1 || (role !== "answer" && role !== "followup" && role !== "rubric")) {
      return fn();
    }
    const key = `${materialId}:${role}`;
    const existing = warmupGates.get(key);
    if (existing) {
      await existing;
      return fn();
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    warmupGates.set(key, gate);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function invokeTracked<T>(params: {
    role: "answer" | "judge" | "followup";
    materialId: number;
    systemPrompt: string;
    turnId: number;
    attemptId?: number;
    inputRefs: Record<string, unknown>;
    wireInput: Record<string, unknown>;
    parse: (raw: string) => T;
    progressPrefix: string;
  }): Promise<{ callId: number; output: string; parsed: T }> {
    const callId = store.startModelCall({
      runId,
      role: params.role,
      turnId: params.turnId,
      attemptId: params.attemptId ?? null,
      inputRefs: params.inputRefs,
    });
    let lastRawOutput: string | undefined;
    try {
      const result = await runWithRetry({
        maxAttempts: callMaxAttempts,
        delayMs: callRetryDelayMs,
        run: async () => {
          lastRawOutput = undefined;
          const output = await withMaterialWarmup(params.materialId, params.role, () =>
            runRole({
              role: params.role,
              systemPrompt: params.systemPrompt,
              input: params.wireInput,
            }),
          );
          lastRawOutput = output;
          const parsed = params.parse(output);
          return { callId, output, parsed };
        },
        onRetry: (attempt, max, error) => {
          const delayText = callRetryDelayMs % 1000 === 0
            ? `${callRetryDelayMs / 1000}s`
            : `${callRetryDelayMs}ms`;
          options.onProgress?.(
            `${params.progressPrefix} ${params.role} 调用失败（第 ${attempt}/${max} 次），${delayText} 后重试：${errorMessage(error)}`,
          );
        },
      });
      return result;
    } catch (error) {
      const rawMsg = errorMessage(error);
      const finalMsg = callMaxAttempts > 1 ? `重试 ${callMaxAttempts} 次后仍失败：${rawMsg}` : rawMsg;
      store.failModelCall(callId, finalMsg, { outputText: lastRawOutput ?? null });
      throw new Error(finalMsg);
    }
  }

  async function processQuestion(item: LoadedQuestion): Promise<void> {
    const runItemId = runItemIdByQuestion.get(item.id)!;
    const plan = scheduleByQuestion.get(item.id)!;
    const questionMaxTurns = plan.targetTurns;
    store.startRunItem(runItemId);

    const historyMessages: TrainingMessage[] = [];
    const historyRefs: Array<{ turn_id: number; attempt_id: number }> = [];
    let currentUserContent = item.question;
    let itemFailed = false;
    let passedResultId: number | undefined;

    for (let turnNo = 1; turnNo <= questionMaxTurns; turnNo++) {
      const turnLengthTier = plan.turnLengthTiers[turnNo - 1] ?? "medium";
      const targetLengthLabel = LENGTH_TIER_SPECS[turnLengthTier].label;
      const turnId = store.createTurn({
        runItemId,
        turnNo,
        ...(turnNo > 1 ? { userContent: currentUserContent } : {}),
      });

      let previousAttemptId: number | undefined;
      let previousAnswer = "";
      let feedback = "";
      let turnPassedAttemptId: number | undefined;
      let turnPassedAnswer = "";

      for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
        const attemptId = store.startAttempt({ turnId, attemptNo });

        const answerInputRefs: Record<string, unknown> = {
          material: { material_id: item.materialId, field: "content" },
          ...(turnNo === 1
            ? { question: { question_id: item.id, field: "question" } }
            : { history: [...historyRefs], user: { turn_id: turnId, field: "user_content" } }),
          ...(distributeLength ? { targetLength: turnLengthTier } : {}),
          ...(attemptNo > 1 && previousAttemptId !== undefined
            ? {
                previousAnswer: { attempt_id: previousAttemptId, field: "answer" },
                feedback: { attempt_id: previousAttemptId, field: "feedback" },
              }
            : {}),
        };

        // Keep stable prefix fields (material -> history) ahead of turn-specific fields for better KV prefix cache reuse.
        const answerWireInput: Record<string, unknown> = {
          material: item.materialContent,
          ...(historyMessages.length > 0 ? { history: [...historyMessages] } : {}),
          question: currentUserContent,
          ...(distributeLength ? { targetLength: targetLengthLabel } : {}),
          ...(attemptNo > 1 ? { previousAnswer, feedback } : {}),
        };

        const attemptTag = `[q${item.id}:t${turnNo}/${questionMaxTurns}:a${attemptNo}]`;
        let answerText: string;
        try {
          const answerCall = await invokeTracked({
            role: "answer",
            materialId: item.materialId,
            systemPrompt: answerPrompt,
            turnId,
            attemptId,
            inputRefs: answerInputRefs,
            wireInput: answerWireInput,
            parse: (raw) => nonEmpty(raw, "回答"),
            progressPrefix: attemptTag,
          });
          answerText = answerCall.parsed;
          store.transaction(() => {
            store.finishModelCall(answerCall.callId, answerCall.output);
            store.recordAttemptAnswer(attemptId, answerText);
          });
        } catch (error) {
          const msg = errorMessage(error);
          store.transaction(() => {
            store.finishAttemptError(attemptId, msg);
            store.finishTurnNonPass(turnId, "error", { error: msg });
            store.finishRunItemNonPass(runItemId, "error", { error: msg });
          });
          itemErrors++;
          itemFailed = true;
          options.onProgress?.(`${attemptTag} answer error${callMaxAttempts > 1 ? "（已丢弃本题）" : ""}: ${msg}`);
          break;
        }

        const judgeInputRefs: Record<string, unknown> = {
          ...(turnNo === 1
            ? { question: { question_id: item.id, field: "question" } }
            : { history: [...historyRefs], user: { turn_id: turnId, field: "user_content" } }),
          ...(distributeLength ? { targetLength: turnLengthTier } : {}),
          answer: { attempt_id: attemptId, field: "answer" },
        };
        const judgeWireInput: Record<string, unknown> = {
          ...(historyMessages.length > 0 ? { history: [...historyMessages] } : {}),
          question: currentUserContent,
          ...(distributeLength ? { targetLength: targetLengthLabel } : {}),
          answer: answerText,
        };

        try {
          const judgeCall = await invokeTracked({
            role: "judge",
            materialId: item.materialId,
            systemPrompt: judgePrompt,
            turnId,
            attemptId,
            inputRefs: judgeInputRefs,
            wireInput: judgeWireInput,
            parse: parseReview,
            progressPrefix: attemptTag,
          });
          const review = judgeCall.parsed;

          const isFinalTurn = turnNo === questionMaxTurns;
          const exhaustedBudget = review.decision === "revise" && attemptNo === maxAttempts;

          const committed = store.commitJudgeOutcome({
            runItemId,
            turnId,
            turnNo,
            attemptId,
            judgeCallId: judgeCall.callId,
            judgeOutputText: judgeCall.output,
            review,
            isFinalTurn,
            exhaustedBudget,
          });
          if (committed.resultId !== undefined) {
            passedResultId = committed.resultId;
          }

          const tierTag = distributeLength ? `:${turnLengthTier}(${answerText.length}字)` : "";
          options.onProgress?.(`[q${item.id}:t${turnNo}/${questionMaxTurns}:a${attemptNo}${tierTag}] ${review.decision}`);

          if (review.decision === "pass") {
            turnPassedAttemptId = attemptId;
            turnPassedAnswer = answerText;
            break;
          }
          if (review.decision === "drop" || exhaustedBudget) {
            itemFailed = true;
            break;
          }
          previousAttemptId = attemptId;
          previousAnswer = answerText;
          feedback = review.feedback;
        } catch (error) {
          const msg = errorMessage(error);
          store.transaction(() => {
            store.finishAttemptError(attemptId, msg);
            store.finishTurnNonPass(turnId, "error", { error: msg });
            store.finishRunItemNonPass(runItemId, "error", { error: msg });
          });
          itemErrors++;
          itemFailed = true;
          options.onProgress?.(`${attemptTag} judge error${callMaxAttempts > 1 ? "（已丢弃本题）" : ""}: ${msg}`);
          break;
        }
      }

      if (itemFailed || turnPassedAttemptId === undefined) {
        break;
      }

      historyMessages.push(
        { role: "user", content: currentUserContent },
        { role: "assistant", content: turnPassedAnswer },
      );
      historyRefs.push({ turn_id: turnId, attempt_id: turnPassedAttemptId });

      // Generate next turn's user message when questionMaxTurns > turnNo
      if (turnNo < questionMaxTurns) {
        const turnTag = `[q${item.id}:t${turnNo}/${questionMaxTurns}]`;
        try {
          const call = await invokeTracked({
            role: "followup",
            materialId: item.materialId,
            systemPrompt: followupPrompt!,
            turnId,
            inputRefs: {
              material: { material_id: item.materialId, field: "content" },
              history: [...historyRefs],
            },
            wireInput: {
              material: item.materialContent,
              history: [...historyMessages],
            },
            parse: parseFollowup,
            progressPrefix: turnTag,
          });
          const decision = call.parsed;
          store.finishModelCall(call.callId, call.output);
          if (decision.action === "stop") {
            passedResultId = store.finalizePassedRunItem(runItemId, turnNo);
            options.onProgress?.(`${turnTag} followup stop -> finalized (${turnNo} turns)`);
            break;
          }
          currentUserContent = decision.user;
        } catch (error) {
          const msg = errorMessage(error);
          store.transaction(() => {
            store.finishRunItemNonPass(runItemId, "error", { error: msg });
          });
          itemErrors++;
          options.onProgress?.(`${turnTag} followup error${callMaxAttempts > 1 ? "（已丢弃本题）" : ""}: ${msg}`);
          break;
        }
      }
    }

    if (!itemFailed && passedResultId !== undefined && rubricPrompt !== undefined) {
      const totalPassedTurns = historyMessages.length / 2;
      for (let tIdx = 0; tIdx < totalPassedTurns; tIdx++) {
        const turnNo = tIdx + 1;
        const turnUser = historyMessages[tIdx * 2].content;
        const turnAssistant = historyMessages[tIdx * 2 + 1].content;
        const priorHistory = historyMessages.slice(0, tIdx * 2);
        const rubricTag = `[q${item.id}:t${turnNo}/${totalPassedTurns}:rubric]`;
        const wireInput: Record<string, unknown> = {
          material: item.materialContent,
          ...(priorHistory.length > 0 ? { history: priorHistory } : {}),
          question: turnUser,
          referenceAnswer: turnAssistant,
        };
        const callId = store.startEvalModelCall({
          resultId: passedResultId,
          turnNo,
          role: "rubric",
          input: {
            material_id: item.materialId,
            result_id: passedResultId,
            turn_no: turnNo,
            question: turnUser,
          },
        });
        let lastOutput: string | undefined;
        try {
          const parsedRubric = await runWithRetry({
            maxAttempts: callMaxAttempts,
            delayMs: callRetryDelayMs,
            run: async () => {
              lastOutput = undefined;
              const out = await withMaterialWarmup(item.materialId, "rubric", () =>
                runRole({
                  role: "rubric",
                  systemPrompt: rubricPrompt,
                  input: wireInput,
                }),
              );
              lastOutput = out;
              return { out, rubric: parseEvalRubric(out) };
            },
            onRetry: (attempt, max, error) => {
              options.onProgress?.(
                `${rubricTag} rubric 抽取失败（第 ${attempt}/${max} 次），重试：${errorMessage(error)}`,
              );
            },
          });
          store.transaction(() => {
            store.finishEvalModelCall(callId, parsedRubric.out);
            store.upsertEvalRubric({
              resultId: passedResultId!,
              turnNo,
              rubric: parsedRubric.rubric,
              callId,
            });
          });
          rubricsExtracted++;
          options.onProgress?.(`${rubricTag} extracted (${parsedRubric.rubric.keyPoints.length} keyPoints)`);
        } catch (error) {
          const msg = errorMessage(error);
          store.failEvalModelCall(callId, msg, { outputText: lastOutput ?? null });
          rubricErrors++;
          options.onProgress?.(`${rubricTag} rubric error: ${msg}`);
        }
      }
    }
  }

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, questions.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < questions.length) {
      const item = questions[nextIndex++];
      await processQuestion(item);
    }
  });
  await Promise.all(workers);

  store.finishRun(runId, "completed");
  const outcomes = store.queryOutcomeCounts(runId);
  const results = store.exportRunSamples(runId).length;
  const integrity = store.checkIntegrity();

  return {
    runId,
    questions: questions.length,
    maxAttempts,
    maxTurns,
    concurrency,
    outcomes,
    results,
    errors: itemErrors,
    integrityOk: integrity.ok,
    ...(distributeTurns ? { plannedTurnDistribution } : {}),
    ...(distributeLength ? { plannedLengthDistribution } : {}),
    ...(rubricPrompt !== undefined ? { rubricsExtracted, rubricErrors } : {}),
  };
}
