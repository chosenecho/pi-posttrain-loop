import { combineSignals, rethrowIfAborted, throwIfAborted } from "../shared/cancellation.js";
import { runConcurrentPool } from "../shared/concurrency.js";
import { publicErrorMessage, toPublicError } from "../shared/public-error.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../shared/retry.js";
import { nonEmpty, validateConcurrency } from "../shared/schema.js";
import type { RoleRunner } from "../shared/types.js";
import { extractSuiteDialogueTurns } from "./eval-runner.js";
import { EvaluationSpecError, readEvaluationSpec } from "./evaluation-spec.js";
import { scoreGradedTurn } from "./grader-core.js";
import { parseGradeResult } from "./probe-schema.js";
import { EvalStore, type SuiteItemRecord, type SuiteRubricEntry } from "./store/index.js";

function getTurnRubric(item: SuiteItemRecord, turnNo: number): SuiteRubricEntry {
  const entry = item.rubrics.find((r) => r.turnNo === turnNo) ?? item.rubrics[turnNo - 1];
  if (!entry || !entry.rubric) {
    throw new Error(`套卷条目 ${item.itemKey} Turn ${turnNo} 缺少评分卡`);
  }
  return entry;
}

function extractPriorHistory(
  input: Record<string, unknown>,
): Array<{ role: "user" | "assistant"; content: string }> {
  const rawMessages = input.messages;
  if (!Array.isArray(rawMessages)) return [];
  const nonSystem = rawMessages.filter(
    (m): m is { role: "user" | "assistant"; content: string } =>
      typeof m === "object" &&
      m !== null &&
      ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
      typeof (m as { content?: unknown }).content === "string",
  );
  return nonSystem.length > 1 ? nonSystem.slice(0, -1) : [];
}

