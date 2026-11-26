import { createWarmupGate, runConcurrentPool } from "../shared/concurrency.js";
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
import type { CalibrationPrompts, EvalSkillSnapshot } from "./eval-prompts.js";
import { classifyProbeDifficulty, scoreGradedTurn, type ScoredTurn } from "./grader-core.js";
import { parseGradeResult } from "./probe-schema.js";
import {
  EvalStore,
  type DifficultyLevel,
  type ProbeRecord,
  type ProbeTurnRecord,
} from "./store/index.js";

export interface RunProbeCalibrationOptions {
  evalStore: EvalStore;
  probes: ProbeRecord[];
  prompts: CalibrationPrompts;
  skills: EvalSkillSnapshot[];
  bareModelId: string;
  graderModelId: string;
  runBareModel: RoleRunner;
  runGrader: RoleRunner;
  recalibrate?: boolean;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  configSnapshot?: Record<string, unknown>;
  onProgress?: (message: string) => void;
}

export interface RunProbeCalibrationSummary {
  runId: number;
  totalProbes: number;
  calibrated: number;
  skippedExisting: number;
  errors: number;
  byDifficulty: Record<DifficultyLevel, number>;
  easyRatio: number;
  meanBareScore: number;
  totalAgentCalls: number;
}

/**
 * Calibrates accepted probes by running a transcript-free generic model (`bare_answer`)
 * and grading its output (`eval_grader`) to classify difficulty (`easy` / `medium` / `hard`).
 */
