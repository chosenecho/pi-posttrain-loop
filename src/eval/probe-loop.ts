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
import type { EvalRole, RoleRunner } from "../shared/types.js";
import type { EvalBuildPrompts, EvalSkillSnapshot } from "./eval-prompts.js";
import {
  parseAdversaryTurn,
  parseCriticReview,
  parseProbeDraftBatch,
  parseProbeRevision,
  parseVerifierResult,
  verifyAnchorInMaterial,
  type PlannedProbeDraft,
} from "./probe-schema.js";
import {
  ADVERSARY_TACTICS,
  EvalStore,
  expectedBehaviorForTurn,
  PROBE_TYPES,
  type AdversaryTactic,
  type ProbeRubric,
  type ProbeType,
  type SourceMaterialRecord,
} from "./store/index.js";

export const DEFAULT_MAX_PROBES_PER_VIDEO = 5;
export const DEFAULT_MAX_CRITIC_REVISIONS = 2;
export const DEFAULT_MAX_ANSWER_ATTEMPTS = 2;

const DEFAULT_PERSONAS = ["普通提问者", "打工人", "学生", "杠精网友", "学者", "同情者", "反对者"] as const;

export interface SoftTypeGuidance {
  currentTypeCounts: Record<ProbeType, number>;
  underrepresentedTypes: ProbeType[];
}

export function buildSoftTypeGuidance(
  existingCounts: Record<string, number>,
  allowedTypes: readonly ProbeType[] = PROBE_TYPES,
): SoftTypeGuidance {
  const currentTypeCounts = {} as Record<ProbeType, number>;
  let total = 0;
  for (const type of PROBE_TYPES) {
    const count = existingCounts[type] ?? 0;
    currentTypeCounts[type] = count;
    if (allowedTypes.includes(type)) total += count;
  }
  const avg = allowedTypes.length > 0 ? total / allowedTypes.length : 0;
  const underrepresentedTypes = allowedTypes
    .filter((t) => (currentTypeCounts[t] ?? 0) <= avg)
    .sort((a, b) => (currentTypeCounts[a] ?? 0) - (currentTypeCounts[b] ?? 0));
  return { currentTypeCounts, underrepresentedTypes };
}

export interface RunProbeBuildLoopOptions {
  evalStore: EvalStore;
  sources: SourceMaterialRecord[];
  prompts: EvalBuildPrompts;
  skills: EvalSkillSnapshot[];
  modelId: string;
  runRole: RoleRunner;
  allowedTypes?: readonly ProbeType[];
  maxProbesPerVideo?: number;
  maxRevisions?: number;
  maxAnswerAttempts?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  configSnapshot?: Record<string, unknown>;
  onProgress?: (message: string) => void;
}

export interface RunProbeBuildLoopSummary {
  runId: number;
  sourcesProcessed: number;
  sourcesSkipped: number;
  probesCreated: number;
  accepted: number;
  rejected: number;
  dropped: number;
  errors: number;
  byType: Record<string, number>;
  totalAgentCalls: number;
}

async function invokeTrackedRole<T>(options: {
  evalStore: EvalStore;
  runRef: string;
  role: EvalRole;
  model: string;
  systemPrompt: string;
  input: Record<string, unknown>;
  inputRefs: Record<string, unknown>;
  runRole: RoleRunner;
  parse: (raw: string) => T;
  callMaxAttempts: number;
  callRetryDelayMs: number;
  warmupGate?: ReturnType<typeof createWarmupGate>;
  warmupKey?: string;
  onRetry?: (attempt: number, max: number, error: unknown) => void;
}): Promise<{ callId: number; result: T }> {
  const execute = async (): Promise<{ callId: number; result: T }> =>
    runWithRetry({
      maxAttempts: options.callMaxAttempts,
      delayMs: options.callRetryDelayMs,
      onRetry: options.onRetry,
      run: async () => {
        const callId = options.evalStore.startCall({
          runRef: options.runRef,
          role: options.role,
          model: options.model,
          inputRefs: options.inputRefs,
        });
        let rawOutput: string | undefined;
        try {
          rawOutput = await options.runRole({
            role: options.role,
            systemPrompt: options.systemPrompt,
            input: options.input,
          });
          let parsed: T;
          try {
            parsed = options.parse(rawOutput);
          } catch (error) {
            throw toPublicError(error, "model_output_invalid");
          }
          options.evalStore.finishCall(callId, { output: rawOutput });
          return { callId, result: parsed };
        } catch (error) {
          options.evalStore.finishCall(callId, { output: rawOutput, error: publicErrorMessage(error) });
          throw toPublicError(error);
        }
      },
    });

  if (options.warmupGate && options.warmupKey) {
    return options.warmupGate.run(options.warmupKey, true, execute);
  }
  return execute();
}

