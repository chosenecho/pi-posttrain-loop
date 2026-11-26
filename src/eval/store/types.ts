export { nowIso, sha256Hex } from "../../shared/utils.js";

/**
 * Domain constants and record interfaces for the independent evaluation store (`data/eval.sqlite`).
 * Data only flows main DB -> eval DB; the eval pipeline never writes the main DB.
 */

export const EVAL_SCHEMA_VERSION = "2";

export const ADVERSARIAL_PROBE_TYPES = [
  "wild_short",
  "premise_trap",
  "contrast",
  "transfer",
  "hallucination_bait",
  "pressure",
] as const;

export const TRAP_PROBE_TYPES = [
  "trap_misattribution",
  "trap_unknown_detail",
  "trap_forced_decision",
  "trap_unfounded_judgment",
] as const;

export const PROBE_TYPES = [
  ...ADVERSARIAL_PROBE_TYPES,
  ...TRAP_PROBE_TYPES,
] as const;
export type ProbeType = (typeof PROBE_TYPES)[number];

export type EvalProfile = "adversarial" | "trap";

export function isTrapProbeType(probeType: ProbeType): boolean {
  return (TRAP_PROBE_TYPES as readonly string[]).includes(probeType);
}

export function probeTypesForProfile(profile: EvalProfile): readonly ProbeType[] {
  return profile === "trap" ? TRAP_PROBE_TYPES : ADVERSARIAL_PROBE_TYPES;
}

export const EXPECTED_BEHAVIORS = [
  "answer",
  "correct_premise",
  "acknowledge_gap",
  "hold_position",
  "refuse",
] as const;
export type ExpectedBehavior = (typeof EXPECTED_BEHAVIORS)[number];

export const PRESSURE_ADVERSARY_TACTICS = [
  "pushback",
  "label",
  "force_binary",
  "flatter_flip",
  "emotional",
] as const;

export const TRAP_ADVERSARY_TACTICS = [
  "nudge_estimate",
  "assume_premise",
  "push_decision",
] as const;

export const ADVERSARY_TACTICS = [
  ...PRESSURE_ADVERSARY_TACTICS,
  ...TRAP_ADVERSARY_TACTICS,
] as const;
export type AdversaryTactic = (typeof ADVERSARY_TACTICS)[number];

export const DIFFICULTY_LEVELS = ["easy", "medium", "hard"] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

/** Expected behavior is decided by code from the probe type, never by the writer model. */
export const EXPECTED_BEHAVIOR_BY_TYPE: Record<ProbeType, ExpectedBehavior> = {
  wild_short: "answer",
  premise_trap: "correct_premise",
  contrast: "answer",
  transfer: "answer",
  hallucination_bait: "acknowledge_gap",
  pressure: "answer",
  trap_misattribution: "refuse",
  trap_unknown_detail: "refuse",
  trap_forced_decision: "refuse",
  trap_unfounded_judgment: "refuse",
};

export type ProbeStatus = "drafted" | "rejected" | "answering" | "dropped" | "error" | "accepted";
export type ProbeRunStatus = "running" | "completed" | "failed" | "interrupted";
export type ProbeRunKind = "probe_build" | "calibrate" | "mirror";
export type EvalHistoryMode = "gold" | "self";
export type EvalSuiteKind = "in_distribution" | "adversarial";

export type Row = Record<string, unknown>;

export interface SourceMaterialRecord {
  id: number;
  videoId: string;
  videoKey: string;
  mainMaterialId: number | null;
  partCount: number;
  content: string;
  contentSha256: string;
  sourcePath: string | null;
  importedAt: string;
}

export interface ProbeRecord {
  id: number;
  specId: number;
  runId: number;
  sourceMaterialId: number;
  slotIndex: number;
  probeType: ProbeType;
  persona: string;
  targetTurns: number;
  question: string;
  anchor: string;
  trap: string;
  expectedBehavior: ExpectedBehavior;
  status: ProbeStatus;
  anchorVerified: boolean;
  revisions: number;
  rejectReason: string | null;
  difficulty: DifficultyLevel | null;
}

