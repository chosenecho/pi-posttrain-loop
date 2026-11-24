import type { DifficultyLevel } from "./eval-db.js";
import type { GraderTurnJudgement } from "./probe-schema.js";

/**
 * Deterministic scoring and difficulty stratification core shared by M2 calibration
 * and M3 (P2) candidate evaluation grading.
 *
 * Scoring contract (docs/eval-probe-pipeline.md section 8):
 * - Behavior gate (`behaviorOk`): failure caps the turn score at 40 / 100.
 * - Content score: stance (0..2) + keyPoints coverage (0..1) + style (0..2).
 * - Deductions: forbidden (-15 each), mustNotHallucinate (-20 each), failureSignals (-12 each).
 */

export const BEHAVIOR_FAIL_SCORE_CAP = 40;
export const PENALTY_FORBIDDEN = 15;
export const PENALTY_HALLUCINATION = 20;
export const PENALTY_FAILURE_SIGNAL = 12;

export const DIFFICULTY_EASY_MIN_SCORE = 80;
export const DIFFICULTY_MEDIUM_MIN_SCORE = 50;

export interface ScoredTurn {
  behaviorOk: boolean;
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
}

export function scoreGradedTurn(
  judgement: GraderTurnJudgement,
  rubric: { keyPoints: readonly string[] },
): ScoredTurn {
  const hasKeyPoints = rubric.keyPoints.length > 0;
  const keyPointCoverage = hasKeyPoints
    ? judgement.matchedKeyPoints.length / rubric.keyPoints.length
    : judgement.behaviorOk
      ? 1
      : 0;

  const contentScore = hasKeyPoints
    ? (judgement.stance / 2) * 35 + keyPointCoverage * 45 + (judgement.style / 2) * 20
    : (judgement.stance / 2) * 60 + (judgement.style / 2) * 40;

  const forbiddenHits = judgement.forbiddenHits.length;
  const hallucinationHits = judgement.hallucinationHits.length;
  const failureSignalHits = judgement.failureSignalHits.length;
  const penalty =
    forbiddenHits * PENALTY_FORBIDDEN +
    hallucinationHits * PENALTY_HALLUCINATION +
    failureSignalHits * PENALTY_FAILURE_SIGNAL;

  const rawScore = Math.max(0, Math.min(100, contentScore - penalty));
  const cappedByBehavior = !judgement.behaviorOk && rawScore > BEHAVIOR_FAIL_SCORE_CAP;
  const finalScore = Number((judgement.behaviorOk ? rawScore : Math.min(rawScore, BEHAVIOR_FAIL_SCORE_CAP)).toFixed(2));

  return {
    behaviorOk: judgement.behaviorOk,
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
  const allBehaviorOk = turnScores.every((t) => t.behaviorOk);
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
