import { createWarmupGate, runConcurrentPool } from "../shared/concurrency.js";
import { isOperationAborted, throwIfAborted } from "../shared/cancellation.js";
import { publicErrorMessage, toPublicError } from "../shared/public-error.js";
import { DEFAULT_CALL_MAX_ATTEMPTS, DEFAULT_CALL_RETRY_DELAY_MS, runWithRetry, validateCallMaxAttempts, validateCallRetryDelayMs } from "../shared/retry.js";
import { asObject, nonEmpty, parseJson, validateConcurrency } from "../shared/schema.js";
import type { EvalRole, RoleRunner } from "../shared/types.js";
import type { EvalBuildPrompts, EvalSkillSnapshot } from "./eval-prompts.js";
import { assertBuildCheckpoint, assertBuildSpec, probeBuildSpecHash } from "./probe-checkpoint.js";
import { parseAdversaryTurn, parseCriticReview, parseProbeDraftBatch, parseProbeRevision, parseVerifierResult, verifyAnchorInMaterial } from "./probe-schema.js";
import { ADVERSARY_TACTICS, EvalStore, expectedBehaviorForTurn, PROBE_TYPES, type ProbeBuildCheckpoint, type ProbeBuildPlanRecord, type ProbeBuildSlotRecord, type ProbeBuildSlotStatus, type ProbeBuildSpec, type ProbeType, type SourceMaterialRecord } from "./store/index.js";

export const DEFAULT_MAX_PROBES_PER_VIDEO = 5;
export const DEFAULT_MAX_CRITIC_REVISIONS = 2;
export const DEFAULT_MAX_ANSWER_ATTEMPTS = 2;
const DEFAULT_PERSONAS = ["普通提问者", "打工人", "学生", "杠精网友", "学者", "同情者", "反对者"] as const;
export interface SoftTypeGuidance { currentTypeCounts: Record<ProbeType, number>; underrepresentedTypes: ProbeType[]; }
export function buildSoftTypeGuidance(existingCounts: Record<string, number>, allowedTypes: readonly ProbeType[] = PROBE_TYPES): SoftTypeGuidance {
  const currentTypeCounts = {} as Record<ProbeType, number>;
  let total = 0;
  for (const type of PROBE_TYPES) { currentTypeCounts[type] = existingCounts[type] ?? 0; if (allowedTypes.includes(type)) total += currentTypeCounts[type]; }
  const avg = allowedTypes.length ? total / allowedTypes.length : 0;
  return { currentTypeCounts, underrepresentedTypes: allowedTypes.filter(t => currentTypeCounts[t] <= avg).sort((a, b) => currentTypeCounts[a] - currentTypeCounts[b]) };
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
  rebuild?: boolean;
  resumeBuildRunId?: number;
  signal?: AbortSignal;
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
  newProbes: number;
  resumedSlots: number;
  newlyCompleted: number;
  reusedTerminal: number;
  pendingSlots: number;
  errorSlots: number;
  partial: boolean;
  plansComplete: boolean;
  executionCompleted: boolean;
  planIds: number[];
  probeIds: number[];
  incompleteLegacyPlans: number[];
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    for (const code of ["checkpoint_invalid", "build_snapshot_missing", "legacy_plan_incomplete", "build_config_conflict", "operation_aborted"]) if (error.message.startsWith(code)) return code;
  }
  return toPublicError(error).code;
}
function checkAbort(signal?: AbortSignal): void { throwIfAborted(signal); }
const terminal = (status: string) => ["accepted", "rejected", "dropped"].includes(status);
function parseCompleteBatch(raw: string, spec: ProbeBuildSpec) {
  const value = asObject(parseJson(raw), "probe-writer 输出");
  if (!Array.isArray(value.probes) || value.probes.length > spec.maxProbesPerVideo) throw new Error("probe-writer 批次数量超过上限");
  return parseProbeDraftBatch(raw, { maxProbes: spec.maxProbesPerVideo, allowedTypes: spec.allowedTypes });
}

