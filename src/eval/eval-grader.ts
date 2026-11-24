import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../retry.js";
import { errorMessage, nonEmpty, validateConcurrency } from "../schema.js";
import { runConcurrentPool } from "../shared/concurrency.js";
import type { RoleRunner } from "../types.js";
import {
  EvalStore,
  EXPECTED_BEHAVIORS,
  type ExpectedBehavior,
  type SuiteItemRecord,
} from "./eval-db.js";
import { extractSuiteDialogueTurns } from "./eval-runner.js";
import { scoreGradedTurn } from "./grader-core.js";
import { parseGradeResult, type ProbeRubricV2 } from "./probe-schema.js";

export interface NormalizedSuiteTurnRubric {
  turnNo: number;
  probeType: string;
  expectedBehavior: ExpectedBehavior;
  tactic: string | null;
  rubric: ProbeRubricV2;
}

/**
 * Normalizes both `indist-v1` (P1 `EvalRubric` without `expectedBehavior`/`failureSignals`)
 * and `adv-v1` (Rubric v2) turn rubric entries into a single `ProbeRubricV2` contract.
 */
export function normalizeSuiteTurnRubric(
  item: Pick<SuiteItemRecord, "itemKey" | "probeType" | "expectedBehavior" | "rubrics">,
  turnNo: number,
): NormalizedSuiteTurnRubric {
  const entries = item.rubrics as Array<Record<string, unknown>>;
  const match = entries.find((e) => Number(e?.turnNo) === turnNo) ?? entries[turnNo - 1];
  if (!match || typeof match !== "object") {
    throw new Error(`套卷条目 ${item.itemKey} Turn ${turnNo} 缺少评分卡`);
  }
  const rawRubric = (match.rubric ?? match) as Record<string, unknown> | null;
  if (!rawRubric || typeof rawRubric !== "object") {
    throw new Error(`套卷条目 ${item.itemKey} Turn ${turnNo} 评分卡为空`);
  }

  const candidateBehavior =
    (typeof match.expectedBehavior === "string" ? match.expectedBehavior : undefined) ??
    (typeof rawRubric.expectedBehavior === "string" ? rawRubric.expectedBehavior : undefined) ??
    (turnNo === 1 && typeof item.expectedBehavior === "string" ? item.expectedBehavior : undefined) ??
    "answer";

  const expectedBehavior: ExpectedBehavior = EXPECTED_BEHAVIORS.includes(candidateBehavior as ExpectedBehavior)
    ? (candidateBehavior as ExpectedBehavior)
    : "answer";

  const toStringArray = (val: unknown): string[] =>
    Array.isArray(val) ? val.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];

  const stance = typeof rawRubric.stance === "string" && rawRubric.stance.trim().length > 0
    ? rawRubric.stance.trim()
    : "保持作者核心框架与判断立场";

  const tactic = typeof match.tactic === "string" && match.tactic.trim().length > 0
    ? match.tactic.trim()
    : null;

  return {
    turnNo,
    probeType: item.probeType ?? "in_distribution",
    expectedBehavior,
    tactic,
    rubric: {
      expectedBehavior,
      stance,
      keyPoints: toStringArray(rawRubric.keyPoints),
      forbidden: toStringArray(rawRubric.forbidden),
      mustNotHallucinate: toStringArray(rawRubric.mustNotHallucinate),
      failureSignals: toStringArray(rawRubric.failureSignals),
    },
  };
}

function extractPriorHistoryFromPredictionInput(
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
  // Drop the final user message (the current turn's question)
  return nonSystem.length > 1 ? nonSystem.slice(0, -1) : [];
}

export interface GradeEvalRunOptions {
  evalStore: EvalStore;
  evalRunId: number;
  graderPrompt: string;
  runGrader: RoleRunner;
  graderModelId: string;
  /** Spec section 8 forbids grader === candidate model; must explicitly opt in for single-model smoke tests. */
  allowSameModel?: boolean;
  regrade?: boolean;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
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
 * Grades all valid candidate predictions of an `eval_run` against the frozen suite's rubrics
 * (supporting both `indist-v1` P1 rubrics and `adv-v1` rubric v2) using deterministic `scoreGradedTurn`.
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