export interface ProbeRunRecord {
  id: number;
  kind: string;
  status: ProbeRunStatus;
  config: Record<string, unknown>;
  skills: unknown[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface ProbeReviewRecord {
  id: number;
  roundNo: number;
  decision: "accept" | "revise" | "reject";
  issues: string[];
  feedback: string;
  questionSnapshot: string;
  callId: number | null;
  createdAt: string;
}

export interface ProbeAttemptRecord {
  turnNo: number;
  attemptNo: number;
  answer: string | null;
  decision: "pass" | "revise" | "drop" | null;
  issues: string[];
  feedback: string | null;
}

export interface ProbeDialogueTurn {
  turnNo: number;
  user: string;
  answer: string;
  expectedBehavior: ExpectedBehavior;
  tactic: string | null;
  rubric: unknown;
}

export interface CalibrationTurnRecord {
  id: number;
  runId: number;
  probeId: number;
  turnNo: number;
  bareModel: string;
  graderModel: string;
  bareAnswer: string | null;
  behaviorOk: boolean;
  stance: number;
  keyPointCoverage: number;
  forbiddenHits: number;
  hallucinationHits: number;
  failureSignalHits: number;
  style: number;
  score: number;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface SuiteVersionRecord {
  id: number;
  name: string;
  kind: EvalSuiteKind;
  itemCount: number;
  sha256: string;
  manifest: Record<string, unknown>;
  createdAt: string;
}

export interface SuiteItemRecord {
  id: number;
  suiteId: number;
  itemKey: string;
  videoKey: string;
  probeType: string | null;
  expectedBehavior: string | null;
  difficulty: DifficultyLevel | null;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  rubrics: unknown[];
}

export interface EvalRunRecord {
  id: number;
  suiteId: number;
  suiteName: string;
  suiteKind: EvalSuiteKind;
  candidate: string;
  model: string;
  historyMode: EvalHistoryMode;
  config: Record<string, unknown>;
  status: ProbeRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface EvalPredictionRecord {
  id: number;
  evalRunId: number;
  suiteItemId: number;
  turnNo: number;
  input: Record<string, unknown>;
  outputText: string | null;
  error: string | null;
  callId: number | null;
  createdAt: string;
}

export interface EvalScoreRecord {
  id: number;
  predictionId: number;
  evalRunId: number;
  suiteItemId: number;
  itemKey: string;
  videoKey: string;
  probeType: string | null;
  itemExpectedBehavior: string | null;
  difficulty: DifficultyLevel | null;
  turnNo: number;
  graderModel: string;
  behaviorOk: boolean;
  stance: number;
  keyPointCoverage: number;
  forbiddenHits: number;
  hallucinationHits: number;
  failureSignalHits: number;
  style: number;
  score: number;
  detail: Record<string, unknown>;
  callId: number | null;
  createdAt: string;
}

export interface EvalRunSummaryRow {
  id: number;
  suiteName: string;
  candidate: string;
  model: string;
  historyMode: EvalHistoryMode;
  status: ProbeRunStatus;
  predictions: number;
  scores: number;
  startedAt: string;
}

export interface EvalStoreSummary {
  schemaVersion: string | undefined;
  mainDbPath: string | undefined;
  sourceMaterials: number;
  unbuiltSourceMaterials: number;
  sourceVideoKeys: number;
  probeRuns: number;
  probesByStatus: Record<string, number>;
  acceptedByType: Record<string, number>;
  acceptedByDifficulty: Record<string, number>;
  suites: Array<{ name: string; kind: string; itemCount: number; sha256: string; createdAt: string }>;
  evalRuns: EvalRunSummaryRow[];
  agentCalls: number;
}
