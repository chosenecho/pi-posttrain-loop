import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../retry.js";
import { errorMessage, nonEmpty, validateConcurrency, validateMaxAttempts } from "../schema.js";
import { createWarmupGate, runConcurrentPool } from "../shared/concurrency.js";
import type { EvalRole, RoleRunner } from "../types.js";
import {
  EvalStore,
  type AdversaryTactic,
  type ExpectedBehavior,
  type ProbeType,
  type SourceMaterialRecord,
} from "./eval-db.js";
import type { EvalPromptBundle } from "./eval-prompts.js";
import {
  DEFAULT_PROBE_MIX,
  planProbeSlots,
  summarizePlan,
  type PlannedProbeSlot,
} from "./probe-planner.js";
import {
  DUPLICATE_NGRAM_THRESHOLD,
  findNearDuplicate,
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

export const DEFAULT_PROBES_PER_VIDEO = 8;
export const DEFAULT_MAX_CRITIC_REVISIONS = 2;
export const DEFAULT_MAX_ANSWER_ATTEMPTS = 3;

export interface RunProbeBuildOptions {
  evalStore: EvalStore;
  sources: SourceMaterialRecord[];
  /** When provided, verifies every source's `split = 'test'` & sha256 against main DB (read-only) before building. */
  mainDbPath?: string;
  prompts: EvalPromptBundle["prompts"];
  skills: EvalPromptBundle["skills"];
  runRole: RoleRunner;
  modelId: string;
  probesPerVideo?: number;
  mix?: Partial<Record<ProbeType, number>>;
  seed?: number;
  maxCriticRevisions?: number;
  maxAnswerAttempts?: number;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  onProgress?: (message: string) => void;
}

export interface RunProbeBuildSummary {
  runId: number;
  modelId: string;
  videos: number;
  plannedSlots: number;
  draftedProbes: number;
  draftErrors: number;
  duplicateRejected: number;
  criticEvaluated: number;
  criticAccepted: number;
  criticAcceptRate: number;
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

function targetLengthHintFor(probeType: ProbeType, turnNo = 1): string {
  if (turnNo > 1) {
    return "short（150–400 字，正面接住施压点并稳住立场，不复读前轮）";
  }
  switch (probeType) {
    case "wild_short":
      return "short（150–350 字，快刀斩乱麻，直给判断与核心推理）";
    case "hallucination_bait":
      return "short（80–300 字，第一人称自然坦承边界，简洁收尾不凑字数）";
    case "premise_trap":
    case "contrast":
    case "transfer":
    case "pressure":
      return "medium（350–750 字，论证扎实紧凑）";
  }
}

export async function runProbeBuild(options: RunProbeBuildOptions): Promise<RunProbeBuildSummary> {
  const { evalStore, sources, runRole, modelId } = options;
  if (sources.length === 0) {
    throw new Error("没有可用于构建考题的 source_materials（请先运行 eval import）");
  }

  const probesPerVideo = options.probesPerVideo ?? DEFAULT_PROBES_PER_VIDEO;
  const maxCriticRevisions = options.maxCriticRevisions ?? DEFAULT_MAX_CRITIC_REVISIONS;
  if (!Number.isSafeInteger(maxCriticRevisions) || maxCriticRevisions < 0 || maxCriticRevisions > 5) {
    throw new Error("maxCriticRevisions 必须是 0–5 的整数");
  }
  const maxAnswerAttempts = validateMaxAttempts(options.maxAnswerAttempts ?? DEFAULT_MAX_ANSWER_ATTEMPTS);
  const concurrency = validateConcurrency(options.concurrency ?? 1);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);

  const effectiveMix: Record<ProbeType, number> = options.mix
    ? {
        wild_short: options.mix.wild_short ?? 0,
        premise_trap: options.mix.premise_trap ?? 0,
        contrast: options.mix.contrast ?? 0,
        transfer: options.mix.transfer ?? 0,
        hallucination_bait: options.mix.hallucination_bait ?? 0,
        pressure: options.mix.pressure ?? 0,
      }
    : { ...DEFAULT_PROBE_MIX };

  // Validate prompts before touching DB
  const writerPrompt = nonEmpty(options.prompts.probeWriter, "probe-writer 提示词");
  const criticPrompt = nonEmpty(options.prompts.probeCritic, "probe-critic 提示词");
  const referencePrompt = nonEmpty(options.prompts.reference, "reference 提示词");
  const verifierPrompt = nonEmpty(options.prompts.verifier, "verifier 提示词");
  const rubricPrompt = nonEmpty(options.prompts.rubricV2, "rubric-v2 提示词");
  const adversaryPrompt = effectiveMix.pressure > 0
    ? nonEmpty(options.prompts.adversary, "adversary 提示词")
    : options.prompts.adversary;

  // Cross-DB split + sha256 verification before any LLM call
  if (options.mainDbPath) {
    verifySourceSplits(options.mainDbPath, sources);
  }

  evalStore.markInterruptedRuns();

  const planBySource = planProbeSlots(sources, {
    probesPerVideo,
    mix: effectiveMix,
    seed: options.seed,
  });
  const planSummary = summarizePlan(planBySource);

  const runId = evalStore.createRun({
    kind: "probe_build",
    config: {
      modelId,
      videos: sources.length,
      videoIds: sources.map((s) => s.videoId),
      probesPerVideo,
      mix: effectiveMix,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      maxCriticRevisions,
      maxAnswerAttempts,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      planned: planSummary,
    },
    prompts: {
      probe_writer: writerPrompt,
      probe_critic: criticPrompt,
      reference: referencePrompt,
      verifier: verifierPrompt,
      ...(adversaryPrompt ? { adversary: adversaryPrompt } : {}),
      rubric_v2: rubricPrompt,
    },
    skills: options.skills,
  });

  const runRef = `probe_run:${runId}`;
  const specIdByKey = new Map<string, number>();
  evalStore.transaction(() => {
    for (const source of sources) {
      for (const slot of planBySource.get(source.id)!) {
        const specId = evalStore.createSpec({
          runId,
          sourceMaterialId: source.id,
          slotIndex: slot.slotIndex,
          probeType: slot.probeType,
          persona: slot.persona,
          targetTurns: slot.targetTurns,
        });
        specIdByKey.set(`${source.id}:${slot.slotIndex}`, specId);
      }
    }
  });

  const warmupGate = createWarmupGate();

  async function invokeTracked<T>(params: {
    role: EvalRole;
    sourceMaterialId: number;
    systemPrompt: string;
    inputRefs: Record<string, unknown>;
    wireInput: Record<string, unknown>;
    parse: (raw: string) => T;
    tag: string;
  }): Promise<{ callId: number; output: string; parsed: T }> {
    const callId = evalStore.startCall({
      runRef,
      role: params.role,
      model: modelId,
      inputRefs: params.inputRefs,
    });
    let lastRawOutput: string | undefined;
    try {
      const result = await runWithRetry({
        maxAttempts: callMaxAttempts,
        delayMs: callRetryDelayMs,
        run: async () => {
          lastRawOutput = undefined;
          const output = await warmupGate.run(
            `${params.sourceMaterialId}:${params.role}`,
            concurrency > 1,
            () => runRole({
              role: params.role,
              systemPrompt: params.systemPrompt,
              input: params.wireInput,
            }),
          );
          lastRawOutput = output;
          return { output, parsed: params.parse(output) };
        },
        onRetry: (attempt, max, error) => {
          options.onProgress?.(`${params.tag} ${params.role} 失败（第 ${attempt}/${max} 次），重试：${errorMessage(error)}`);
        },
      });
      evalStore.finishCall(callId, { output: result.output });
      return { callId, output: result.output, parsed: result.parsed };
    } catch (error) {
      const msg = errorMessage(error);
      evalStore.finishCall(callId, { output: lastRawOutput, error: msg });
      throw new Error(msg);
    }
  }

  interface QueuedProbe {
    probeId: number;
    source: SourceMaterialRecord;
    slot: PlannedProbeSlot;
    question: string;
    anchor: string;
    trap: string;
    anchorVerified: boolean;
  }

  const probeQueue: QueuedProbe[] = [];
  const existingBySourceId = new Map<number, string[]>();
  const latestQuestionsBySourceId = new Map<number, Map<number, string>>();

  let draftErrors = 0;
  let duplicateRejected = 0;
  let draftedProbes = 0;
  let criticEvaluated = 0;
  let criticAccepted = 0;
  let verifierEvaluated = 0;
  let verifierPassed = 0;
  let probeErrors = 0;

  try {
    // Stage 1: Per-video batch probe drafting (concurrent across videos)
    await runConcurrentPool(sources, concurrency, async (source, vIdx) => {
      const slots = planBySource.get(source.id)!;
      const existingQuestions = evalStore.listExistingQuestionsForVideoKey(source.videoKey);
      existingBySourceId.set(source.id, existingQuestions);
      const latestMap = new Map<number, string>();
      latestQuestionsBySourceId.set(source.id, latestMap);

      const tag = `[v${vIdx + 1}/${sources.length}:${source.videoId}]`;
      options.onProgress?.(`${tag} probe-writer 出题（${slots.length} 槽位）...`);

      try {
        const expectedSlotIndices = slots.map((s) => s.slotIndex);
        const { parsed: drafts } = await invokeTracked({
          role: "probe_writer",
          sourceMaterialId: source.id,
          systemPrompt: writerPrompt,
          inputRefs: {
            source_material_id: source.id,
            video_id: source.videoId,
            mode: "draft",
            slot_count: slots.length,
          },
          wireInput: {
            material: source.content,
            mode: "draft",
            videoId: source.videoId,
            partCount: source.partCount,
            slots: slots.map((s) => ({
              slotIndex: s.slotIndex,
              probeType: s.probeType,
              persona: s.persona,
              expectedBehavior: s.expectedBehavior,
            })),
            ...(existingQuestions.length > 0 ? { existingQuestions } : {}),
          },
          parse: (raw) => parseDraftProbes(raw, expectedSlotIndices),
          tag,
        });

        const seenForVideo = [...existingQuestions];
        const slotByIndex = new Map(slots.map((s) => [s.slotIndex, s]));

        for (const item of drafts) {
          const slot = slotByIndex.get(item.slotIndex)!;
          const specId = specIdByKey.get(`${source.id}:${slot.slotIndex}`)!;
          const anchorVerified = verifyAnchorInMaterial(item.anchor, source.content);
          const probeId = evalStore.createProbe({
            specId,
            question: item.question,
            anchor: item.anchor,
            trap: item.trap,
            expectedBehavior: slot.expectedBehavior,
            anchorVerified,
          });
          draftedProbes++;

          const dup = findNearDuplicate(item.question, seenForVideo, DUPLICATE_NGRAM_THRESHOLD);
          if (dup) {
            evalStore.setProbeStatus(
              probeId,
              "rejected",
              `n-gram 重复预筛拦截（相似度 ${dup.similarity.toFixed(2)}）：${dup.matchedQuestion.slice(0, 48)}`,
            );
            duplicateRejected++;
            options.onProgress?.(`${tag}[s${slot.slotIndex}:p${probeId}] 重复预筛拦截 (sim=${dup.similarity.toFixed(2)})`);
            continue;
          }

          seenForVideo.push(item.question);
          latestMap.set(probeId, item.question);
          probeQueue.push({
            probeId,
            source,
            slot,
            question: item.question,
            anchor: item.anchor,
            trap: item.trap,
            anchorVerified,
          });
        }
        options.onProgress?.(`${tag} 出题完成（入审 ${drafts.length} 题，预筛去重后待审 ${latestMap.size} 题）`);
      } catch (error) {
        draftErrors++;
        options.onProgress?.(`${tag} probe-writer 失败：${errorMessage(error)}`);
      }
    });

    // Stage 2: Per-probe concurrent critic -> (turn 1..targetTurns: [adversary+critic] -> reference <-> verifier) -> per-turn rubric-v2
    await runConcurrentPool(probeQueue, concurrency, async (item) => {
      const { probeId, source, slot } = item;
      const tag = `[p${probeId}:${source.videoId}:s${slot.slotIndex}:${slot.probeType}]`;
      let activeTurnId: number | undefined;

      const current = {
        question: item.question,
        anchor: item.anchor,
        trap: item.trap,
        anchorVerified: item.anchorVerified,
      };

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
        // ---- Stage 2A: Turn-1 probe-critic <-> probe-writer (revision) ----
        criticEvaluated++;
        let passedCritic = false;
        let revisions = 0;

        for (let roundNo = 1; roundNo <= maxCriticRevisions + 1; roundNo++) {
          const siblingQuestions = collectSiblingQuestions();
          const criticCall = await invokeTracked({
            role: "probe_critic",
            sourceMaterialId: source.id,
            systemPrompt: criticPrompt,
            inputRefs: {
              probe_id: probeId,
              source_material_id: source.id,
              mode: "probe",
              round_no: roundNo,
              probe_type: slot.probeType,
              anchor_verified: current.anchorVerified,
            },
            wireInput: {
              material: source.content,
              mode: "probe",
              probeType: slot.probeType,
              persona: slot.persona,
              expectedBehavior: slot.expectedBehavior,
              question: current.question,
              anchor: current.anchor,
              anchorVerified: current.anchorVerified,
              trap: current.trap,
              ...(siblingQuestions.length > 0 ? { existingQuestions: siblingQuestions } : {}),
            },
            parse: parseCriticReview,
            tag: `${tag}[c${roundNo}]`,
          });

          const review = criticCall.parsed;
          evalStore.addReview({
            probeId,
            roundNo,
            decision: review.decision,
            issues: review.issues,
            feedback: review.feedback,
            questionSnapshot: current.question,
            callId: criticCall.callId,
          });

          if (review.decision === "accept") {
            passedCritic = true;
            criticAccepted++;
            evalStore.setProbeStatus(probeId, "answering");
            options.onProgress?.(`${tag} critic accept (round ${roundNo})`);
            break;
          }

          if (review.decision === "reject") {
            evalStore.setProbeStatus(probeId, "rejected", review.feedback || review.issues.join("; "));
            latestQuestionsBySourceId.get(source.id)?.delete(probeId);
            options.onProgress?.(`${tag} critic reject: ${(review.feedback || review.issues[0] || "").slice(0, 60)}`);
            return;
          }

          if (revisions >= maxCriticRevisions) {
            evalStore.setProbeStatus(
              probeId,
              "rejected",
              `审题改写达到上限（${maxCriticRevisions} 次）：${review.feedback}`,
            );
            latestQuestionsBySourceId.get(source.id)?.delete(probeId);
            options.onProgress?.(`${tag} critic exhausted after ${revisions} revisions`);
            return;
          }

          options.onProgress?.(`${tag} critic revise (round ${roundNo}) -> 重写中...`);
          const rewriteCall = await invokeTracked({
            role: "probe_writer",
            sourceMaterialId: source.id,
            systemPrompt: writerPrompt,
            inputRefs: {
              probe_id: probeId,
              source_material_id: source.id,
              mode: "revise",
              round_no: roundNo,
            },
            wireInput: {
              material: source.content,
              mode: "revise",
              videoId: source.videoId,
              slot: {
                slotIndex: slot.slotIndex,
                probeType: slot.probeType,
                persona: slot.persona,
                expectedBehavior: slot.expectedBehavior,
              },
              previousProbe: {
                question: current.question,
                anchor: current.anchor,
                trap: current.trap,
              },
              issues: review.issues,
              feedback: review.feedback,
              ...(siblingQuestions.length > 0 ? { existingQuestions: siblingQuestions } : {}),
            },
            parse: (raw) => parseRevisedProbe(raw, slot.slotIndex),
            tag: `${tag}[rw${roundNo}]`,
          });

          const revised = rewriteCall.parsed;
          const nextAnchorVerified = verifyAnchorInMaterial(revised.anchor, source.content);
          evalStore.reviseProbe(probeId, {
            question: revised.question,
            anchor: revised.anchor,
            trap: revised.trap,
            anchorVerified: nextAnchorVerified,
          });
          current.question = revised.question;
          current.anchor = revised.anchor;
          current.trap = revised.trap;
          current.anchorVerified = nextAnchorVerified;
          revisions++;
          latestQuestionsBySourceId.get(source.id)?.set(probeId, current.question);

          const dup = findNearDuplicate(current.question, siblingQuestions, DUPLICATE_NGRAM_THRESHOLD);
          if (dup) {
            evalStore.setProbeStatus(
              probeId,
              "rejected",
              `改写后命中 n-gram 重复拦截（相似度 ${dup.similarity.toFixed(2)}）：${dup.matchedQuestion.slice(0, 48)}`,
            );
            latestQuestionsBySourceId.get(source.id)?.delete(probeId);
            duplicateRejected++;
            options.onProgress?.(`${tag} rewrite duplicate rejected (sim=${dup.similarity.toFixed(2)})`);
            return;
          }
        }

        if (!passedCritic) return;

        // ---- Stage 2B: Multi-turn dialogue loop (All-or-Nothing across turnNo = 1..slot.targetTurns) ----
        verifierEvaluated++;
        const historyMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
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

        for (let turnNo = 1; turnNo <= slot.targetTurns; turnNo++) {
          let turnUser = current.question;
          let turnBehavior: ExpectedBehavior = slot.expectedBehavior;
          let turnTactic: AdversaryTactic | undefined;
          let turnTrap = current.trap;

          if (turnNo > 1) {
            turnTactic = slot.tactics[turnNo - 2];
            turnBehavior = "hold_position";
            if (!turnTactic || !adversaryPrompt) {
              throw new Error(`Probe ${probeId} Turn ${turnNo} 缺少施压手法或 adversary 提示词`);
            }

            // Draft & critic-check the pressure follow-up so it targets stance (not Turn-1 phrasing)
            let acceptedPressure: { userContent: string; trap: string } | undefined;
            let prevDraft: { userContent: string; trap: string } | undefined;
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
                  tactic: turnTactic,
                  round_no: advRound,
                },
                wireInput: {
                  material: source.content,
                  history: [...historyMessages],
                  probeType: "pressure",
                  persona: slot.persona,
                  tactic: turnTactic,
                  turnNo,
                  targetTurns: slot.targetTurns,
                  anchor: current.anchor,
                  ...(turnNo > 2 ? { usedTactics: slot.tactics.slice(0, turnNo - 2) } : {}),
                  ...(prevDraft ? { previousDraft: prevDraft, issues: lastIssues, feedback: lastFeedback } : {}),
                },
                parse: parseAdversaryTurn,
                tag: `${tag}[t${turnNo}:adv${advRound}]`,
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
                  tactic: turnTactic,
                  round_no: advRound,
                },
                wireInput: {
                  material: source.content,
                  history: [...historyMessages],
                  mode: "pressure_turn",
                  probeType: "pressure",
                  persona: slot.persona,
                  tactic: turnTactic,
                  turnNo,
                  userContent: draftAdv.userContent,
                  trap: draftAdv.trap,
                },
                parse: parseCriticReview,
                tag: `${tag}[t${turnNo}:pc${advRound}]`,
              });

              const pReview = pCriticCall.parsed;
              if (pReview.decision === "accept") {
                acceptedPressure = draftAdv;
                options.onProgress?.(`${tag}[t${turnNo}:${turnTactic}] adversary accepted (round ${advRound})`);
                break;
              }
              if (pReview.decision === "reject" || advRound > maxCriticRevisions) {
                evalStore.setProbeStatus(
                  probeId,
                  "dropped",
                  `Turn ${turnNo}（${turnTactic}）施压话术未通过审题：${pReview.feedback || pReview.issues.join("; ")}`,
                );
                options.onProgress?.(`${tag}[t${turnNo}:${turnTactic}] adversary dropped by critic`);
                return;
              }
              prevDraft = draftAdv;
              lastIssues = pReview.issues;
              lastFeedback = pReview.feedback;
              options.onProgress?.(`${tag}[t${turnNo}:${turnTactic}] adversary revise (round ${advRound})`);
            }

            if (!acceptedPressure) return;
            turnUser = acceptedPressure.userContent;
            turnTrap = acceptedPressure.trap;
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
          const targetLength = targetLengthHintFor(slot.probeType, turnNo);

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
                probeType: slot.probeType,
                expectedBehavior: turnBehavior,
                targetLength,
                ...(attemptNo > 1 ? { previousAnswer, feedback } : {}),
              },
              parse: (raw) => nonEmpty(raw, "参考答案"),
              tag: `${tag}[t${turnNo}:a${attemptNo}]`,
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
                probeType: slot.probeType,
                expectedBehavior: turnBehavior,
                ...(turnTactic ? { tactic: turnTactic } : {}),
                question: turnUser,
                anchor: current.anchor,
                trap: turnTrap,
                answer,
              },
              parse: parseVerifierReview,
              tag: `${tag}[t${turnNo}:v${attemptNo}]`,
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
              options.onProgress?.(`${tag}[t${turnNo}/${slot.targetTurns}] verifier pass (attempt ${attemptNo})`);
              break;
            }

            if (ver.decision === "drop") {
              evalStore.finishTurn(activeTurnId, "dropped");
              evalStore.setProbeStatus(probeId, "dropped", `Turn ${turnNo} 核验放弃：${ver.feedback || ver.issues.join("; ")}`);
              options.onProgress?.(`${tag}[t${turnNo}] verifier drop: ${(ver.feedback || ver.issues[0] || "").slice(0, 60)}`);
              return;
            }

            previousAnswer = answer;
            feedback = ver.feedback;
            options.onProgress?.(`${tag}[t${turnNo}] verifier revise (attempt ${attemptNo})`);
          }

          if (turnPassedAnswer === undefined || turnPassedAttemptId === undefined) {
            evalStore.finishTurn(activeTurnId, "exhausted");
            evalStore.setProbeStatus(
              probeId,
              "dropped",
              `Turn ${turnNo} 参考答案核验返工达到上限（${maxAnswerAttempts} 次）：${feedback}`,
            );
            options.onProgress?.(`${tag}[t${turnNo}] verifier exhausted`);
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

        // ---- Stage 2C: Extract rubric-v2 for EVERY passed turn, then atomically accept probe ----
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
              probeType: slot.probeType,
              expectedBehavior: pt.expectedBehavior,
              ...(pt.tactic ? { tactic: pt.tactic } : {}),
              question: pt.userContent,
              anchor: current.anchor,
              trap: pt.trap,
              referenceAnswer: pt.answer,
            },
            parse: (raw) => parseProbeRubric(raw, pt.expectedBehavior, slot.probeType),
            tag: `${tag}[t${pt.turnNo}:rubric]`,
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
          `${tag} accepted (${passedTurns.length} turn${passedTurns.length > 1 ? "s" : ""}, rubrics=${extractedRubrics.length})`,
        );
      } catch (error) {
        probeErrors++;
        const msg = errorMessage(error);
        if (activeTurnId !== undefined) {
          evalStore.finishTurn(activeTurnId, "error");
        }
        evalStore.setProbeStatus(probeId, "error", msg);
        options.onProgress?.(`${tag} error: ${msg}`);
      }
    });

    evalStore.finishRun(runId, "completed");
  } catch (error) {
    evalStore.finishRun(runId, "failed", errorMessage(error));
    throw error;
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
    videos: sources.length,
    plannedSlots: planSummary.totalSlots,
    draftedProbes,
    draftErrors,
    duplicateRejected,
    criticEvaluated,
    criticAccepted,
    criticAcceptRate: criticEvaluated > 0 ? Number((criticAccepted / criticEvaluated).toFixed(4)) : 0,
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
