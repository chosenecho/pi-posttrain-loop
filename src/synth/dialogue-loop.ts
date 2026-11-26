import { createWarmupGate, runConcurrentPool } from "../shared/concurrency.js";
import { publicErrorMessage, toPublicError } from "../shared/public-error.js";
import {
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../shared/retry.js";
import {
  nonEmpty,
  parseEvalRubric,
  parseFollowup,
  parseReview,
  validateConcurrency,
  validateMaxAttempts,
  validateMaxTurns,
} from "../shared/schema.js";
import type { DatasetSplit, RoleRunner, TrainingMessage } from "../shared/types.js";
import type { DataMakerStore, TargetQuestionRow } from "./store/index.js";

export type LoadedQuestion = TargetQuestionRow;

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
  return store.queryTargetQuestions(filter);
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
  const maxTurns = validateMaxTurns(options.maxTurns);

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

  const runId = store.createRun({
    kind: "answer_judge",
    maxAttempts,
    maxTurns,
    config: {
      ...options.config,
      concurrency,
      ...(callMaxAttempts > 1 ? { callMaxAttempts, callRetryDelayMs } : {}),
      ...(options.onlyUnjudged ? { onlyUnjudged: true } : {}),
    },
    prompts: promptSnapshot,
    skills: options.skills ?? [],
    exportPolicy: options.exportPolicy ?? { format: "messages_jsonl", training_enabled: false },
  });

  const runItemIdByQuestion = store.createRunItems(runId, questions.map((q) => q.id));
  let itemErrors = 0;
  let rubricsExtracted = 0;
  let rubricErrors = 0;

  const warmupGate = createWarmupGate();
  const warmupEnabled = concurrency > 1;

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
          const output = await warmupGate.run(`${params.materialId}:${params.role}`, warmupEnabled, () =>
            runRole({
              role: params.role,
              systemPrompt: params.systemPrompt,
              input: params.wireInput,
            }),
          );
          lastRawOutput = output;
          try {
            const parsed = params.parse(output);
            return { callId, output, parsed };
          } catch (error) {
            throw toPublicError(error, "model_output_invalid");
          }
        },
        onRetry: (attempt, max, error) => {
          const delayText = callRetryDelayMs % 1000 === 0
            ? `${callRetryDelayMs / 1000}s`
            : `${callRetryDelayMs}ms`;
          options.onProgress?.(
            `${params.progressPrefix} ${params.role} 调用失败（第 ${attempt}/${max} 次），${delayText} 后重试：${publicErrorMessage(error)}`,
          );
        },
      });
      return result;
    } catch (error) {
      const publicMsg = publicErrorMessage(error);
      const finalMsg = callMaxAttempts > 1 ? `重试 ${callMaxAttempts} 次后仍失败：${publicMsg}` : publicMsg;
      store.failModelCall(callId, finalMsg, { outputText: lastRawOutput ?? null });
      throw toPublicError(error);
    }
  }

  async function processQuestion(item: LoadedQuestion): Promise<void> {
    const runItemId = runItemIdByQuestion.get(item.id)!;
    store.startRunItem(runItemId);

    const historyMessages: TrainingMessage[] = [];
    const historyRefs: Array<{ turn_id: number; attempt_id: number }> = [];
    let currentUserContent = item.question;
    let itemFailed = false;
    let passedResultId: number | undefined;

    for (let turnNo = 1; turnNo <= maxTurns; turnNo++) {
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
          ...(attemptNo > 1 && previousAttemptId !== undefined
            ? {
                previousAnswer: { attempt_id: previousAttemptId, field: "answer" },
                feedback: { attempt_id: previousAttemptId, field: "feedback" },
              }
            : {}),
        };

        const answerWireInput: Record<string, unknown> = {
          material: item.materialContent,
          ...(historyMessages.length > 0 ? { history: [...historyMessages] } : {}),
          question: currentUserContent,
          ...(attemptNo > 1 ? { previousAnswer, feedback } : {}),
        };

        const attemptTag = `[q${item.id}:t${turnNo}/${maxTurns}:a${attemptNo}]`;
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
          const msg = publicErrorMessage(error);
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
          material: { material_id: item.materialId, field: "content" },
          ...(turnNo === 1
            ? { question: { question_id: item.id, field: "question" } }
            : { history: [...historyRefs], user: { turn_id: turnId, field: "user_content" } }),
          answer: { attempt_id: attemptId, field: "answer" },
        };
        const judgeWireInput: Record<string, unknown> = {
          material: item.materialContent,
          ...(historyMessages.length > 0 ? { history: [...historyMessages] } : {}),
          question: currentUserContent,
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

          const isFinalTurn = turnNo === maxTurns;
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

          options.onProgress?.(`[q${item.id}:t${turnNo}/${maxTurns}:a${attemptNo}(${answerText.length}字)] ${review.decision}`);

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
          const msg = publicErrorMessage(error);
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

      if (turnNo < maxTurns) {
        const turnTag = `[q${item.id}:t${turnNo}/${maxTurns}]`;
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
          const msg = publicErrorMessage(error);
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
              const out = await warmupGate.run(`${item.materialId}:rubric`, warmupEnabled, () =>
                runRole({
                  role: "rubric",
                  systemPrompt: rubricPrompt,
                  input: wireInput,
                }),
              );
              lastOutput = out;
              try {
                return { out, rubric: parseEvalRubric(out) };
              } catch (error) {
                throw toPublicError(error, "model_output_invalid");
              }
            },
            onRetry: (attempt, max, error) => {
              options.onProgress?.(
                `${rubricTag} rubric 抽取失败（第 ${attempt}/${max} 次），重试：${publicErrorMessage(error)}`,
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
          const msg = publicErrorMessage(error);
          store.failEvalModelCall(callId, msg, { outputText: lastOutput ?? null });
          rubricErrors++;
          options.onProgress?.(`${rubricTag} rubric error: ${msg}`);
        }
      }
    }
  }

  await runConcurrentPool(questions, concurrency, (item) => processQuestion(item));

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
    ...(rubricPrompt !== undefined ? { rubricsExtracted, rubricErrors } : {}),
  };
}
