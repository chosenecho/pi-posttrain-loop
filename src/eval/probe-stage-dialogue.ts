import { nonEmpty } from "../shared/schema.js";
import {
  EvalStore,
  isTrapProbeType,
  PRESSURE_ADVERSARY_TACTICS,
  TRAP_ADVERSARY_TACTICS,
  type AdversaryTactic,
  type ExpectedBehavior,
  type SourceMaterialRecord,
} from "./store/index.js";
import {
  parseAdversaryTurn,
  parseCriticReview,
  parseProbeRubric,
  parseVerifierReview,
  type ProbeRubricV2,
} from "./probe-schema.js";
import type { MutableProbeState, TrackedInvoker } from "./probe-stage-critic.js";

export interface DialogueStageParams {
  evalStore: EvalStore;
  invokeTracked: TrackedInvoker;
  probeId: number;
  source: SourceMaterialRecord;
  current: MutableProbeState;
  criticPrompt: string;
  referencePrompt: string;
  verifierPrompt: string;
  adversaryPrompt?: string;
  rubricPrompt: string;
  maxCriticRevisions: number;
  maxAnswerAttempts: number;
  makeTag: () => string;
  onProgress?: (message: string) => void;
}

export interface DialogueStageResult {
  verifierPassed: boolean;
  accepted: boolean;
  turnCount: number;
}

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

/**
 * Stage 2B + 2C of the probe pipeline:
 * - Multi-turn all-or-nothing dialogue loop (`adversary` <-> `probe-critic`, `reference` <-> `verifier`)
 * - Concise transferable `rubric-v2` extraction for every passed turn, committed atomically with `accepted` status.
 */
export async function runProbeDialogueStage(params: DialogueStageParams): Promise<DialogueStageResult> {
  const {
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
    onProgress,
  } = params;

  let activeTurnId: number | undefined;
  const historyMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const usedTactics: AdversaryTactic[] = [];
  const passedTurns: PassedTurnInfo[] = [];

  try {
    // Stage 2B: Multi-turn dialogue loop (All-or-Nothing across turnNo = 1..current.targetTurns)
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
            onProgress?.(`${makeTag()}[t${turnNo}:${draftAdv.tactic}] adversary accepted (round ${advRound})`);
            break;
          }
          if (pReview.decision === "reject" || advRound > maxCriticRevisions) {
            evalStore.setProbeStatus(
              probeId,
              "dropped",
              `Turn ${turnNo}（${draftAdv.tactic}）施压话术未通过审题`,
            );
            onProgress?.(`${makeTag()}[t${turnNo}:${draftAdv.tactic}] adversary dropped by critic`);
            return { verifierPassed: false, accepted: false, turnCount: 0 };
          }
          prevDraft = draftAdv;
          lastIssues = pReview.issues;
          lastFeedback = pReview.feedback;
          onProgress?.(`${makeTag()}[t${turnNo}:${draftAdv.tactic}] adversary revise (round ${advRound})`);
        }

        if (!acceptedPressure) {
          return { verifierPassed: false, accepted: false, turnCount: 0 };
        }
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
          onProgress?.(`${makeTag()}[t${turnNo}/${current.targetTurns}] verifier pass (attempt ${attemptNo})`);
          break;
        }

        if (ver.decision === "drop") {
          evalStore.finishTurn(activeTurnId, "dropped");
          evalStore.setProbeStatus(probeId, "dropped", `Turn ${turnNo} 核验放弃`);
          onProgress?.(`${makeTag()}[t${turnNo}] verifier drop (attempt ${attemptNo})`);
          return { verifierPassed: false, accepted: false, turnCount: 0 };
        }

        previousAnswer = answer;
        feedback = ver.feedback;
        onProgress?.(`${makeTag()}[t${turnNo}] verifier revise (attempt ${attemptNo})`);
      }

      if (turnPassedAnswer === undefined || turnPassedAttemptId === undefined) {
        evalStore.finishTurn(activeTurnId, "exhausted");
        evalStore.setProbeStatus(
          probeId,
          "dropped",
          `Turn ${turnNo} 参考答案核验返工达到上限（${maxAnswerAttempts} 次）`,
        );
        onProgress?.(`${makeTag()}[t${turnNo}] verifier exhausted`);
        return { verifierPassed: false, accepted: false, turnCount: 0 };
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

    // Stage 2C: Extract concise transferable rubric-v2 for EVERY passed turn, then atomically accept
    const extractedRubrics: Array<{ turnId: number; rubric: ProbeRubricV2; callId: number }> = [];
    for (let tIdx = 0; tIdx < passedTurns.length; tIdx++) {
      const pt = passedTurns[tIdx]!;
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

    onProgress?.(
      `${makeTag()} accepted (${passedTurns.length} turn${passedTurns.length > 1 ? "s" : ""}, rubrics=${extractedRubrics.length})`,
    );
    return { verifierPassed: true, accepted: true, turnCount: passedTurns.length };
  } catch (error) {
    if (activeTurnId !== undefined) {
      evalStore.finishTurn(activeTurnId, "error");
    }
    throw error;
  }
}
