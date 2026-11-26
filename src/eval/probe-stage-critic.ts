import { nonEmpty } from "../shared/schema.js";
import type { EvalRole, RoleRunner } from "../shared/types.js";
import {
  EvalStore,
  type ExpectedBehavior,
  type ProbeType,
  type SourceMaterialRecord,
} from "./store/index.js";
import {
  parseCriticReview,
  parseRevisedProbe,
  verifyAnchorInMaterial,
} from "./probe-schema.js";

export type TrackedInvoker = <T>(params: {
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
}) => Promise<{ callId: number; output: string; parsed: T }>;

export interface MutableProbeState {
  probeType: ProbeType;
  persona: string;
  expectedBehavior: ExpectedBehavior;
  targetTurns: number;
  question: string;
  anchor: string;
  trap: string;
  anchorVerified: boolean;
}

export interface CriticStageParams {
  evalStore: EvalStore;
  invokeTracked: TrackedInvoker;
  probeId: number;
  specId: number;
  slotIndex: number;
  source: SourceMaterialRecord;
  current: MutableProbeState;
  allowedTypes: ProbeType[];
  writerPrompt: string;
  criticPrompt: string;
  maxCriticRevisions: number;
  bareCheck?: {
    runBareModel: RoleRunner;
    barePrompt: string;
    bareModelId: string;
    maxBareRefinements: number;
  };
  collectSiblingQuestions: () => string[];
  onQuestionUpdated: (question: string) => void;
  onQuestionRemoved: () => void;
  makeTag: () => string;
  onProgress?: (message: string) => void;
}

export interface CriticStageResult {
  accepted: boolean;
  bareChecked: number;
  bareTriggeredRevisions: number;
}

/**
 * Stage 2A of the probe pipeline:
 * Turn-1 review loop (`probe-critic` <-> `probe-writer`) plus optional blind bare-model
 * adversarial feedback loop (`bare_answer` -> `probe-critic(bare_check)` -> `probe-writer`).
 */
export async function runProbeCriticStage(params: CriticStageParams): Promise<CriticStageResult> {
  const {
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
    bareCheck,
    collectSiblingQuestions,
    onQuestionUpdated,
    onQuestionRemoved,
    makeTag,
    onProgress,
  } = params;

  const applyRewrite = async (rewrite: {
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
        round_no: rewrite.roundNo,
        ...(rewrite.bareAnswer ? { triggered_by: "bare_check" } : {}),
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
        ...(rewrite.bareAnswer ? { bareAnswer: rewrite.bareAnswer } : {}),
        issues: rewrite.issues,
        feedback: rewrite.feedback,
        ...(rewrite.siblingQuestions.length > 0 ? { existingQuestions: rewrite.siblingQuestions } : {}),
      },
      parse: (raw) => parseRevisedProbe(raw, {
        slotIndex,
        probeType: current.probeType,
        persona: current.persona,
        targetTurns: current.targetTurns,
        allowedTypes,
      }),
      tag: `${makeTag()}[rw${rewrite.roundNo}]`,
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
    onQuestionUpdated(current.question);
  };

  let reviewSeq = 0;
  let criticRevisions = 0;
  let bareRefinements = 0;
  let bareChecked = 0;
  let bareTriggeredRevisions = 0;

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
        onProgress?.(`${makeTag()} critic accept (round ${reviewSeq})`);
        break;
      }

      if (review.decision === "reject") {
        evalStore.setProbeStatus(probeId, "rejected", "critic_rejected");
        onQuestionRemoved();
        onProgress?.(`${makeTag()} critic reject (round ${reviewSeq})`);
        return { accepted: false, bareChecked, bareTriggeredRevisions };
      }

      if (criticRevisions >= maxCriticRevisions) {
        evalStore.setProbeStatus(
          probeId,
          "rejected",
          `审题改写达到上限（${maxCriticRevisions} 次）`,
        );
        onQuestionRemoved();
        onProgress?.(`${makeTag()} critic exhausted after ${criticRevisions} revisions`);
        return { accepted: false, bareChecked, bareTriggeredRevisions };
      }

      onProgress?.(`${makeTag()} critic revise (round ${reviewSeq}) -> 重写中...`);
      await applyRewrite({
        roundNo: reviewSeq,
        issues: review.issues,
        feedback: review.feedback,
        siblingQuestions,
      });
      criticRevisions++;
    }

    if (!passedStaticCritic) {
      return { accepted: false, bareChecked, bareTriggeredRevisions };
    }

    // Step 2A.2: Optional inline blind bare-model trial -> probe-critic(bare_check) feedback loop
    if (!bareCheck) {
      return { accepted: true, bareChecked, bareTriggeredRevisions };
    }

    bareChecked++;
    // Guardrail #2 (Blind Isolation): bare model NEVER receives material / anchor / trap / expectedBehavior!
    const bareCall = await invokeTracked({
      role: "bare_answer",
      sourceMaterialId: source.id,
      runner: bareCheck.runBareModel,
      model: bareCheck.bareModelId,
      systemPrompt: bareCheck.barePrompt,
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
      onProgress?.(`${makeTag()} bare-check accept（通用模型确有区分度）`);
      return { accepted: true, bareChecked, bareTriggeredRevisions };
    }

    if (bareReview.decision === "reject") {
      evalStore.setProbeStatus(probeId, "rejected", "bare_check_rejected");
      onQuestionRemoved();
      onProgress?.(`${makeTag()} bare-check reject (round ${reviewSeq})`);
      return { accepted: false, bareChecked, bareTriggeredRevisions };
    }

    if (bareRefinements >= bareCheck.maxBareRefinements) {
      evalStore.setProbeStatus(
        probeId,
        "rejected",
        `裸答对抗强化达到上限（${bareCheck.maxBareRefinements} 次）`,
      );
      onQuestionRemoved();
      onProgress?.(`${makeTag()} bare-check exhausted after ${bareRefinements} refinements`);
      return { accepted: false, bareChecked, bareTriggeredRevisions };
    }

    bareRefinements++;
    bareTriggeredRevisions++;
    onProgress?.(`${makeTag()} bare-check revise -> 结合裸答回流改题...`);
    await applyRewrite({
      roundNo: reviewSeq,
      issues: bareReview.issues,
      feedback: bareReview.feedback,
      bareAnswer: bareCall.parsed,
      siblingQuestions: collectSiblingQuestions(),
    });
    // Re-enter outer loop so the sharpened probe goes through probe-critic again
  }
}
