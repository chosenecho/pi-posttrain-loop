import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../retry.js";
import { nonEmpty, validateConcurrency, validateMaxAttempts } from "../schema.js";
import { PublicError, publicErrorMessage, toPublicError } from "../shared/public-error.js";
import { createWarmupGate, runConcurrentPool } from "../shared/concurrency.js";
import type { EvalRole, RoleRunner } from "../types.js";
import {
  EvalStore,
  isTrapProbeType,
  PRESSURE_ADVERSARY_TACTICS,
  PROBE_TYPES,
  TRAP_ADVERSARY_TACTICS,
  TRAP_PROBE_TYPES,
  type AdversaryTactic,
  type EvalProfile,
  type ExpectedBehavior,
  type ProbeType,
  type SourceMaterialRecord,
} from "./eval-db.js";
import type { EvalPromptBundle } from "./eval-prompts.js";
import {
  buildSoftMixGuidance,
  normalizeProbeMix,
  PROBE_PERSONAS,
} from "./probe-planner.js";
import {
  parseAdversaryTurn,
  parseCriticReview,
  parseDraftProbes,
  parseProbeRubric,
  parseRevisedProbe,
  parseVerifierReview,
  verifyAnchorInMaterial,
  type ProbeRubricV2,
} from "./probe-schema.js";
import { verifySourceSplits } from "./source-import.js";

/** Default upper bound on probes the agent may plan per video (the agent decides the actual 0..N count). */
export const DEFAULT_PROBES_PER_VIDEO = 6;
export const DEFAULT_MAX_CRITIC_REVISIONS = 2;
export const DEFAULT_MAX_ANSWER_ATTEMPTS = 3;
export const DEFAULT_MAX_BARE_REFINEMENTS = 1;

export interface RunProbeBuildOptions {
  evalStore: EvalStore;
  sources: SourceMaterialRecord[];
  /** When provided, verifies every source's `split = 'test'` & sha256 against main DB (read-only) before building. */
  mainDbPath?: string;
  prompts: EvalPromptBundle["prompts"];
  skills: EvalPromptBundle["skills"];
  runRole: RoleRunner;
  modelId: string;
  /** Optional build profile label recorded in run config (`adversarial` | `trap`). */
  profile?: EvalProfile;
  /** Maximum probes per video; `probe-writer` autonomously chooses 0..probesPerVideo based on material depth. */
  probesPerVideo?: number;
  /** Soft global mix weights (types with weight 0 are disallowed). */
  mix?: Partial<Record<ProbeType, number>>;
  seed?: number;
  maxCriticRevisions?: number;
  maxAnswerAttempts?: number;
  /**
   * Optional inline bare-model adversarial feedback loop:
   * after Turn 1 passes `probe-critic`, runs a transcript-free bare generic model on `question`
   * and feeds `bareAnswer` back to `probe-critic` (`mode: "bare_check"`). If the bare model
   * nails it effortlessly or exposes unseen private trivia, sends `bareAnswer` + feedback back
   * to `probe-writer` (`mode: "revise"`) to sharpen or pivot before investing in reference/rubric calls.
   */
  runBareModel?: RoleRunner;
  barePrompt?: string;
  bareModelId?: string;
  maxBareRefinements?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  onProgress?: (message: string) => void;
}

export interface RunProbeBuildSummary {
  runId: number;
  modelId: string;
  bareModelId?: string;
  videos: number;
  skippedVideos: number;
  plannedSlots: number;
  draftedProbes: number;
  draftErrors: number;
  criticEvaluated: number;
  criticAccepted: number;
  criticAcceptRate: number;
  bareChecked: number;
  bareTriggeredRevisions: number;
  verifierEvaluated: number;
  verifierPassed: number;
  verifierPassRate: number;
  statusCounts: Record<string, number>;
  accepted: number;
  acceptedTurns: number;
  acceptedByType: Record<string, number>;
  acceptedByPersona: Record<string, number>;
  anchorVerifiedRate: number;
  totalAgentCalls: number;
  errors: number;
}