export interface GradeEvalRunOptions {
  evalStore: EvalStore;
  evalRunId: number;
  graderPrompt: string;
  runGrader: RoleRunner;
  graderModelId: string;
  allowSameModel?: boolean;
  regrade?: boolean;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface GradeEvalRunSummary {
  evalRunId: number;
  suiteName: string;
  candidate: string;
  candidateModel: string;
  graderModelId: string;
  sameModelNotice: boolean;
  totalPredictions: number;
  gradedTurns: number;
  skippedAlreadyGraded: number;
  skippedErroredPredictions: number;
  errors: number;
  meanTurnScore: number;
  turnBehaviorPassRate: number;
  totalGraderCalls: number;
}

/**
 * Grades all valid candidate predictions of an `eval_run` against frozen suite rubrics
 * using holistic scoring with the behavior/hallucination safety cap (40).
 */
export async function gradeEvalRun(options: GradeEvalRunOptions): Promise<GradeEvalRunSummary> {
  const { evalStore, evalRunId, runGrader } = options;
  const graderPrompt = nonEmpty(options.graderPrompt, "eval-grader 系统提示词");
  const graderModelId = nonEmpty(options.graderModelId, "批卷模型名称");
  const concurrency = validateConcurrency(options.concurrency ?? 4);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const evalRun = evalStore.getEvalRun(evalRunId);
  if (!evalRun) {
    throw new Error(`未找到评测运行：eval_run #${evalRunId}`);
  }

  const spec = readEvaluationSpec(evalRun);
  if (!spec) throw new EvaluationSpecError("legacy_spec_incomplete", "旧运行缺少完整评测规格，保留只读");
  const suite = evalStore.getSuite(evalRun.suiteName);
  if (!suite || suite.id !== spec.suiteId || suite.sha256 !== spec.suiteSha256 || evalRun.model !== spec.modelId ||
      evalRun.candidate !== spec.candidate || evalRun.historyMode !== spec.historyMode || evalRun.systemPrompt !== spec.systemPrompt) {
    throw new EvaluationSpecError("evaluation_spec_invalid", "运行或套卷与评测规格身份不一致");
  }
  const signal = combineSignals(evalStore.signal, options.signal);
  throwIfAborted(signal);

  const sameModelNotice = graderModelId.trim().toLowerCase() === spec.modelId.trim().toLowerCase();
  if (sameModelNotice && !options.allowSameModel) {
    throw new Error(
      `批卷守卫拦截：批卷模型（${graderModelId}）与被测候选模型（${evalRun.model}）相同。` +
        `请通过 --grader-model / EVAL_LLM_MODEL 指定不同裁判模型；如仅作联调，请显式传入 --allow-same-model`,
    );
  }

  const suiteItems = evalStore.listSuiteItems(evalRun.suiteId);
  const itemById = new Map<number, SuiteItemRecord>();
  const turnsByItemId = new Map<number, ReturnType<typeof extractSuiteDialogueTurns>>();
  for (const item of suiteItems) {
    itemById.set(item.id, item);
    turnsByItemId.set(item.id, extractSuiteDialogueTurns(item));
  }

  const predictions = evalStore.listEvalPredictions(evalRunId);
  if (predictions.length === 0) {
    throw new Error(`eval_run #${evalRunId} 尚无候选模型预测记录`);
  }

  const existingScoredPredIds = new Set<number>();
  if (!options.regrade) {
    for (const sc of evalStore.listEvalScores(evalRunId)) {
      existingScoredPredIds.add(sc.predictionId);
    }
  }

  let skippedAlreadyGraded = 0;
  let skippedErroredPredictions = 0;
  const toGrade = predictions.filter((pred) => {
    if (pred.error !== null || pred.outputText === null || !pred.outputText.trim()) {
      skippedErroredPredictions++;
      return false;
    }
    if (existingScoredPredIds.has(pred.id)) {
      skippedAlreadyGraded++;
      return false;
    }
    return true;
  });

  const selectedItemIds = new Set(spec.itemIds);
  for (const itemId of selectedItemIds) {
    if (!itemById.has(itemId)) throw new EvaluationSpecError("evaluation_spec_invalid", `规格包含套卷外条目 #${itemId}`);
  }
  // Validate the entire dispatch set before any worker can contact a grader.
  for (const prediction of toGrade) {
    const item = itemById.get(prediction.suiteItemId);
    if (!item || !selectedItemIds.has(item.id) || !turnsByItemId.get(item.id)?.some((turn) => turn.turnNo === prediction.turnNo)) {
      throw new EvaluationSpecError("evaluation_spec_invalid", `预测 #${prediction.id} 不属于本次规格的套卷条目或对话轮`);
    }
    getTurnRubric(item, prediction.turnNo);
  }

  const runRef = `eval_run:${evalRunId}`;
  let newlyGraded = 0;
  let errors = 0;

  await runConcurrentPool(toGrade, concurrency, async (pred, idx, workerSignal) => {
    throwIfAborted(workerSignal);
    const item = itemById.get(pred.suiteItemId);
    if (!item) {
      errors++;
      options.onProgress?.(`[grade ${idx + 1}/${toGrade.length}] 缺少 suite_item #${pred.suiteItemId}`);
      return;
    }
    const turns = turnsByItemId.get(item.id)!;
    const turn = turns.find((t) => t.turnNo === pred.turnNo);
    if (!turn) {
      errors++;
      options.onProgress?.(`[grade ${idx + 1}/${toGrade.length}] ${item.itemKey} 缺少 Turn ${pred.turnNo}`);
      return;
    }

    const rubricEntry = getTurnRubric(item, pred.turnNo);
    const history = extractPriorHistory(pred.input);
    const tag = `[${idx + 1}/${toGrade.length} ${item.itemKey}:t${pred.turnNo}]`;

    const gradeInput: Record<string, unknown> = {
      question: turn.user,
      ...(history.length > 0 ? { history } : {}),
      probeType: item.probeType,
      expectedBehavior: rubricEntry.expectedBehavior,
      ...(rubricEntry.tactic ? { tactic: rubricEntry.tactic } : {}),
      rubric: rubricEntry.rubric,
      referenceAnswer: turn.referenceAnswer,
      candidateAnswer: pred.outputText!,
    };

    try {
      const graded = await runWithRetry({
        maxAttempts: callMaxAttempts,
        delayMs: callRetryDelayMs,
        signal: workerSignal,
        onRetry: (attempt, max, error) => {
          options.onProgress?.(`${tag} 重试 ${attempt}/${max}：${publicErrorMessage(error)}`);
        },
        run: async () => {
          const callId = evalStore.startCall({
            runRef,
            role: "eval_grader",
            model: graderModelId,
            inputRefs: {
              prediction_id: pred.id,
              suite_item_id: item.id,
              item_key: item.itemKey,
              turn_no: pred.turnNo,
            },
          });
          let rawOutput: string | undefined;
          try {
            rawOutput = await runGrader({
              signal: workerSignal,
              role: "eval_grader",
              systemPrompt: graderPrompt,
              input: gradeInput,
            });
            throwIfAborted(workerSignal);
            let judgement: ReturnType<typeof parseGradeResult>;
            try {
              judgement = parseGradeResult(rawOutput, rubricEntry.rubric);
            } catch (error) {
              throw toPublicError(error, "model_output_invalid");
            }
            evalStore.finishCall(callId, { output: rawOutput });
            return { callId, judgement };
          } catch (error) {
            evalStore.finishCall(callId, { output: rawOutput, error: publicErrorMessage(error) });
            throw toPublicError(error);
          }
        },
      });

      throwIfAborted(workerSignal);
      const scored = scoreGradedTurn(graded.judgement, rubricEntry.rubric);
      evalStore.saveEvalScore({
        predictionId: pred.id,
        graderModel: graderModelId,
        behaviorOk: scored.behaviorOk,
        stance: scored.stance,
        keyPointCoverage: scored.keyPointCoverage,
        forbiddenHits: scored.forbiddenHits,
        hallucinationHits: scored.hallucinationHits,
        failureSignalHits: scored.failureSignalHits,
        style: scored.style,
        score: scored.finalScore,
        detail: {
          probeType: item.probeType,
          expectedBehavior: rubricEntry.expectedBehavior,
          tactic: rubricEntry.tactic,
          sameModelNotice,
          judgement: graded.judgement,
          scored,
        },
        callId: graded.callId,
      });
      newlyGraded++;
      options.onProgress?.(`${tag} -> score=${scored.finalScore}, behaviorOk=${scored.behaviorOk}`);
    } catch (error) {
      rethrowIfAborted(error, workerSignal);
      errors++;
      options.onProgress?.(`${tag} 批卷失败：${publicErrorMessage(error)}`);
    }
  }, { signal });

  const allScores = evalStore.listEvalScores(evalRunId);
  const meanTurnScore =
    allScores.length > 0
      ? Number((allScores.reduce((s, x) => s + x.score, 0) / allScores.length).toFixed(2))
      : 0;
  const turnBehaviorPassRate =
    allScores.length > 0
      ? Number((allScores.filter((x) => x.behaviorOk).length / allScores.length).toFixed(4))
      : 0;

  return {
    evalRunId,
    suiteName: evalRun.suiteName,
    candidate: evalRun.candidate,
    candidateModel: evalRun.model,
    graderModelId,
    sameModelNotice,
    totalPredictions: predictions.length,
    gradedTurns: newlyGraded,
    skippedAlreadyGraded,
    skippedErroredPredictions,
    errors,
    meanTurnScore,
    turnBehaviorPassRate,
    totalGraderCalls: evalStore.countAgentCalls(runRef, "eval_grader"),
  };
}