export async function runProbeCalibration(
  options: RunProbeCalibrationOptions,
): Promise<RunProbeCalibrationSummary> {
  const { evalStore, probes, prompts, skills, bareModelId, graderModelId, runBareModel, runGrader } = options;
  const concurrency = validateConcurrency(options.concurrency ?? 4);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  evalStore.markInterruptedRuns();

  const runId = evalStore.createRun({
    kind: "calibrate",
    config: {
      bareModelId,
      graderModelId,
      recalibrate: Boolean(options.recalibrate),
      concurrency,
      ...(options.configSnapshot ?? {}),
    },
    prompts: {
      bareAnswer: prompts.bareAnswer,
      evalGrader: prompts.evalGrader,
    },
    skills,
  });
  const runRef = `calibrate:${runId}`;
  const warmupGate = createWarmupGate();

  let calibrated = 0;
  let skippedExisting = 0;
  let errors = 0;
  const byDifficulty: Record<DifficultyLevel, number> = { easy: 0, medium: 0, hard: 0 };
  const probeScores: number[] = [];

  try {
    await runConcurrentPool(probes, concurrency, async (probe, idx) => {
      const tag = `[calibrate ${idx + 1}/${probes.length} probe#${probe.id}]`;

      if (!options.recalibrate && probe.difficulty !== null) {
        skippedExisting++;
        byDifficulty[probe.difficulty]++;
        return;
      }

      const turns: ProbeTurnRecord[] = evalStore.listProbeTurns(probe.id);
      if (turns.length === 0) {
        errors++;
        options.onProgress?.(`${tag} 缺少参考对话轮次，跳过`);
        return;
      }

      const existingMap = new Map<number, { bareAnswer: string; score: number; behaviorOk: boolean; scored: ScoredTurn }>();
      if (!options.recalibrate) {
        for (const cal of evalStore.listCalibrationsForProbe(probe.id, { bareModel: bareModelId, graderModel: graderModelId })) {
          const scored = cal.detail.scored as ScoredTurn | undefined;
          if (scored) {
            existingMap.set(cal.turnNo, { bareAnswer: cal.bareAnswer, score: cal.score, behaviorOk: cal.behaviorOk, scored });
          }
        }
      }

      const turnScores: ScoredTurn[] = [];
      const history: Array<{ role: "user" | "assistant"; content: string }> = [];

      for (const turn of turns) {
        const cached = existingMap.get(turn.turnNo);
        if (cached) {
          turnScores.push(cached.scored);
          history.push({ role: "user", content: turn.userContent });
          history.push({ role: "assistant", content: turn.referenceAnswer });
          continue;
        }

        let bareAnswer: string;
        let bareCallId: number;
        try {
          const bareOutcome = await warmupGate.run("bare_answer", true, () =>
            runWithRetry({
              maxAttempts: callMaxAttempts,
              delayMs: callRetryDelayMs,
              onRetry: (attempt, max, error) => {
                options.onProgress?.(`${tag}[t${turn.turnNo}] bare 重试 ${attempt}/${max}：${publicErrorMessage(error)}`);
              },
              run: async () => {
                const callId = evalStore.startCall({
                  runRef,
                  role: "bare_answer",
                  model: bareModelId,
                  inputRefs: { probe_id: probe.id, turn_no: turn.turnNo },
                });
                let rawOutput: string | undefined;
                try {
                  rawOutput = await runBareModel({
                    role: "bare_answer",
                    systemPrompt: prompts.bareAnswer,
                    input: {
                      question: turn.userContent,
                      ...(history.length > 0 ? { history } : {}),
                    },
                  });
                  let cleaned: string;
                  try {
                    cleaned = nonEmpty(rawOutput, "裸答模型输出");
                  } catch (error) {
                    throw toPublicError(error, "model_output_invalid");
                  }
                  evalStore.finishCall(callId, { output: cleaned });
                  return { callId, answer: cleaned };
                } catch (error) {
                  evalStore.finishCall(callId, { output: rawOutput, error: publicErrorMessage(error) });
                  throw toPublicError(error);
                }
              },
            }),
          );
          bareAnswer = bareOutcome.answer;
          bareCallId = bareOutcome.callId;
        } catch (error) {
          errors++;
          options.onProgress?.(`${tag}[t${turn.turnNo}] 裸答失败：${publicErrorMessage(error)}`);
          return;
        }

        let scored: ScoredTurn;
        let graderCallId: number;
        let judgement: ReturnType<typeof parseGradeResult>;
        try {
          const gradeOutcome = await warmupGate.run("eval_grader", true, () =>
            runWithRetry({
              maxAttempts: callMaxAttempts,
              delayMs: callRetryDelayMs,
              onRetry: (attempt, max, error) => {
                options.onProgress?.(`${tag}[t${turn.turnNo}] grader 重试 ${attempt}/${max}：${publicErrorMessage(error)}`);
              },
              run: async () => {
                const callId = evalStore.startCall({
                  runRef,
                  role: "eval_grader",
                  model: graderModelId,
                  inputRefs: { probe_id: probe.id, turn_no: turn.turnNo },
                });
                let rawOutput: string | undefined;
                try {
                  rawOutput = await runGrader({
                    role: "eval_grader",
                    systemPrompt: prompts.evalGrader,
                    input: {
                      question: turn.userContent,
                      ...(history.length > 0 ? { history } : {}),
                      probeType: probe.probeType,
                      expectedBehavior: turn.expectedBehavior,
                      ...(turn.tactic ? { tactic: turn.tactic } : {}),
                      rubric: turn.rubric,
                      referenceAnswer: turn.referenceAnswer,
                      candidateAnswer: bareAnswer,
                    },
                  });
                  let parsed: ReturnType<typeof parseGradeResult>;
                  try {
                    parsed = parseGradeResult(rawOutput, turn.rubric);
                  } catch (error) {
                    throw toPublicError(error, "model_output_invalid");
                  }
                  evalStore.finishCall(callId, { output: rawOutput });
                  return { callId, judgement: parsed };
                } catch (error) {
                  evalStore.finishCall(callId, { output: rawOutput, error: publicErrorMessage(error) });
                  throw toPublicError(error);
                }
              },
            }),
          );
          judgement = gradeOutcome.judgement;
          graderCallId = gradeOutcome.callId;
          scored = scoreGradedTurn(judgement, turn.rubric);
        } catch (error) {
          errors++;
          options.onProgress?.(`${tag}[t${turn.turnNo}] 标定批卷失败：${publicErrorMessage(error)}`);
          return;
        }

        evalStore.saveCalibration({
          probeId: probe.id,
          turnNo: turn.turnNo,
          bareModel: bareModelId,
          graderModel: graderModelId,
          bareAnswer,
          behaviorOk: scored.behaviorOk,
          score: scored.finalScore,
          detail: {
            probeType: probe.probeType,
            expectedBehavior: turn.expectedBehavior,
            tactic: turn.tactic,
            judgement,
            scored,
          },
          bareCallId,
          graderCallId,
        });

        turnScores.push(scored);
        history.push({ role: "user", content: turn.userContent });
        history.push({ role: "assistant", content: turn.referenceAnswer });
      }

      const result = classifyProbeDifficulty(turnScores);
      evalStore.setProbeDifficulty(probe.id, result.difficulty);
      calibrated++;
      byDifficulty[result.difficulty]++;
      probeScores.push(result.aggregateScore);
      options.onProgress?.(
        `${tag} (${probe.probeType}) -> ${result.difficulty} (bare=${result.aggregateScore}, behaviorOk=${result.allBehaviorOk})`,
      );
    });

    evalStore.finishRun(runId, "completed");
  } catch (error) {
    evalStore.finishRun(runId, "failed", publicErrorMessage(error));
    throw toPublicError(error);
  }

  const totalDone = byDifficulty.easy + byDifficulty.medium + byDifficulty.hard;
  const easyRatio = totalDone > 0 ? Number((byDifficulty.easy / totalDone).toFixed(4)) : 0;
  const meanBareScore =
    probeScores.length > 0
      ? Number((probeScores.reduce((s, v) => s + v, 0) / probeScores.length).toFixed(2))
      : 0;

  return {
    runId,
    totalProbes: probes.length,
    calibrated,
    skippedExisting,
    errors,
    byDifficulty,
    easyRatio,
    meanBareScore,
    totalAgentCalls: evalStore.countAgentCalls(runRef),
  };
}
