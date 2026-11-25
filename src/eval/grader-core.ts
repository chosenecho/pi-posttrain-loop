import type { DifficultyLevel } from "./eval-db.js";
import type { GraderTurnJudgement, GraderVerdict } from "./probe-schema.js";

/**
 * Lightweight scoring & difficulty stratification core shared by calibration and candidate grading.
 *
 * v3 Holistic Agent Grading (primary):
 * - Trusts the grader agent's own holistic `score` (0..100) and `verdict` (`pass` / `partial` / `fail`)
 *   for substantive quality, rather than assembling a brittle score from 6 arbitrary deduction constants.
 * - Keeps `style` (0..2) strictly separate from substantive quality (no hardcoded 20pt style bonus).
 * - Preserves only one minimal sanity cap (`BEHAVIOR_FAIL_SCORE_CAP = 40`): if the grader itself reports
 *   `behaviorOk = false` or `hallucinated = true`, the turn score cannot contradict failure by exceeding 40.
 *
 * Legacy fallback:
 * - When a legacy v2 grader output omits `score`, falls back cleanly to stance/keyPoint/style aggregation.
 */

export const BEHAVIOR_FAIL_SCORE_CAP = 40;
export const DIFFICULTY_EASY_MIN_SCORE = 80;
export const DIFFICULTY_MEDIUM_MIN_SCORE = 50;

const VERDICT_DEFAULT_SCORE: Record<GraderVerdict, number> = {
  pass: 85,
  partial: 62,
  fail: 20,
};

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
  contentScore: number;
  penalty: number;
  rawScore: number;
  cappedByBehavior: boolean;
  finalScore: number;
  substantiveScore: number;
}

function inferVerdict(behaviorOk: boolean, hallucinated: boolean, finalScore: number): GraderVerdict {
  if (!behaviorOk || hallucinated || finalScore < DIFFICULTY_MEDIUM_MIN_SCORE) return "fail";
  if (finalScore >= DIFFICULTY_EASY_MIN_SCORE) return "pass";
  return "partial";
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

  // Primary path: Holistic Agent Grading (grader provides `score` and/or `verdict` directly)
  if (judgement.score !== undefined || judgement.verdict !== undefined) {
    const rawScore = Number(
      Math.max(
        0,
        Math.min(100, judgement.score ?? VERDICT_DEFAULT_SCORE[judgement.verdict!]),
      ).toFixed(2),
    );
    const cappedByBehavior = gateFailed && rawScore > BEHAVIOR_FAIL_SCORE_CAP;
    const finalScore = Number((cappedByBehavior ? BEHAVIOR_FAIL_SCORE_CAP : rawScore).toFixed(2));
    const verdict = gateFailed
      ? "fail"
      : (judgement.verdict ?? inferVerdict(judgement.behaviorOk, hallucinated, finalScore));

    // Only fall back to score-based coverage when the grader omitted `matchedKeyPoints` altogether;
    // an explicit `matchedKeyPoints: []` means 0 matched key points (coverage = 0).
    const keyPointCoverage = hasKeyPoints
      ? judgement.matchedKeyPointsProvided === false
        ? Number((finalScore / 100).toFixed(4))
        : judgement.matchedKeyPoints.length / rubric.keyPoints.length
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
      contentScore: rawScore,
      penalty: 0,
      rawScore,
      cappedByBehavior,
      finalScore,
      // Holistic score measures substantive accuracy & behavior without mixing in style
      substantiveScore: finalScore,
    };
  }

  // Legacy fallback path for older v2 index-only grader outputs
  const keyPointCoverage = hasKeyPoints
    ? judgement.matchedKeyPoints.length / rubric.keyPoints.length
    : judgement.behaviorOk
      ? 1
      : 0;

  const contentScore = hasKeyPoints
    ? (judgement.stance / 2) * 35 + keyPointCoverage * 45 + (judgement.style / 2) * 20
    : (judgement.stance / 2) * 60 + (judgement.style / 2) * 40;

  const substantiveContent = hasKeyPoints
    ? (judgement.stance / 2) * 43.75 + keyPointCoverage * 56.25
    : (judgement.stance / 2) * 100;

  const penalty = Math.min(
    45,
    Math.min(25, forbiddenHits * 15) +
      Math.min(35, hallucinationHits * 20) +
      (judgement.behaviorOk ? 0 : Math.min(12, failureSignalHits * 12)),
  );

  const rawScore = Math.max(0, Math.min(100, contentScore - penalty));
  const cappedByBehavior = gateFailed && rawScore > BEHAVIOR_FAIL_SCORE_CAP;
  const finalScore = Number((gateFailed ? Math.min(rawScore, BEHAVIOR_FAIL_SCORE_CAP) : rawScore).toFixed(2));

  const rawSubstantive = Math.max(0, Math.min(100, substantiveContent - penalty));
  const substantiveScore = Number(
    (gateFailed ? Math.min(rawSubstantive, BEHAVIOR_FAIL_SCORE_CAP) : rawSubstantive).toFixed(2),
  );

  return {
    verdict: inferVerdict(judgement.behaviorOk, hallucinated, finalScore),
    behaviorOk: judgement.behaviorOk,
    hallucinated,
    stance: judgement.stance,
    keyPointCoverage: Number(keyPointCoverage.toFixed(4)),
    forbiddenHits,
    hallucinationHits,
    failureSignalHits,
    style: judgement.style,
    contentScore: Number(contentScore.toFixed(2)),
    penalty,
    rawScore: Number(rawScore.toFixed(2)),
    cappedByBehavior,
    finalScore,
    substantiveScore,
  };
}

export interface ProbeDifficultyResult {
  difficulty: DifficultyLevel;
  aggregateScore: number;
  allBehaviorOk: boolean;
}

/**
 * Classifies probe difficulty from the bare generic model's turn scores:
 * - `easy`: bare model passes all behavior gates AND scores >= 80 (generic knowledge already suffices).
 * - `medium`: bare model passes all behavior gates AND scores 50..79.
 * - `hard`: bare model fails any behavior gate OR scores < 50 (truly discriminates author framework/boundaries).
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
