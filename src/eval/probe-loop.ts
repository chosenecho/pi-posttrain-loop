import { createWarmupGate, runConcurrentPool } from "../shared/concurrency.js";
import { PublicError, publicErrorMessage, toPublicError } from "../shared/public-error.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../shared/retry.js";
import { nonEmpty, validateConcurrency, validateMaxAttempts } from "../shared/schema.js";
import type { EvalRole, RoleRunner } from "../shared/types.js";
import {
  EvalStore,
  PROBE_TYPES,
  TRAP_PROBE_TYPES,
  type EvalProfile,
  type ExpectedBehavior,
  type ProbeType,
  type SourceMaterialRecord,
} from "./store/index.js";
import type { EvalPromptBundle } from "./eval-prompts.js";
import {
  buildSoftMixGuidance,
  normalizeProbeMix,
  PROBE_PERSONAS,
} from "./probe-planner.js";
import {
  parseDraftProbes,
  verifyAnchorInMaterial,
} from "./probe-schema.js";
import { runProbeCriticStage, type MutableProbeState, type TrackedInvoker } from "./probe-stage-critic.js";
import { runProbeDialogueStage } from "./probe-stage-dialogue.js";
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

interface QueuedProbe extends MutableProbeState {
  probeId: number;
  specId: number;
  slotIndex: number;
  source: SourceMaterialRecord;
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

  const invokeTracked: TrackedInvoker = async <T>(params: {
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
  }) => {
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
  };

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
    //   2A: [probe-critic <-> probe-writer] -> [optional blind bare_answer -> probe-critic(bare_check) -> probe-writer]
    //   2B+2C: [per-turn adversary -> probe-critic -> reference <-> verifier] -> [rubric-v2 -> atomic accept]
    await runConcurrentPool(probeQueue, concurrency, async (item) => {
      const { probeId, specId, slotIndex, source } = item;
      const current: MutableProbeState = {
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

      try {
        criticEvaluated++;
        const criticResult = await runProbeCriticStage({
          evalStore,
          invokeTracked,
          probeId,
          specId,
          slotIndex,
          source,
          current,
          allowedTypes,
          writerPrompt,
          criticPrompt,
          maxCriticRevisions,
          bareCheck: bareEnabled && options.runBareModel && barePrompt && bareModelId
            ? {
                runBareModel: options.runBareModel,
                barePrompt,
                bareModelId,
                maxBareRefinements,
              }
            : undefined,
          collectSiblingQuestions,
          onQuestionUpdated: (q) => latestQuestionsBySourceId.get(source.id)?.set(probeId, q),
          onQuestionRemoved: () => latestQuestionsBySourceId.get(source.id)?.delete(probeId),
          makeTag,
          onProgress: options.onProgress,
        });
        bareChecked += criticResult.bareChecked;
        bareTriggeredRevisions += criticResult.bareTriggeredRevisions;
        if (!criticResult.accepted) return;

        criticAccepted++;
        evalStore.setProbeStatus(probeId, "answering");

        verifierEvaluated++;
        const dialogueResult = await runProbeDialogueStage({
          evalStore,
          invokeTracked,
          probeId,
          source,
          current,
          criticPrompt,
          referencePrompt,
          verifierPrompt,
          adversaryPrompt,
          rubricPrompt,
          maxCriticRevisions,
          maxAnswerAttempts,
          makeTag,
          onProgress: options.onProgress,
        });
        if (dialogueResult.verifierPassed) {
          verifierPassed++;
        }
      } catch (error) {
        probeErrors++;
        const msg = publicErrorMessage(error);
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
    totalAgentCalls: evalStore.countAgentCalls(runRef),
    errors: draftErrors + probeErrors,
  };
}