  const sameModelNotice =
    graderModelId.trim().toLowerCase() === evalRun.model.trim().toLowerCase();
  if (sameModelNotice && !options.allowSameModel) {
    throw new Error(
      `批卷守卫拦截：批卷模型（${graderModelId}）与被测候选模型（${evalRun.model}）相同。` +
      `请通过 --grader-model / EVAL_LLM_MODEL 指定不同家族的裁判模型；如仅作单模型联调，请显式传入 --allow-same-model`,
    );
  }

  const suiteItems = evalStore.listSuiteItemsBySuiteId(evalRun.suiteId);
  const itemById = new Map<number, SuiteItemRecord>();
  const turnsByItemId = new Map<number, ReturnType<typeof extractSuiteDialogueTurns>>();
  for (const item of suiteItems) {
    itemById.set(item.id, item);
    turnsByItemId.set(item.id, extractSuiteDialogueTurns(item));
  }

  const predictions = evalStore.listEvalPredictions(evalRunId);
  if (predictions.length === 0) {
    throw new Error(`eval_run #${evalRunId} 尚无候选模型预测记录，请先运行 eval run`);
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

  const runRef = `eval_run:${evalRunId}`;
  let newlyGraded = 0;
  let errors = 0;

  await runConcurrentPool(toGrade, concurrency, async (pred, idx) => {
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

    const normalized = normalizeSuiteTurnRubric(item, pred.turnNo);
    const history = extractPriorHistoryFromPredictionInput(pred.input);
    const tag = `[${idx + 1}/${toGrade.length} ${item.itemKey}:t${pred.turnNo}]`;

    const gradeInput: Record<string, unknown> = {
      question: turn.user,
      ...(history.length > 0 ? { history } : {}),
      probeType: normalized.probeType,
      expectedBehavior: normalized.expectedBehavior,
      ...(normalized.tactic ? { tactic: normalized.tactic } : {}),
      rubric: normalized.rubric,
      referenceAnswer: turn.referenceAnswer,
      candidateAnswer: pred.outputText!,
    };

    try {
      const graded = await runWithRetry({
        maxAttempts: callMaxAttempts,
        delayMs: callRetryDelayMs,
        onRetry: (attempt: number, max: number, error: unknown) => {
          options.onProgress?.(`${tag} 重试 ${attempt}/${max}：${errorMessage(error)}`);
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
          try {
            const raw = await runGrader({
              role: "eval_grader",
              systemPrompt: graderPrompt,
              input: gradeInput,
            });
            const judgement = parseGradeResult(raw, normalized.rubric);
            evalStore.finishCall(callId, { output: raw });
            return { callId, judgement };
          } catch (error) {
            evalStore.finishCall(callId, { error: errorMessage(error) });
            throw error;
          }
        },
      });

      const scored = scoreGradedTurn(graded.judgement, normalized.rubric);
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
          probeType: normalized.probeType,
          expectedBehavior: normalized.expectedBehavior,
          tactic: normalized.tactic,
          sameModelNotice,
          judgement: graded.judgement,
          scored,
        },
        callId: graded.callId,
      });
      newlyGraded++;
      options.onProgress?.(`${tag} -> score=${scored.finalScore}, behaviorOk=${scored.behaviorOk}`);
    } catch (error) {
      errors++;
      options.onProgress?.(`${tag} 批卷失败：${errorMessage(error)}`);
    }
  });

  const allScores = evalStore.listEvalScores(evalRunId);
  const meanTurnScore = allScores.length > 0
    ? Number((allScores.reduce((s, x) => s + x.score, 0) / allScores.length).toFixed(2))
    : 0;
  const turnBehaviorPassRate = allScores.length > 0
    ? Number((allScores.filter((x) => x.behaviorOk).length / allScores.length).toFixed(4))
    : 0;
  const graderCallsRow = evalStore.db
    .prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ? AND role = 'eval_grader'")
    .get(runRef) as { c: number };

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
    totalGraderCalls: Number(graderCallsRow.c),
  };
}
