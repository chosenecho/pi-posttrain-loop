import { sha256Hex } from "../shared/utils.js";
import { expectedBehaviorForTurn, type ProbeBuildCheckpoint, type ProbeBuildPlanRecord, type ProbeBuildSpec, type ProbeRecord, type ProbeTurnRecord } from "./store/types.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function probeBuildSpecHash(spec: ProbeBuildSpec, sourceSha256: string): string {
  return sha256Hex(stable({ spec, sourceSha256 }));
}

export function assertBuildSpec(plan: ProbeBuildPlanRecord, sourceSha256: string): asserts plan is ProbeBuildPlanRecord & { spec: ProbeBuildSpec } {
  if (!plan.spec || plan.spec.version !== 1 || !plan.spec.prompts || Object.values(plan.spec.prompts).some(v => typeof v !== "string" || !v.trim())) throw new Error(`build_snapshot_missing: plan #${plan.id}`);
  if (plan.sourceSha256 !== sourceSha256 || probeBuildSpecHash(plan.spec, sourceSha256) !== plan.specHash) throw new Error(`checkpoint_invalid: plan #${plan.id} spec hash`);
}

/** Only a legal continuous prefix can seed history; successful turns are never overwritten. */
export function assertBuildCheckpoint(checkpoint: ProbeBuildCheckpoint, probe: ProbeRecord, turns: ProbeTurnRecord[], spec: ProbeBuildSpec): void {
  const invalid = () => { throw new Error(`checkpoint_invalid: probe #${probe.id}`); };
  if (checkpoint.version !== 1 || !["critic", "revision", "adversary", "reference", "verifier", "done"].includes(checkpoint.stage)) invalid();
  if (!Number.isInteger(checkpoint.roundNo) || checkpoint.roundNo < 1 || checkpoint.roundNo > spec.maxRevisions + 1 ||
      !Number.isInteger(checkpoint.attempt) || checkpoint.attempt < 1 || checkpoint.attempt > spec.maxAnswerAttempts ||
      !Number.isInteger(checkpoint.turnNo) || checkpoint.turnNo < 1 || checkpoint.turnNo > probe.targetTurns + 1) invalid();
  turns.forEach((turn, index) => {
    if (turn.turnNo !== index + 1 || turn.turnNo > probe.targetTurns || turn.expectedBehavior !== expectedBehaviorForTurn(probe.probeType, turn.turnNo) || !turn.referenceAnswer.trim() || !turn.userContent.trim() || turn.rubric.expectedBehavior !== turn.expectedBehavior || !turn.rubric.stance?.trim() || (turn.turnNo > 1 && !turn.tactic)) invalid();
  });
  if (["critic", "revision"].includes(checkpoint.stage)) {
    if (turns.length || checkpoint.turnNo !== 1 || checkpoint.attempt !== 1) invalid();
    if (checkpoint.stage === "revision" && (!checkpoint.review || probe.revisions >= spec.maxRevisions)) invalid();
  } else if (checkpoint.stage !== "done") {
    if (checkpoint.turnNo !== turns.length + 1) invalid();
    if (checkpoint.stage === "adversary" && checkpoint.turnNo < 2) invalid();
    if (["reference", "verifier"].includes(checkpoint.stage) && !checkpoint.userContent?.trim()) invalid();
    if (checkpoint.stage === "verifier" && !checkpoint.answer?.trim()) invalid();
  }
}
