import type { DifficultyLevel } from "./store/index.js";
import type { GraderTurnJudgement, GraderVerdict } from "./probe-schema.js";

/**
 * Holistic scoring & difficulty stratification core shared by calibration and candidate grading.
 * - Trusts the grader agent's holistic `score` (0..100) and `verdict` (`pass` / `partial` / `fail`).
 * - Keeps `style` (0..2) strictly separate from substantive `score`.
 * - Enforces one hard safety cap (`BEHAVIOR_FAIL_SCORE_CAP = 40`): if `behaviorOk = false` or
 *   `hallucinated = true`, the turn score is capped at 40 and `verdict` is forced to `"fail"`.
 */

export const BEHAVIOR_FAIL_SCORE_CAP = 40;
export const DIFFICULTY_EASY_MIN_SCORE = 80;
export const DIFFICULTY_MEDIUM_MIN_SCORE = 50;

export interface ScoredTurn {
  verdict: GraderVerdict;
  behaviorOk: boolean;
  hallucinated: boolean;
  stance: 0 | 1 | 2;
  keyPointCoverage: number;
  forbiddenHits: number;
  hallucinationHits: number;
  failureSignalHits: number;
  style: 0 | 1 | 2;
  rawScore: number;
  cappedByBehavior: boolean;
  finalScore: number;
}

export function scoreGradedTurn(
  judgement: GraderTurnJudgement,
  rubric: { keyPoints: readonly string[] },
): ScoredTurn {
  const hasKeyPoints = rubric.keyPoints.length > 0;
  const hallucinated = Boolean(judgement.hallucinated || judgement.hallucinationHits.length > 0);
  const forbiddenHits = judgement.forbiddenHits.length;
  const hallucinationHits = Math.max(judgement.hallucinationHits.length, hallucinated ? 1 : 0);
  const failureSignalHits = judgement.failureSignalHits.length;
  const gateFailed = !judgement.behaviorOk || hallucinated;

  const rawScore = Number(Math.max(0, Math.min(100, judgement.score)).toFixed(2));
  const cappedByBehavior = gateFailed && rawScore > BEHAVIOR_FAIL_SCORE_CAP;
  const finalScore = Number((cappedByBehavior ? BEHAVIOR_FAIL_SCORE_CAP : rawScore).toFixed(2));
  const verdict: GraderVerdict = gateFailed ? "fail" : judgement.verdict;

  const keyPointCoverage = hasKeyPoints
    ? judgement.matchedKeyPointsProvided
      ? judgement.matchedKeyPoints.length / rubric.keyPoints.length
      : Number((finalScore / 100).toFixed(4))
    : judgement.behaviorOk
      ? 1
      : 0;

  return {
    verdict,
    behaviorOk: judgement.behaviorOk,
    hallucinated,
    stance: judgement.stance,
    keyPointCoverage: Number(Math.max(0, Math.min(1, keyPointCoverage)).toFixed(4)),
    forbiddenHits,
    hallucinationHits,
    failureSignalHits,
    style: judgement.style,
    rawScore,
    cappedByBehavior,
    finalScore,
  };
}

export interface ProbeDifficultyResult {
  difficulty: DifficultyLevel;
  aggregateScore: number;
  allBehaviorOk: boolean;
}

/**
 * Classifies probe difficulty from the bare generic model's turn scores:
 * - `easy`: bare model passes all behavior gates AND scores >= 80.
 * - `medium`: bare model passes all behavior gates AND scores 50..79.
 * - `hard`: bare model fails any behavior gate OR scores < 50.
 */
export function classifyProbeDifficulty(turnScores: readonly ScoredTurn[]): ProbeDifficultyResult {
  if (turnScores.length === 0) {
    throw new Error("classifyProbeDifficulty 至少需要 1 轮得分");
  }
  const allBehaviorOk = turnScores.every((t) => t.behaviorOk && !t.hallucinated);
  const meanScore = turnScores.reduce((sum, t) => sum + t.finalScore, 0) / turnScores.length;
  const aggregateScore = Number((allBehaviorOk ? meanScore : Math.min(meanScore, BEHAVIOR_FAIL_SCORE_CAP)).toFixed(2));

  let difficulty: DifficultyLevel;
  if (allBehaviorOk && aggregateScore >= DIFFICULTY_EASY_MIN_SCORE) {
    difficulty = "easy";
  } else if (allBehaviorOk && aggregateScore >= DIFFICULTY_MEDIUM_MIN_SCORE) {
    difficulty = "medium";
  } else {
    difficulty = "hard";
  }

  return { difficulty, aggregateScore, allBehaviorOk };
}