export async function runProbeBuildLoop(options: RunProbeBuildLoopOptions): Promise<RunProbeBuildLoopSummary> {
  const { evalStore, sources, runRole } = options;
  const signals = [options.signal, evalStore.signal].filter((value): value is AbortSignal => value !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const concurrency = validateConcurrency(options.concurrency ?? 4);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const currentSpec: ProbeBuildSpec = {
    version: 1, modelId: options.modelId,
    allowedTypes: options.allowedTypes?.length ? [...options.allowedTypes] : [...PROBE_TYPES],
    maxProbesPerVideo: options.maxProbesPerVideo ?? DEFAULT_MAX_PROBES_PER_VIDEO,
    maxRevisions: options.maxRevisions ?? DEFAULT_MAX_CRITIC_REVISIONS,
    maxAnswerAttempts: options.maxAnswerAttempts ?? DEFAULT_MAX_ANSWER_ATTEMPTS,
    prompts: options.prompts,
    skills: options.skills.map(({ name, status, sha256 }) => ({ name, status, sha256 })),
  };
  if (!Number.isSafeInteger(currentSpec.maxProbesPerVideo) || currentSpec.maxProbesPerVideo < 1 || !Number.isSafeInteger(currentSpec.maxRevisions) || currentSpec.maxRevisions < 0 || !Number.isSafeInteger(currentSpec.maxAnswerAttempts) || currentSpec.maxAnswerAttempts < 1) throw new Error("造题预算必须为有效整数");
  if (options.rebuild && options.resumeBuildRunId !== undefined) throw new Error("build_config_conflict: rebuild and resume");
  checkAbort(signal);

  // Resolve all immutable specifications before creating a run or mutating an existing plan.
  const selections = sources.map(source => {
    const plans = evalStore.listBuildPlans({ sourceMaterialId: source.id, ...(options.resumeBuildRunId === undefined ? { latestOnly: true } : { originRunId: options.resumeBuildRunId }) });
    const plan = options.rebuild ? undefined : plans.at(-1);
    if (options.resumeBuildRunId !== undefined && !plan) throw new Error(`build_snapshot_missing: source #${source.id}`);
    if (plan && !["done", "skipped"].includes(plan.status)) {
      if (plan.errorCode === "checkpoint_invalid") throw new Error(`checkpoint_invalid: plan #${plan.id}`);
      if (plan.spec !== null || options.resumeBuildRunId !== undefined || plan.errorCode !== "legacy_plan_incomplete") {
        assertBuildSpec(plan, source.contentSha256);
        if (options.resumeBuildRunId === undefined && plan.specHash !== probeBuildSpecHash(currentSpec, source.contentSha256)) throw new Error(`build_config_conflict: plan #${plan.id}`);
      }
    }
    return { source, plan };
  });
  evalStore.ensureRecovered();
  const runSpec = options.resumeBuildRunId === undefined ? currentSpec : selections.find(selection => selection.plan?.spec)?.plan?.spec ?? currentSpec;
  const runId = evalStore.createRun({ kind: "probe_build", config: { ...(options.configSnapshot ?? {}), ...runSpec, concurrency, callMaxAttempts, callRetryDelayMs, resumeBuildRunId: options.resumeBuildRunId, rebuild: Boolean(options.rebuild), planSpecs: selections.map(selection => ({ sourceMaterialId: selection.source.id, specHash: selection.plan?.specHash ?? probeBuildSpecHash(currentSpec, selection.source.contentSha256) })) }, prompts: { ...runSpec.prompts }, skills: options.resumeBuildRunId === undefined ? options.skills : runSpec.skills });
  const runRef = `probe_build:${runId}`;
  const warmup = createWarmupGate();
  const summary: RunProbeBuildLoopSummary = { runId, sourcesProcessed: 0, sourcesSkipped: 0, probesCreated: 0, accepted: 0, rejected: 0, dropped: 0, errors: 0, byType: {}, totalAgentCalls: 0, newProbes: 0, resumedSlots: 0, newlyCompleted: 0, reusedTerminal: 0, pendingSlots: 0, errorSlots: 0, partial: false, plansComplete: true, executionCompleted: false, planIds: [], probeIds: [], incompleteLegacyPlans: [] };

  async function invoke<T>(plan: ProbeBuildPlanRecord, slot: ProbeBuildSlotRecord | undefined, cp: ProbeBuildCheckpoint | undefined, spec: ProbeBuildSpec, role: EvalRole, systemPrompt: string, input: Record<string, unknown>, parse: (raw: string) => T, operationSignal: AbortSignal | undefined = signal): Promise<{ callId: number; result: T; raw: string }> {
    const savedId = slot ? cp?.pendingCallId : plan.writerCallId;
    const saved = savedId ? evalStore.getAgentCall(savedId) : undefined;
    if (saved && saved.output !== null && saved.error === null) {
      try { return { callId: saved.id, raw: saved.output, result: parse(saved.output) }; }
      catch (error) { evalStore.finishCall(saved.id, { output: saved.output, error: publicErrorMessage(toPublicError(error, "model_output_invalid")) }); throw toPublicError(error, "model_output_invalid"); }
    }
    return warmup.run(role, true, () => runWithRetry({
      maxAttempts: callMaxAttempts, delayMs: callRetryDelayMs, signal: operationSignal,
      shouldRetry: error => !isOperationAborted(error),
      run: async () => {
        checkAbort(operationSignal);
        const callInput = { runRef, role, model: spec.modelId, inputRefs: { source_material_id: plan.sourceMaterialId, plan_id: plan.id, ...(slot && cp ? { slot_id: slot.id, probe_id: slot.probeId, stage: cp.stage, turn_no: cp.turnNo, attempt: cp.attempt, round_no: cp.roundNo } : { stage: "planning", mode: "draft" }) } };
        const callId = slot && cp ? evalStore.startBuildSlotCall(slot.id, runId, cp, callInput) : evalStore.startBuildPlanning(plan.id, callInput);
        if (cp) cp.pendingCallId = callId;
        let raw: string | undefined;
        try {
          raw = await runRole({ role, systemPrompt, input, signal: operationSignal });
          checkAbort(operationSignal);
          // Retain a complete remote response even if the process exits before parsing/committing its next checkpoint.
          evalStore.finishCall(callId, { output: raw });
          let result: T;
          try { result = parse(raw); } catch (error) { throw toPublicError(error, "model_output_invalid"); }
          return { callId, result, raw };
        } catch (error) {
          evalStore.finishCall(callId, { output: raw, error: publicErrorMessage(error) });
          checkAbort(operationSignal);
          if (isOperationAborted(error)) throw error;
          throw toPublicError(error);
        }
      },
    }));
  }

  async function processSlot(source: SourceMaterialRecord, plan: ProbeBuildPlanRecord, slot: ProbeBuildSlotRecord, spec: ProbeBuildSpec, workerSignal: AbortSignal): Promise<void> {
    if (!slot.probeId) throw new Error(`checkpoint_invalid: missing probe for slot #${slot.id}`);
    const probeId = slot.probeId;
    let cp = slot.checkpoint;
    const commit = (next: ProbeBuildCheckpoint, mutate?: () => void, status?: ProbeBuildSlotStatus) => {
      evalStore.commitBuildCheckpoint({ slotId: slot.id, executionRunId: runId, checkpoint: next, status }, mutate);
      cp = next;
    };
    if (cp.stage === "done") {
      const probe = evalStore.getProbe(probeId)!;
      const turns = evalStore.listProbeTurns(probeId);
      assertBuildCheckpoint(cp, probe, turns, spec);
      if (turns.length !== probe.targetTurns) throw new Error(`checkpoint_invalid: probe #${probeId} unfinished final checkpoint`);
      commit(cp, () => evalStore.setProbeStatus(probeId, "accepted"), "accepted");
      summary.accepted++;
      summary.newlyCompleted++;
      summary.byType[probe.probeType] = (summary.byType[probe.probeType] ?? 0) + 1;
    }
    while (cp.stage !== "done") {
      checkAbort(workerSignal);
      const probe = evalStore.getProbe(probeId)!;
      const turns = evalStore.listProbeTurns(probeId);
      assertBuildCheckpoint(cp, probe, turns, spec);
      const history = turns.flatMap(t => [{ role: "user", content: t.userContent }, { role: "assistant", content: t.referenceAnswer }]);
      const usedTactics = turns.flatMap(t => t.tactic ? [t.tactic] : []);
      const expectedBehavior = expectedBehaviorForTurn(probe.probeType, cp.turnNo);
      const finish = (status: "accepted" | "rejected" | "dropped", reason?: string, mutate?: () => void) => {
        commit({ ...cp, stage: "done", pendingCallId: undefined }, () => { mutate?.(); evalStore.setProbeStatus(probeId, status, reason); }, status);
        summary[status]++;
        summary.newlyCompleted++;
        if (status === "accepted") summary.byType[probe.probeType] = (summary.byType[probe.probeType] ?? 0) + 1;
      };
      if (cp.stage === "critic") {
        const siblings = evalStore.listExistingQuestionsForSource(source.id, probeId);
        const { callId, result: review } = await invoke(plan, slot, cp, spec, "probe_critic", spec.prompts.probeCritic, { material: source.content, probeType: probe.probeType, persona: probe.persona, expectedBehavior: probe.expectedBehavior, targetTurns: probe.targetTurns, question: probe.question, anchor: probe.anchor, anchorVerified: probe.anchorVerified, trap: probe.trap, ...(siblings.length ? { existingQuestions: siblings } : {}) }, parseCriticReview, workerSignal);
        const append = () => evalStore.appendReview(probeId, { ...review, roundNo: cp.roundNo, callId });
        if (review.decision === "reject" || (review.decision === "revise" && cp.roundNo > spec.maxRevisions)) { finish("rejected", review.feedback, append); return; }
        if (review.decision === "accept") commit({ version: 1, stage: "reference", roundNo: cp.roundNo, turnNo: 1, attempt: 1, userContent: probe.question, trap: probe.trap, tactic: null }, append);
        else commit({ ...cp, stage: "revision", review: { issues: review.issues, feedback: review.feedback }, pendingCallId: undefined }, append);
      } else if (cp.stage === "revision") {
        const siblings = evalStore.listExistingQuestionsForSource(source.id, probeId);
        const { result: revised } = await invoke(plan, slot, cp, spec, "probe_writer", spec.prompts.probeWriter, { material: source.content, mode: "revise", videoId: source.videoId, allowedTypes: spec.allowedTypes, slot: { slotIndex: probe.slotIndex, probeType: probe.probeType, persona: probe.persona, expectedBehavior: probe.expectedBehavior, targetTurns: probe.targetTurns }, previousProbe: { question: probe.question, anchor: probe.anchor, trap: probe.trap }, ...cp.review, ...(siblings.length ? { existingQuestions: siblings } : {}) }, raw => parseProbeRevision(raw, spec.allowedTypes), workerSignal);
        const nextType = revised.probeType ?? probe.probeType;
        commit({ version: 1, stage: "critic", roundNo: cp.roundNo + 1, turnNo: 1, attempt: 1 }, () => evalStore.reviseProbe(probeId, { probeType: nextType, persona: revised.persona ?? probe.persona, targetTurns: revised.targetTurns ?? (nextType === "hold_position" ? Math.max(2, probe.targetTurns) : 1), question: revised.question, anchor: revised.anchor || probe.anchor, trap: revised.trap || probe.trap, anchorVerified: verifyAnchorInMaterial(revised.anchor || probe.anchor, source.content) }));
      } else if (cp.stage === "adversary") {
        const remaining = ADVERSARY_TACTICS.filter(t => !usedTactics.includes(t));
        const availableTactics = remaining.length ? remaining : [...ADVERSARY_TACTICS];
        const { result: adv } = await invoke(plan, slot, cp, spec, "adversary", spec.prompts.adversary, { material: source.content, history, probeType: probe.probeType, persona: probe.persona, availableTactics, ...(usedTactics.length ? { usedTactics } : {}), turnNo: cp.turnNo, targetTurns: probe.targetTurns, anchor: probe.anchor }, raw => parseAdversaryTurn(raw, availableTactics), workerSignal);
        commit({ version: 1, stage: "reference", roundNo: cp.roundNo, turnNo: cp.turnNo, attempt: 1, tactic: adv.tactic, userContent: adv.userContent, trap: adv.trap || probe.trap });
      } else if (cp.stage === "reference") {
        const { result: answer } = await invoke(plan, slot, cp, spec, "reference", spec.prompts.reference, { material: source.content, question: cp.userContent, probeType: probe.probeType, expectedBehavior, ...(history.length ? { history } : {}), ...(cp.previousAnswer ? { previousAnswer: cp.previousAnswer, feedback: cp.feedback } : {}) }, raw => nonEmpty(raw, "参考答案"), workerSignal);
        commit({ ...cp, stage: "verifier", answer, pendingCallId: undefined });
      } else if (cp.stage === "verifier") {
        const { result: verified } = await invoke(plan, slot, cp, spec, "verifier", spec.prompts.verifier, { material: source.content, probeType: probe.probeType, expectedBehavior, question: cp.userContent, anchor: probe.anchor, trap: cp.trap, ...(history.length ? { history } : {}), answer: cp.answer }, raw => parseVerifierResult(raw, expectedBehavior), workerSignal);
        if (verified.decision === "pass" && verified.rubric) {
          const turn = { probeId, turnNo: cp.turnNo, expectedBehavior, tactic: cp.tactic, userContent: cp.userContent!, referenceAnswer: cp.answer!, rubric: verified.rubric, attempts: cp.attempt };
          if (cp.turnNo === probe.targetTurns) { finish("accepted", undefined, () => evalStore.saveProbeTurn(turn)); return; }
          commit({ version: 1, stage: "adversary", roundNo: cp.roundNo, turnNo: cp.turnNo + 1, attempt: 1 }, () => evalStore.saveProbeTurn(turn));
        } else if (verified.decision === "drop" || cp.attempt >= spec.maxAnswerAttempts) { finish("dropped", `Turn ${cp.turnNo}: ${verified.feedback}`); return; }
        else commit({ ...cp, stage: "reference", attempt: cp.attempt + 1, previousAnswer: cp.answer, feedback: verified.feedback, answer: undefined, pendingCallId: undefined });
      }
    }
  }

  try {
    await runConcurrentPool(selections, concurrency, async ({ source, plan: existing }, index, workerSignal) => {
      checkAbort(workerSignal);
      const tag = `[build ${index + 1}/${sources.length} ${source.videoId}]`;
      let plan = existing;
      const wasExisting = Boolean(existing);
      try {
        if (!plan) {
          const id = evalStore.createBuildPlan({ sourceMaterialId: source.id, executionRunId: runId, sourceSha256: source.contentSha256, spec: currentSpec, specHash: probeBuildSpecHash(currentSpec, source.contentSha256) });
          plan = evalStore.getBuildPlan(id)!;
        } else evalStore.linkBuildExecution(runId, plan.id);
        summary.planIds.push(plan.id);
        if (plan.spec === null && !plan.planComplete && plan.errorCode === "legacy_plan_incomplete") {
          summary.reusedTerminal += evalStore.listBuildSlots(plan.id).filter(s => terminal(s.status)).length;
          summary.sourcesProcessed++;
          return;
        }
        if (!["done", "skipped"].includes(plan.status)) {
          assertBuildSpec(plan, source.contentSha256);
          const spec = plan.spec;
          if (!plan.planComplete && plan.errorCode !== "legacy_plan_incomplete" && !evalStore.listBuildSlots(plan.id).length) {
            const guidance = buildSoftTypeGuidance(evalStore.countProbesByType(["accepted", "draft"]), spec.allowedTypes);
            const existingQuestions = evalStore.listExistingQuestionsForSource(source.id);
            const { callId, result: batch, raw } = await invoke(plan, undefined, undefined, spec, "probe_writer", spec.prompts.probeWriter, { material: source.content, mode: "draft", videoId: source.videoId, partCount: source.partCount, maxProbes: spec.maxProbesPerVideo, allowedTypes: spec.allowedTypes, currentTypeCounts: guidance.currentTypeCounts, underrepresentedTypes: guidance.underrepresentedTypes, suggestedPersonas: DEFAULT_PERSONAS, ...(existingQuestions.length ? { existingQuestions } : {}) }, raw => parseCompleteBatch(raw, spec), workerSignal);
            evalStore.commitBuildBatch({ planId: plan.id, executionRunId: runId, callId, raw, drafts: batch.probes, skipReason: batch.skipReason, anchorVerified: batch.probes.map(d => verifyAnchorInMaterial(d.anchor, source.content)) });
            summary.probesCreated += batch.probes.length;
            summary.newProbes += batch.probes.length;
            plan = evalStore.getBuildPlan(plan.id)!;
          }
          const materialized = evalStore.materializeBuildSlots(plan.id, runId);
          summary.newProbes += materialized;
          summary.probesCreated += materialized;
          const slots = evalStore.listBuildSlots(plan.id);
          for (const slot of slots) {
            checkAbort(workerSignal);
            if (terminal(slot.status)) { summary.reusedTerminal++; continue; }
            if (wasExisting) summary.resumedSlots++;
            try { await processSlot(source, plan, slot, spec, workerSignal); }
            catch (error) {
              const checkpoint = evalStore.listBuildSlots(plan.id).find(s => s.id === slot.id)!.checkpoint;
              evalStore.commitBuildCheckpoint({ slotId: slot.id, executionRunId: runId, checkpoint, status: "retryable", errorCode: errorCode(error) });
              summary.errors++;
              options.onProgress?.(`${tag} slot#${slot.slotIndex}: ${errorCode(error)}`);
              if (workerSignal.aborted || isOperationAborted(error)) throw error;
            }
          }
        } else summary.reusedTerminal += evalStore.listBuildSlots(plan.id).length;
        if (plan.status === "skipped") summary.sourcesSkipped++;
        summary.sourcesProcessed++;
      } catch (error) {
        summary.errors++;
        if (plan) evalStore.failBuildPlan(plan.id, errorCode(error));
        options.onProgress?.(`${tag}: ${errorCode(error)}`);
        if (workerSignal.aborted || isOperationAborted(error)) throw error;
      } finally {
        if (plan) {
          evalStore.finishBuildExecution(runId, plan.id);
          const finalPlan = evalStore.getBuildPlan(plan.id)!;
          const slots = evalStore.listBuildSlots(plan.id);
          summary.probeIds.push(...slots.flatMap(s => s.probeId ? [s.probeId] : []));
          summary.pendingSlots += slots.filter(s => !terminal(s.status)).length;
          summary.errorSlots += slots.filter(s => s.status === "retryable").length;
          if (!finalPlan.planComplete || !["done", "skipped"].includes(finalPlan.status)) summary.plansComplete = false;
          if (!finalPlan.planComplete && finalPlan.errorCode === "legacy_plan_incomplete") summary.incompleteLegacyPlans.push(finalPlan.id);
        }
      }
    }, { signal });
    summary.partial = !summary.plansComplete || summary.errors > 0;
    summary.executionCompleted = true;
    evalStore.finishRun(runId, summary.partial ? "failed" : "completed", summary.partial ? "build_incomplete" : undefined);
  } catch (error) {
    evalStore.finishRun(runId, "failed", errorCode(error));
    throw error;
  }
  summary.totalAgentCalls = evalStore.countAgentCalls(runRef);
  return summary;
}