export async function runProbeBuildLoop(options: RunProbeBuildLoopOptions): Promise<RunProbeBuildLoopSummary> {
  const { evalStore, sources, prompts, skills, modelId, runRole } = options;
  const allowedTypes: readonly ProbeType[] =
    options.allowedTypes && options.allowedTypes.length > 0 ? options.allowedTypes : PROBE_TYPES;
  const maxProbesPerVideo = options.maxProbesPerVideo ?? DEFAULT_MAX_PROBES_PER_VIDEO;
  const maxRevisions = options.maxRevisions ?? DEFAULT_MAX_CRITIC_REVISIONS;
  const maxAnswerAttempts = options.maxAnswerAttempts ?? DEFAULT_MAX_ANSWER_ATTEMPTS;
  const concurrency = validateConcurrency(options.concurrency ?? 4);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  evalStore.markInterruptedRuns();

  const runId = evalStore.createRun({
    kind: "probe_build",
    config: {
      modelId,
      allowedTypes,
      maxProbesPerVideo,
      maxRevisions,
      maxAnswerAttempts,
      concurrency,
      ...(options.configSnapshot ?? {}),
    },
    prompts: {
      probeWriter: prompts.probeWriter,
      probeCritic: prompts.probeCritic,
      reference: prompts.reference,
      verifier: prompts.verifier,
      adversary: prompts.adversary,
    },
    skills,
  });
  const runRef = `probe_build:${runId}`;
  const warmupGate = createWarmupGate();

  let sourcesProcessed = 0;
  let sourcesSkipped = 0;
  let probesCreated = 0;
  let accepted = 0;
  let rejected = 0;
  let dropped = 0;
  let errors = 0;
  const byType: Record<string, number> = {};

  async function processOneProbe(
    source: SourceMaterialRecord,
    slotIndex: number,
    draft: PlannedProbeDraft,
    tag: string,
  ): Promise<void> {
    const probeId = evalStore.createProbe({
      runId,
      sourceMaterialId: source.id,
      slotIndex,
      probeType: draft.probeType,
      persona: draft.persona,
      targetTurns: draft.targetTurns,
      question: draft.question,
      anchor: draft.anchor,
      trap: draft.trap,
      anchorVerified: verifyAnchorInMaterial(draft.anchor, source.content),
    });
    probesCreated++;

    // Stage 1: Static critic review + revision loop (up to maxRevisions)
    let criticPassed = false;
    for (let roundNo = 1; roundNo <= maxRevisions + 1; roundNo++) {
      const current = evalStore.getProbe(probeId)!;
      const siblings = evalStore.listExistingQuestionsForSource(source.id, probeId);

      const { callId, result: review } = await invokeTrackedRole({
        evalStore,
        runRef,
        role: "probe_critic",
        model: modelId,
        systemPrompt: prompts.probeCritic,
        input: {
          material: source.content,
          probeType: current.probeType,
          persona: current.persona,
          expectedBehavior: current.expectedBehavior,
          targetTurns: current.targetTurns,
          question: current.question,
          anchor: current.anchor,
          anchorVerified: current.anchorVerified,
          trap: current.trap,
          ...(siblings.length > 0 ? { existingQuestions: siblings } : {}),
        },
        inputRefs: { probe_id: probeId, round_no: roundNo },
        runRole,
        parse: parseCriticReview,
        callMaxAttempts,
        callRetryDelayMs,
        warmupGate,
        warmupKey: "probe_critic",
      });

      evalStore.appendReview(probeId, {
        roundNo,
        decision: review.decision,
        issues: review.issues,
        feedback: review.feedback,
        callId,
      });

      if (review.decision === "accept") {
        criticPassed = true;
        break;
      }
      if (review.decision === "reject" || roundNo > maxRevisions) {
        const reason =
          review.decision === "reject"
            ? review.feedback
            : `审题改写 ${maxRevisions} 次仍未通过：${review.feedback}`;
        evalStore.setProbeStatus(probeId, "rejected", reason);
        rejected++;
        options.onProgress?.(`${tag} probe#${probeId} rejected: ${reason.slice(0, 60)}`);
        return;
      }

      // Revise via probe-writer
      const { result: revised } = await invokeTrackedRole({
        evalStore,
        runRef,
        role: "probe_writer",
        model: modelId,
        systemPrompt: prompts.probeWriter,
        input: {
          material: source.content,
          mode: "revise",
          videoId: source.videoId,
          allowedTypes,
          slot: {
            slotIndex: current.slotIndex,
            probeType: current.probeType,
            persona: current.persona,
            expectedBehavior: current.expectedBehavior,
            targetTurns: current.targetTurns,
          },
          previousProbe: {
            question: current.question,
            anchor: current.anchor,
            trap: current.trap,
          },
          issues: review.issues,
          feedback: review.feedback,
          ...(siblings.length > 0 ? { existingQuestions: siblings } : {}),
        },
        inputRefs: { probe_id: probeId, mode: "revise", round_no: roundNo },
        runRole,
        parse: (raw) => parseProbeRevision(raw, allowedTypes),
        callMaxAttempts,
        callRetryDelayMs,
        warmupGate,
        warmupKey: "probe_writer",
      });

      const nextType = revised.probeType ?? current.probeType;
      const nextTurns =
        revised.targetTurns ?? (nextType === "hold_position" ? Math.max(2, current.targetTurns) : 1);
      evalStore.reviseProbe(probeId, {
        probeType: nextType,
        persona: revised.persona ?? current.persona,
        targetTurns: nextTurns,
        question: revised.question,
        anchor: revised.anchor || current.anchor,
        trap: revised.trap || current.trap,
        anchorVerified: verifyAnchorInMaterial(revised.anchor || current.anchor, source.content),
      });
    }

    if (!criticPassed) return;

    // Stage 2: Reference + Verifier (emits rubric on pass) across 1..targetTurns
    const probe = evalStore.getProbe(probeId)!;
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    const usedTactics: AdversaryTactic[] = [];

    for (let turnNo = 1; turnNo <= probe.targetTurns; turnNo++) {
      const expectedBehavior = expectedBehaviorForTurn(probe.probeType, turnNo);
      let userContent = probe.question;
      let turnTrap = probe.trap;
      let tactic: AdversaryTactic | null = null;

      if (turnNo >= 2) {
        const remainingTactics = ADVERSARY_TACTICS.filter((t) => !usedTactics.includes(t));
        const availableTactics = remainingTactics.length > 0 ? remainingTactics : [...ADVERSARY_TACTICS];
        const { result: adv } = await invokeTrackedRole({
          evalStore,
          runRef,
          role: "adversary",
          model: modelId,
          systemPrompt: prompts.adversary,
          input: {
            material: source.content,
            history,
            probeType: probe.probeType,
            persona: probe.persona,
            availableTactics,
            ...(usedTactics.length > 0 ? { usedTactics } : {}),
            turnNo,
            targetTurns: probe.targetTurns,
            anchor: probe.anchor,
          },
          inputRefs: { probe_id: probeId, turn_no: turnNo },
          runRole,
          parse: (raw) => parseAdversaryTurn(raw, availableTactics),
          callMaxAttempts,
          callRetryDelayMs,
          warmupGate,
          warmupKey: "adversary",
        });
        tactic = adv.tactic;
        usedTactics.push(tactic);
        userContent = adv.userContent;
        turnTrap = adv.trap || probe.trap;
      }

      let previousAnswer: string | undefined;
      let feedback: string | undefined;
      let passedAnswer: string | undefined;
      let passedRubric: ProbeRubric | undefined;
      let attemptsUsed = 0;

      for (let attempt = 1; attempt <= maxAnswerAttempts; attempt++) {
        attemptsUsed = attempt;
        const { result: answerText } = await invokeTrackedRole({
          evalStore,
          runRef,
          role: "reference",
          model: modelId,
          systemPrompt: prompts.reference,
          input: {
            material: source.content,
            question: userContent,
            probeType: probe.probeType,
            expectedBehavior,
            ...(history.length > 0 ? { history } : {}),
            ...(previousAnswer ? { previousAnswer, feedback } : {}),
          },
          inputRefs: { probe_id: probeId, turn_no: turnNo, attempt },
          runRole,
          parse: (raw) => nonEmpty(raw, "参考答案"),
          callMaxAttempts,
          callRetryDelayMs,
          warmupGate,
          warmupKey: "reference",
        });

        const { result: verified } = await invokeTrackedRole({
          evalStore,
          runRef,
          role: "verifier",
          model: modelId,
          systemPrompt: prompts.verifier,
          input: {
            material: source.content,
            probeType: probe.probeType,
            expectedBehavior,
            question: userContent,
            anchor: probe.anchor,
            trap: turnTrap,
            ...(history.length > 0 ? { history } : {}),
            answer: answerText,
          },
          inputRefs: { probe_id: probeId, turn_no: turnNo, attempt },
          runRole,
          parse: (raw) => parseVerifierResult(raw, expectedBehavior),
          callMaxAttempts,
          callRetryDelayMs,
          warmupGate,
          warmupKey: "verifier",
        });

        if (verified.decision === "pass" && verified.rubric) {
          passedAnswer = answerText;
          passedRubric = verified.rubric;
          break;
        }
        if (verified.decision === "drop" || attempt >= maxAnswerAttempts) {
          const reason =
            verified.decision === "drop"
              ? `Turn ${turnNo} 核验淘汰：${verified.feedback}`
              : `Turn ${turnNo} 参考答案返工 ${maxAnswerAttempts} 次仍未通过：${verified.feedback}`;
          evalStore.setProbeStatus(probeId, "dropped", reason);
          dropped++;
          options.onProgress?.(`${tag} probe#${probeId} dropped: ${reason.slice(0, 60)}`);
          return;
        }
        previousAnswer = answerText;
        feedback = verified.feedback;
      }

      if (!passedAnswer || !passedRubric) return;

      evalStore.saveProbeTurn({
        probeId,
        turnNo,
        expectedBehavior,
        tactic,
        userContent,
        referenceAnswer: passedAnswer,
        rubric: passedRubric,
        attempts: attemptsUsed,
      });
      history.push({ role: "user", content: userContent });
      history.push({ role: "assistant", content: passedAnswer });
    }

    evalStore.setProbeStatus(probeId, "accepted");
    accepted++;
    byType[probe.probeType] = (byType[probe.probeType] ?? 0) + 1;
    options.onProgress?.(`${tag} probe#${probeId} (${probe.probeType}, ${probe.targetTurns}t) accepted`);
  }

  try {
    await runConcurrentPool(sources, concurrency, async (source, idx) => {
      const tag = `[build ${idx + 1}/${sources.length} ${source.videoId}]`;
      try {
        const guidance = buildSoftTypeGuidance(evalStore.countProbesByType(["accepted", "draft"]), allowedTypes);
        const existingQuestions = evalStore.listExistingQuestionsForSource(source.id);

        const { result: batch } = await invokeTrackedRole({
          evalStore,
          runRef,
          role: "probe_writer",
          model: modelId,
          systemPrompt: prompts.probeWriter,
          input: {
            material: source.content,
            mode: "draft",
            videoId: source.videoId,
            partCount: source.partCount,
            maxProbes: maxProbesPerVideo,
            allowedTypes,
            currentTypeCounts: guidance.currentTypeCounts,
            underrepresentedTypes: guidance.underrepresentedTypes,
            suggestedPersonas: DEFAULT_PERSONAS,
            ...(existingQuestions.length > 0 ? { existingQuestions } : {}),
          },
          inputRefs: { source_material_id: source.id, video_id: source.videoId, mode: "draft" },
          runRole,
          parse: (raw) => parseProbeDraftBatch(raw, { maxProbes: maxProbesPerVideo, allowedTypes }),
          callMaxAttempts,
          callRetryDelayMs,
          warmupGate,
          warmupKey: "probe_writer",
        });

        sourcesProcessed++;
        if (batch.probes.length === 0) {
          sourcesSkipped++;
          options.onProgress?.(`${tag} 跳过（${batch.skipReason ?? "无合适考题"}）`);
          return;
        }

        for (let i = 0; i < batch.probes.length; i++) {
          try {
            await processOneProbe(source, i + 1, batch.probes[i]!, tag);
          } catch (error) {
            errors++;
            options.onProgress?.(`${tag} slot#${i + 1} 失败：${publicErrorMessage(error)}`);
          }
        }
      } catch (error) {
        errors++;
        options.onProgress?.(`${tag} 出题失败：${publicErrorMessage(error)}`);
      }
    });

    evalStore.finishRun(runId, "completed");
  } catch (error) {
    evalStore.finishRun(runId, "failed", publicErrorMessage(error));
    throw toPublicError(error);
  }

  return {
    runId,
    sourcesProcessed,
    sourcesSkipped,
    probesCreated,
    accepted,
    rejected,
    dropped,
    errors,
    byType,
    totalAgentCalls: evalStore.countAgentCalls(runRef),
  };
}