export async function runProbeBuild(options: RunProbeBuildOptions): Promise<RunProbeBuildSummary> {
  const { evalStore, sources, runRole, modelId } = options;
  if (sources.length === 0) {
    throw new Error("没有可用于构建考题的 source_materials（请先运行 eval import）");
  }

  const maxProbesPerVideo = options.probesPerVideo ?? DEFAULT_PROBES_PER_VIDEO;
  if (!Number.isSafeInteger(maxProbesPerVideo) || maxProbesPerVideo < 1 || maxProbesPerVideo > 20) {
    throw new Error("probesPerVideo 必须是 1–20 的整数");
  }
  const maxCriticRevisions = options.maxCriticRevisions ?? DEFAULT_MAX_CRITIC_REVISIONS;
  if (!Number.isSafeInteger(maxCriticRevisions) || maxCriticRevisions < 0 || maxCriticRevisions > 5) {
    throw new Error("maxCriticRevisions 必须是 0–5 的整数");
  }
  const maxBareRefinements = options.maxBareRefinements ?? DEFAULT_MAX_BARE_REFINEMENTS;
  if (!Number.isSafeInteger(maxBareRefinements) || maxBareRefinements < 0 || maxBareRefinements > 3) {
    throw new Error("maxBareRefinements 必须是 0–3 的整数");
  }
  const maxAnswerAttempts = validateMaxAttempts(options.maxAnswerAttempts ?? DEFAULT_MAX_ANSWER_ATTEMPTS);
  const concurrency = validateConcurrency(options.concurrency ?? 1);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const effectiveMix = normalizeProbeMix(options.mix);
  const allowedTypes = PROBE_TYPES.filter((t) => effectiveMix[t] > 0);
  if (allowedTypes.length === 0) {
    throw new Error("题型配比至少需要一个正权重类型");
  }

  // Validate prompts before touching DB
  const writerPrompt = nonEmpty(options.prompts.probeWriter, "probe-writer 提示词");
  const criticPrompt = nonEmpty(options.prompts.probeCritic, "probe-critic 提示词");
  const referencePrompt = nonEmpty(options.prompts.reference, "reference 提示词");
  const verifierPrompt = nonEmpty(options.prompts.verifier, "verifier 提示词");
  const rubricPrompt = nonEmpty(options.prompts.rubricV2, "rubric-v2 提示词");
  const needsAdversary =
    effectiveMix.pressure > 0 || TRAP_PROBE_TYPES.some((t) => effectiveMix[t] > 0);
  const adversaryPrompt = needsAdversary
    ? nonEmpty(options.prompts.adversary, "adversary 提示词")
    : options.prompts.adversary;
  const bareEnabled = Boolean(options.runBareModel && options.barePrompt);
  const barePrompt = bareEnabled ? nonEmpty(options.barePrompt, "bare-answer 提示词") : undefined;
  const bareModelId = bareEnabled ? (options.bareModelId ?? modelId) : undefined;

  // Guardrail #1: Cross-DB test-split + sha256 verification before any LLM call
  if (options.mainDbPath) {
    verifySourceSplits(options.mainDbPath, sources);
  }

  evalStore.markInterruptedRuns();

  const liveTypeCounts: Record<ProbeType, number> = evalStore.countAcceptedProbesByType();

  const runId = evalStore.createRun({
    kind: "probe_build",
    config: {
      architecture: "agent-loop-v3",
      profile: options.profile ?? "adversarial",
      modelId,
      ...(bareModelId ? { bareModelId, maxBareRefinements } : {}),
      videos: sources.length,
      videoIds: sources.map((s) => s.videoId),
      maxProbesPerVideo,
      mix: effectiveMix,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      maxCriticRevisions,
      maxAnswerAttempts,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
    },
    prompts: {
      probe_writer: writerPrompt,
      probe_critic: criticPrompt,
      reference: referencePrompt,
      verifier: verifierPrompt,
      ...(adversaryPrompt ? { adversary: adversaryPrompt } : {}),
      rubric_v2: rubricPrompt,
      ...(barePrompt ? { bare_answer: barePrompt } : {}),
    },
    skills: options.skills,
  });

  const runRef = `probe_run:${runId}`;
  const warmupGate = createWarmupGate();

  async function invokeTracked<T>(params: {
    role: EvalRole;
    sourceMaterialId: number;
    runner?: RoleRunner;
    model?: string;
    systemPrompt: string;
    inputRefs: Record<string, unknown>;
    wireInput: Record<string, unknown>;
    parse: (raw: string) => T;
    tag: string;
    skipWarmup?: boolean;
  }): Promise<{ callId: number; output: string; parsed: T }> {
    const effectiveRunner = params.runner ?? runRole;
    const effectiveModel = params.model ?? modelId;
    const callId = evalStore.startCall({
      runRef,
      role: params.role,
      model: effectiveModel,
      inputRefs: params.inputRefs,
    });
    let lastRawOutput: string | undefined;
    try {
      const result = await runWithRetry({
        maxAttempts: callMaxAttempts,
        delayMs: callRetryDelayMs,
        run: async () => {
          lastRawOutput = undefined;
          const exec = () => effectiveRunner({
            role: params.role,
            systemPrompt: params.systemPrompt,
            input: params.wireInput,
          });
          const output = params.skipWarmup
            ? await exec()
            : await warmupGate.run(`${params.sourceMaterialId}:${params.role}`, concurrency > 1, exec);
          lastRawOutput = output;
          try {
            return { output, parsed: params.parse(output) };
          } catch {
            throw new PublicError("model_output_invalid");
          }
        },
        onRetry: (attempt, max, error) => {
          options.onProgress?.(`${params.tag} ${params.role} call:${callId} 失败（第 ${attempt}/${max} 次），重试：${publicErrorMessage(error)}`);
        },
      });
      evalStore.finishCall(callId, { output: result.output });
      return { callId, output: result.output, parsed: result.parsed };
    } catch (error) {
      const safeError = toPublicError(error, "model_request_failed");
      const msg = publicErrorMessage(safeError);
      evalStore.finishCall(callId, { output: lastRawOutput, error: msg });
      throw safeError;
    }
  }

  interface QueuedProbe {
    probeId: number;
    specId: number;
    slotIndex: number;
    source: SourceMaterialRecord;
    probeType: ProbeType;
    persona: string;
    expectedBehavior: ExpectedBehavior;
    targetTurns: number;
    question: string;
    anchor: string;
    trap: string;
    anchorVerified: boolean;
  }

  const probeQueue: QueuedProbe[] = [];
  const existingBySourceId = new Map<number, string[]>();
  const latestQuestionsBySourceId = new Map<number, Map<number, string>>();

  let skippedVideos = 0;
  let plannedSlots = 0;
  let draftedProbes = 0;
  let draftErrors = 0;
  let criticEvaluated = 0;
  let criticAccepted = 0;
  let bareChecked = 0;
  let bareTriggeredRevisions = 0;
  let verifierEvaluated = 0;
  let verifierPassed = 0;
  let probeErrors = 0;

  try {
    // Stage 1: Agent-autonomous planning & drafting per video (0..maxProbesPerVideo)
    // Writer reads the material and decides how many probes it truly merits, which probe types,
    // personas, and multi-turn counts fit best, guided only softly by global mix gaps.
    await runConcurrentPool(sources, Math.min(concurrency, sources.length), async (source) => {
      const existingQuestions = evalStore.listExistingQuestionsForVideoKey(source.videoKey);
      existingBySourceId.set(source.id, existingQuestions);
      const latestMap = new Map<number, string>();
      latestQuestionsBySourceId.set(source.id, latestMap);
      const tag = `[draft:${source.videoId}]`;
      const mixGuidance = buildSoftMixGuidance(effectiveMix, liveTypeCounts);

      try {
        const { parsed: batch } = await invokeTracked({
          role: "probe_writer",
          sourceMaterialId: source.id,
          systemPrompt: writerPrompt,
          inputRefs: {
            source_material_id: source.id,
            video_id: source.videoId,
            mode: "draft",
            max_probes: maxProbesPerVideo,
          },
          wireInput: {
            material: source.content,
            mode: "draft",
            videoId: source.videoId,
            partCount: source.partCount,
            maxProbes: maxProbesPerVideo,
            allowedTypes: mixGuidance.allowedTypes,
            preferredMix: mixGuidance.targetWeights,
            currentTypeCounts: mixGuidance.currentCounts,
            underrepresentedTypes: mixGuidance.underrepresentedTypes,
            suggestedPersonas: [...PROBE_PERSONAS],
            ...(existingQuestions.length > 0 ? { existingQuestions } : {}),
          },
          parse: (raw) => parseDraftProbes(raw, { maxProbes: maxProbesPerVideo, allowedTypes }),
          tag,
        });

        if (batch.probes.length === 0) {
          skippedVideos++;
          options.onProgress?.(`${tag} 出题员主动跳过本视频（0 题）`);
          return;
        }

        evalStore.transaction(() => {
          for (const item of batch.probes) {
            const specId = evalStore.createSpec({
              runId,
              sourceMaterialId: source.id,
              slotIndex: item.slotIndex,
              probeType: item.probeType,
              persona: item.persona,
              targetTurns: item.targetTurns,
            });
            // Advisory diagnostic only — never blocks the loop
            const anchorVerified = item.anchor.length > 0 && verifyAnchorInMaterial(item.anchor, source.content);
            const probeId = evalStore.createProbe({
              specId,
              question: item.question,
              anchor: item.anchor,
              trap: item.trap,
              expectedBehavior: item.expectedBehavior,
              anchorVerified,
            });
            plannedSlots++;
            draftedProbes++;
            liveTypeCounts[item.probeType] = (liveTypeCounts[item.probeType] ?? 0) + 1;
            latestMap.set(probeId, item.question);
            probeQueue.push({
              probeId,
              specId,
              slotIndex: item.slotIndex,
              source,
              probeType: item.probeType,
              persona: item.persona,
              expectedBehavior: item.expectedBehavior,
              targetTurns: item.targetTurns,
              question: item.question,
              anchor: item.anchor,
              trap: item.trap,
              anchorVerified,
            });
          }
        });
        options.onProgress?.(`${tag} 自主规划并出题 ${batch.probes.length} 题（上限 ${maxProbesPerVideo}）`);
      } catch (error) {
        draftErrors++;
        options.onProgress?.(`${tag} probe-writer 失败：${publicErrorMessage(error)}`);
      }
    });

    // Stage 2: Per-probe concurrent Agent Loop:
    //   [probe-critic <-> probe-writer] -> [optional blind bare_answer -> probe-critic(bare_check) -> probe-writer]
    //   -> [per-turn adversary(dynamic tactic) -> probe-critic -> reference <-> verifier] -> [rubric-v2]
    await runConcurrentPool(probeQueue, concurrency, async (item) => {
      const { probeId, specId, slotIndex, source } = item;
      let activeTurnId: number | undefined;

      const current = {
        probeType: item.probeType,
        persona: item.persona,
        expectedBehavior: item.expectedBehavior,
        targetTurns: item.targetTurns,
        question: item.question,
        anchor: item.anchor,
        trap: item.trap,
        anchorVerified: item.anchorVerified,
      };

      const makeTag = () => `[p${probeId}:${source.videoId}:s${slotIndex}:${current.probeType}]`;

      const collectSiblingQuestions = (): string[] => {
        const list = [...(existingBySourceId.get(source.id) ?? [])];
        const latestMap = latestQuestionsBySourceId.get(source.id);
        if (latestMap) {
          for (const [otherId, qText] of latestMap.entries()) {
            if (otherId !== probeId) list.push(qText);
          }
        }
        return list;
      };

      const applyRewrite = async (params: {
        roundNo: number;
        issues: string[];
        feedback: string;
        bareAnswer?: string;
        siblingQuestions: string[];
      }): Promise<void> => {
        const rewriteCall = await invokeTracked({
          role: "probe_writer",
          sourceMaterialId: source.id,
          systemPrompt: writerPrompt,
          inputRefs: {
            probe_id: probeId,
            source_material_id: source.id,
            mode: "revise",
            round_no: params.roundNo,
            ...(params.bareAnswer ? { triggered_by: "bare_check" } : {}),
          },
          wireInput: {
            material: source.content,
            mode: "revise",
            videoId: source.videoId,
            allowedTypes,
            slot: {
              slotIndex,
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
            ...(params.bareAnswer ? { bareAnswer: params.bareAnswer } : {}),
            issues: params.issues,
            feedback: params.feedback,
            ...(params.siblingQuestions.length > 0 ? { existingQuestions: params.siblingQuestions } : {}),
          },
          parse: (raw) => parseRevisedProbe(raw, {
            slotIndex,
            probeType: current.probeType,
            persona: current.persona,
            targetTurns: current.targetTurns,
            allowedTypes,
          }),
          tag: `${makeTag()}[rw${params.roundNo}]`,
        });

        const revised = rewriteCall.parsed;
        const nextAnchorVerified = revised.anchor.length > 0 && verifyAnchorInMaterial(revised.anchor, source.content);
        const specChanged =
          revised.probeType !== current.probeType ||
          revised.persona !== current.persona ||
          revised.targetTurns !== current.targetTurns;

        evalStore.transaction(() => {
          if (specChanged) {
            evalStore.updateSpec(specId, {
              probeType: revised.probeType,
              persona: revised.persona,
              targetTurns: revised.targetTurns,
            });
          }
          evalStore.reviseProbe(probeId, {
            question: revised.question,
            anchor: revised.anchor,
            trap: revised.trap,
            anchorVerified: nextAnchorVerified,
            expectedBehavior: revised.expectedBehavior,
          });
        });

        current.probeType = revised.probeType;
        current.persona = revised.persona;
        current.expectedBehavior = revised.expectedBehavior;
        current.targetTurns = revised.targetTurns;
        current.question = revised.question;
        current.anchor = revised.anchor;
        current.trap = revised.trap;
        current.anchorVerified = nextAnchorVerified;
        latestQuestionsBySourceId.get(source.id)?.set(probeId, current.question);
      };

      try {
        // ---- Stage 2A: Turn-1 Agent Loop (probe-critic + optional blind bare-model check <-> probe-writer) ----
        criticEvaluated++;
        let passedStage2A = false;
        let reviewSeq = 0;
        let criticRevisions = 0;
        let bareRefinements = 0;

        while (true) {
          // Step 2A.1: Semantic review by probe-critic (including semantic deduplication vs existingQuestions)
          let passedStaticCritic = false;
          while (true) {
            reviewSeq++;
            const siblingQuestions = collectSiblingQuestions();
            const criticCall = await invokeTracked({
              role: "probe_critic",
              sourceMaterialId: source.id,
              systemPrompt: criticPrompt,
              inputRefs: {
                probe_id: probeId,
                source_material_id: source.id,
                mode: "probe",
                round_no: reviewSeq,
                probe_type: current.probeType,
                anchor_verified: current.anchorVerified,
              },
              wireInput: {
                material: source.content,
                mode: "probe",
                probeType: current.probeType,
                persona: current.persona,
                expectedBehavior: current.expectedBehavior,
                question: current.question,
                anchor: current.anchor,
                anchorVerified: current.anchorVerified,
                trap: current.trap,
                ...(siblingQuestions.length > 0 ? { existingQuestions: siblingQuestions } : {}),
              },
              parse: parseCriticReview,
              tag: `${makeTag()}[c${reviewSeq}]`,
            });

            const review = criticCall.parsed;
            evalStore.addReview({
              probeId,
              roundNo: reviewSeq,
              decision: review.decision,
              issues: review.issues,
              feedback: review.feedback,
              questionSnapshot: current.question,
              callId: criticCall.callId,
            });

            if (review.decision === "accept") {
              passedStaticCritic = true;
              options.onProgress?.(`${makeTag()} critic accept (round ${reviewSeq})`);
              break;
            }

            if (review.decision === "reject") {
              evalStore.setProbeStatus(probeId, "rejected", "critic_rejected");
              latestQuestionsBySourceId.get(source.id)?.delete(probeId);
              options.onProgress?.(`${makeTag()} critic reject (round ${reviewSeq})`);
              return;
            }

            if (criticRevisions >= maxCriticRevisions) {
              evalStore.setProbeStatus(
                probeId,
                "rejected",
                `审题改写达到上限（${maxCriticRevisions} 次）`,
              );
              latestQuestionsBySourceId.get(source.id)?.delete(probeId);
              options.onProgress?.(`${makeTag()} critic exhausted after ${criticRevisions} revisions`);
              return;
            }

            options.onProgress?.(`${makeTag()} critic revise (round ${reviewSeq}) -> 重写中...`);
            await applyRewrite({
              roundNo: reviewSeq,
              issues: review.issues,
              feedback: review.feedback,
              siblingQuestions,
            });
            criticRevisions++;
          }

          if (!passedStaticCritic) return;

          // Step 2A.2: Optional inline blind bare-model trial -> probe-critic(bare_check) feedback loop
          if (!bareEnabled || !options.runBareModel || !barePrompt) {
            passedStage2A = true;
            break;
          }

          bareChecked++;
          // Guardrail #2 (Blind Isolation): bare model NEVER receives material / anchor / trap / expectedBehavior!
          const bareCall = await invokeTracked({
            role: "bare_answer",
            sourceMaterialId: source.id,
            runner: options.runBareModel,
            model: bareModelId,
            systemPrompt: barePrompt,
            inputRefs: {
              probe_id: probeId,
              stage: "inline_bare_check",
              refinement_no: bareRefinements,
            },
            wireInput: {
              question: current.question,
            },
            parse: (raw) => nonEmpty(raw, "裸答试考正文"),
            tag: `${makeTag()}[bare${bareRefinements + 1}]`,
            skipWarmup: true,
          });

          reviewSeq++;
          const bareCheckCall = await invokeTracked({
            role: "probe_critic",
            sourceMaterialId: source.id,
            systemPrompt: criticPrompt,
            inputRefs: {
              probe_id: probeId,
              source_material_id: source.id,
              mode: "bare_check",
              round_no: reviewSeq,
              bare_call_id: bareCall.callId,
            },
            wireInput: {
              material: source.content,
              mode: "bare_check",
              probeType: current.probeType,
              persona: current.persona,
              expectedBehavior: current.expectedBehavior,
              question: current.question,
              anchor: current.anchor,
              trap: current.trap,
              bareAnswer: bareCall.parsed,
            },
            parse: parseCriticReview,
            tag: `${makeTag()}[bc${bareRefinements + 1}]`,
          });

          const bareReview = bareCheckCall.parsed;
          evalStore.addReview({
            probeId,
            roundNo: reviewSeq,
            decision: bareReview.decision,
            issues: bareReview.issues,
            feedback: bareReview.feedback,
            questionSnapshot: current.question,
            callId: bareCheckCall.callId,
          });

          if (bareReview.decision === "accept") {
            passedStage2A = true;
            options.onProgress?.(`${makeTag()} bare-check accept（通用模型确有区分度）`);
            break;
          }

          if (bareReview.decision === "reject") {
            evalStore.setProbeStatus(
              probeId,
              "rejected",
              "bare_check_rejected",
            );
            latestQuestionsBySourceId.get(source.id)?.delete(probeId);
            options.onProgress?.(`${makeTag()} bare-check reject (round ${reviewSeq})`);
            return;
          }

          if (bareRefinements >= maxBareRefinements) {
            evalStore.setProbeStatus(
              probeId,
              "rejected",
              `裸答对抗强化达到上限（${maxBareRefinements} 次）`,
            );
            latestQuestionsBySourceId.get(source.id)?.delete(probeId);
            options.onProgress?.(`${makeTag()} bare-check exhausted after ${bareRefinements} refinements`);
            return;
          }

          bareRefinements++;
          bareTriggeredRevisions++;
          options.onProgress?.(`${makeTag()} bare-check revise -> 结合裸答回流改题...`);
          await applyRewrite({
            roundNo: reviewSeq,
            issues: bareReview.issues,
            feedback: bareReview.feedback,
            bareAnswer: bareCall.parsed,
            siblingQuestions: collectSiblingQuestions(),
          });
          // Re-enter outer loop so the sharpened probe goes through probe-critic again
        }

        if (!passedStage2A) return;
        criticAccepted++;
        evalStore.setProbeStatus(probeId, "answering");

        // ---- Stage 2B: Multi-turn dialogue loop (All-or-Nothing across turnNo = 1..current.targetTurns) ----
        verifierEvaluated++;
        const historyMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
        const usedTactics: AdversaryTactic[] = [];
        interface PassedTurnInfo {
          turnNo: number;
          turnId: number;
          userContent: string;
          expectedBehavior: ExpectedBehavior;
          tactic?: AdversaryTactic;
          trap: string;
          answer: string;
          passedAttemptId: number;
        }
        const passedTurns: PassedTurnInfo[] = [];

        for (let turnNo = 1; turnNo <= current.targetTurns; turnNo++) {
          let turnUser = current.question;
          let turnBehavior: ExpectedBehavior = current.expectedBehavior;
          let turnTactic: AdversaryTactic | undefined;
          let turnTrap = current.trap;

          if (turnNo > 1) {
            turnBehavior = "hold_position";
            if (!adversaryPrompt) {
              throw new Error(`Probe ${probeId} Turn ${turnNo} 缺少 adversary 提示词`);
            }

            const tacticPool: readonly AdversaryTactic[] = isTrapProbeType(current.probeType)
              ? TRAP_ADVERSARY_TACTICS
              : PRESSURE_ADVERSARY_TACTICS;
            const availableTactics = tacticPool.filter((t) => !usedTactics.includes(t));
            const fallbackTactic: AdversaryTactic = availableTactics[0] ?? tacticPool[0]!;

            // Adversary autonomously chooses the sharpest tactic against the actual previous turn
            let acceptedPressure: { tactic: AdversaryTactic; userContent: string; trap: string } | undefined;
            let prevDraft: { tactic: AdversaryTactic; userContent: string; trap: string } | undefined;
            let lastIssues: string[] = [];
            let lastFeedback = "";

            for (let advRound = 1; advRound <= maxCriticRevisions + 1; advRound++) {
              const advCall = await invokeTracked({
                role: "adversary",
                sourceMaterialId: source.id,
                systemPrompt: adversaryPrompt,
                inputRefs: {
                  probe_id: probeId,
                  turn_no: turnNo,
                  round_no: advRound,
                },
                wireInput: {
                  material: source.content,
                  history: [...historyMessages],
                  probeType: current.probeType,
                  persona: current.persona,
                  availableTactics: availableTactics.length > 0 ? availableTactics : [...tacticPool],
                  ...(usedTactics.length > 0 ? { usedTactics: [...usedTactics] } : {}),
                  turnNo,
                  targetTurns: current.targetTurns,
                  anchor: current.anchor,
                  ...(prevDraft ? { previousDraft: prevDraft, issues: lastIssues, feedback: lastFeedback } : {}),
                },
                parse: (raw) => parseAdversaryTurn(raw, fallbackTactic),
                tag: `${makeTag()}[t${turnNo}:adv${advRound}]`,
              });

              const draftAdv = advCall.parsed;
              const pCriticCall = await invokeTracked({
                role: "probe_critic",
                sourceMaterialId: source.id,
                systemPrompt: criticPrompt,
                inputRefs: {
                  probe_id: probeId,
                  mode: "pressure_turn",
                  turn_no: turnNo,
                  tactic: draftAdv.tactic,
                  round_no: advRound,
                },
                wireInput: {
                  material: source.content,
                  history: [...historyMessages],
                  mode: "pressure_turn",
                  probeType: current.probeType,
                  persona: current.persona,
                  tactic: draftAdv.tactic,
                  ...(usedTactics.length > 0 ? { usedTactics: [...usedTactics] } : {}),
                  turnNo,
                  userContent: draftAdv.userContent,
                  trap: draftAdv.trap,
                },
                parse: parseCriticReview,
                tag: `${makeTag()}[t${turnNo}:pc${advRound}]`,
              });

              const pReview = pCriticCall.parsed;
              if (pReview.decision === "accept") {
                acceptedPressure = draftAdv;
                options.onProgress?.(`${makeTag()}[t${turnNo}:${draftAdv.tactic}] adversary accepted (round ${advRound})`);
                break;
              }
              if (pReview.decision === "reject" || advRound > maxCriticRevisions) {
                evalStore.setProbeStatus(
                  probeId,
                  "dropped",
                  `Turn ${turnNo}（${draftAdv.tactic}）施压话术未通过审题`,
                );
                options.onProgress?.(`${makeTag()}[t${turnNo}:${draftAdv.tactic}] adversary dropped by critic`);
                return;
              }
              prevDraft = draftAdv;
              lastIssues = pReview.issues;
              lastFeedback = pReview.feedback;
              options.onProgress?.(`${makeTag()}[t${turnNo}:${draftAdv.tactic}] adversary revise (round ${advRound})`);
            }

            if (!acceptedPressure) return;
            turnTactic = acceptedPressure.tactic;
            turnUser = acceptedPressure.userContent;
            turnTrap = acceptedPressure.trap;
            usedTactics.push(turnTactic);
          }

          activeTurnId = evalStore.createTurn({
            probeId,
            turnNo,
            userContent: turnUser,
            expectedBehavior: turnBehavior,
            tactic: turnTactic,
          });

          let previousAnswer = "";
          let feedback = "";
          let turnPassedAnswer: string | undefined;
          let turnPassedAttemptId: number | undefined;

          for (let attemptNo = 1; attemptNo <= maxAnswerAttempts; attemptNo++) {
            const refCall = await invokeTracked({
              role: "reference",
              sourceMaterialId: source.id,
              systemPrompt: referencePrompt,
              inputRefs: {
                probe_id: probeId,
                turn_id: activeTurnId,
                turn_no: turnNo,
                attempt_no: attemptNo,
                expected_behavior: turnBehavior,
              },
              wireInput: {
                material: source.content,
                ...(historyMessages.length > 0 ? { history: [...historyMessages] } : {}),
                question: turnUser,
                probeType: current.probeType,
                expectedBehavior: turnBehavior,
                ...(attemptNo > 1 ? { previousAnswer, feedback } : {}),
              },
              parse: (raw) => nonEmpty(raw, "参考答案"),
              tag: `${makeTag()}[t${turnNo}:a${attemptNo}]`,
            });

            const answer = refCall.parsed;
            const attemptId = evalStore.addAttempt({
              turnId: activeTurnId,
              attemptNo,
              answer,
              answerCallId: refCall.callId,
            });

            const verCall = await invokeTracked({
              role: "verifier",
              sourceMaterialId: source.id,
              systemPrompt: verifierPrompt,
              inputRefs: {
                probe_id: probeId,
                turn_id: activeTurnId,
                turn_no: turnNo,
                attempt_id: attemptId,
                attempt_no: attemptNo,
              },
              wireInput: {
                material: source.content,
                ...(historyMessages.length > 0 ? { history: [...historyMessages] } : {}),
                probeType: current.probeType,
                expectedBehavior: turnBehavior,
                ...(turnTactic ? { tactic: turnTactic } : {}),
                question: turnUser,
                anchor: current.anchor,
                trap: turnTrap,
                answer,
              },
              parse: parseVerifierReview,
              tag: `${makeTag()}[t${turnNo}:v${attemptNo}]`,
            });

            const ver = verCall.parsed;
            evalStore.reviewAttempt(attemptId, {
              decision: ver.decision,
              issues: ver.issues,
              feedback: ver.feedback,
              verifyCallId: verCall.callId,
            });

            if (ver.decision === "pass") {
              turnPassedAnswer = answer;
              turnPassedAttemptId = attemptId;
              evalStore.finishTurn(activeTurnId, "pass", attemptId);
              options.onProgress?.(`${makeTag()}[t${turnNo}/${current.targetTurns}] verifier pass (attempt ${attemptNo})`);
              break;
            }

            if (ver.decision === "drop") {
              evalStore.finishTurn(activeTurnId, "dropped");
              evalStore.setProbeStatus(probeId, "dropped", `Turn ${turnNo} 核验放弃`);
              options.onProgress?.(`${makeTag()}[t${turnNo}] verifier drop (attempt ${attemptNo})`);
              return;
            }

            previousAnswer = answer;
            feedback = ver.feedback;
            options.onProgress?.(`${makeTag()}[t${turnNo}] verifier revise (attempt ${attemptNo})`);
          }

          if (turnPassedAnswer === undefined || turnPassedAttemptId === undefined) {
            evalStore.finishTurn(activeTurnId, "exhausted");
            evalStore.setProbeStatus(
              probeId,
              "dropped",
              `Turn ${turnNo} 参考答案核验返工达到上限（${maxAnswerAttempts} 次）`,
            );
            options.onProgress?.(`${makeTag()}[t${turnNo}] verifier exhausted`);
            return;
          }

          passedTurns.push({
            turnNo,
            turnId: activeTurnId,
            userContent: turnUser,
            expectedBehavior: turnBehavior,
            tactic: turnTactic,
            trap: turnTrap,
            answer: turnPassedAnswer,
            passedAttemptId: turnPassedAttemptId,
          });
          historyMessages.push({ role: "user", content: turnUser });
          historyMessages.push({ role: "assistant", content: turnPassedAnswer });
          activeTurnId = undefined;
        }

        verifierPassed++;

        // ---- Stage 2C: Extract concise transferable rubric-v2 for EVERY passed turn, then atomically accept ----
        const extractedRubrics: Array<{ turnId: number; rubric: ProbeRubricV2; callId: number }> = [];
        for (let tIdx = 0; tIdx < passedTurns.length; tIdx++) {
          const pt = passedTurns[tIdx];
          const priorHistory = historyMessages.slice(0, tIdx * 2);
          const rubricCall = await invokeTracked({
            role: "rubric_v2",
            sourceMaterialId: source.id,
            systemPrompt: rubricPrompt,
            inputRefs: {
              probe_id: probeId,
              turn_id: pt.turnId,
              turn_no: pt.turnNo,
              attempt_id: pt.passedAttemptId,
              expected_behavior: pt.expectedBehavior,
            },
            wireInput: {
              material: source.content,
              ...(priorHistory.length > 0 ? { history: priorHistory } : {}),
              probeType: current.probeType,
              expectedBehavior: pt.expectedBehavior,
              ...(pt.tactic ? { tactic: pt.tactic } : {}),
              question: pt.userContent,
              anchor: current.anchor,
              trap: pt.trap,
              referenceAnswer: pt.answer,
            },
            parse: (raw) => parseProbeRubric(raw, pt.expectedBehavior),
            tag: `${makeTag()}[t${pt.turnNo}:rubric]`,
          });
          extractedRubrics.push({ turnId: pt.turnId, rubric: rubricCall.parsed, callId: rubricCall.callId });
        }

        evalStore.transaction(() => {
          for (const item of extractedRubrics) {
            evalStore.saveRubric({
              turnId: item.turnId,
              rubric: item.rubric,
              callId: item.callId,
            });
          }
          evalStore.setProbeStatus(probeId, "accepted");
        });
        options.onProgress?.(
          `${makeTag()} accepted (${passedTurns.length} turn${passedTurns.length > 1 ? "s" : ""}, rubrics=${extractedRubrics.length})`,
        );
      } catch (error) {
        probeErrors++;
        const msg = publicErrorMessage(error);
        if (activeTurnId !== undefined) {
          evalStore.finishTurn(activeTurnId, "error");
        }
        evalStore.setProbeStatus(probeId, "error", msg);
        options.onProgress?.(`${makeTag()} error: ${msg}`);
      }
    });

    evalStore.finishRun(runId, "completed");
  } catch (error) {
    evalStore.finishRun(runId, "failed", publicErrorMessage(error));
    throw toPublicError(error);
  }

  const probes = evalStore.listProbes({ runId });
  const statusCounts: Record<string, number> = {};
  const acceptedByType: Record<string, number> = {};
  const acceptedByPersona: Record<string, number> = {};
  let acceptedAnchorVerified = 0;
  let acceptedTurns = 0;

  for (const p of probes) {
    statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
    if (p.status === "accepted") {
      acceptedByType[p.probeType] = (acceptedByType[p.probeType] ?? 0) + 1;
      acceptedByPersona[p.persona] = (acceptedByPersona[p.persona] ?? 0) + 1;
      if (p.anchorVerified) acceptedAnchorVerified++;
      acceptedTurns += evalStore.getProbeDialogue(p.id).length;
    }
  }

  const accepted = statusCounts.accepted ?? 0;
  const totalCallsRow = evalStore.db.prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ?").get(runRef) as { c: number };

  return {
    runId,
    modelId,
    ...(bareModelId ? { bareModelId } : {}),
    videos: sources.length,
    skippedVideos,
    plannedSlots,
    draftedProbes,
    draftErrors,
    criticEvaluated,
    criticAccepted,
    criticAcceptRate: criticEvaluated > 0 ? Number((criticAccepted / criticEvaluated).toFixed(4)) : 0,
    bareChecked,
    bareTriggeredRevisions,
    verifierEvaluated,
    verifierPassed,
    verifierPassRate: verifierEvaluated > 0 ? Number((verifierPassed / verifierEvaluated).toFixed(4)) : 0,
    statusCounts,
    accepted,
    acceptedTurns,
    acceptedByType,
    acceptedByPersona,
    anchorVerifiedRate: accepted > 0 ? Number((acceptedAnchorVerified / accepted).toFixed(4)) : 0,
    totalAgentCalls: Number(totalCallsRow.c),
    errors: draftErrors + probeErrors,
  };
}
