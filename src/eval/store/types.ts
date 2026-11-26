import type { EvalRole } from "../../shared/types.js";

export const EVAL_SCHEMA_VERSION = "3";

export const PROBE_TYPES = [
  "answer",
  "correct_premise",
  "acknowledge_gap",
  "refuse",
  "hold_position",
] as const;

export type ProbeType = (typeof PROBE_TYPES)[number];

/** Expected behavior shares the exact same 5 values as ProbeType. */
export const EXPECTED_BEHAVIORS = PROBE_TYPES;
export type ExpectedBehavior = ProbeType;

/**
 * Turn-level expected behavior rule:
 * - Single-turn types (`answer`, `correct_premise`, `acknowledge_gap`, `refuse`): same as `probeType`.
 * - Multi-turn `hold_position`: Turn 1 expects `answer`; Turn 2..N expect `hold_position`.
 */
export function expectedBehaviorForTurn(probeType: ProbeType, turnNo: number): ExpectedBehavior {
  if (probeType === "hold_position") {
    return turnNo <= 1 ? "answer" : "hold_position";
  }
  return probeType;
}

export const ADVERSARY_TACTICS = [
  "pushback",
  "label",
  "force_binary",
  "flatter_flip",
  "emotional",
] as const;

export type AdversaryTactic = (typeof ADVERSARY_TACTICS)[number];

export type ProbeStatus = "draft" | "accepted" | "rejected" | "dropped";
export type DifficultyLevel = "easy" | "medium" | "hard";
export type ProbeRunKind = "probe_build" | "calibrate";
export type RunLifecycleStatus = "running" | "completed" | "failed" | "interrupted";
export type EvalHistoryMode = "gold" | "self";

export interface ProbeRubric {
  expectedBehavior: ExpectedBehavior;
  stance: string;
  keyPoints: string[];
  forbidden: string[];
  mustNotHallucinate: string[];
  failureSignals: string[];
}

export interface ProbeReviewEntry {
  roundNo: number;
  decision: "accept" | "revise" | "reject";
  issues: string[];
  feedback: string;
  callId: number | null;
  createdAt: string;
}

export interface SourceMaterialRecord {
  id: number;
  videoId: string;
  videoKey: string;
  mainMaterialId: number | null;
  partCount: number;
  content: string;
  contentSha256: string;
  sourcePath: string | null;
  splitSnapshot: string;
  importedAt: string;
}

export interface ProbeRunRecord {
  id: number;
  kind: ProbeRunKind;
  status: RunLifecycleStatus;
  config: Record<string, unknown>;
  prompts: Record<string, unknown>;
  skills: unknown[];
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface ProbeRecord {
  id: number;
  runId: number;
  sourceMaterialId: number;
  slotIndex: number;
  probeType: ProbeType;
  expectedBehavior: ExpectedBehavior;
  persona: string;
  targetTurns: number;
  question: string;
  anchor: string;
  trap: string;
  anchorVerified: boolean;
  status: ProbeStatus;
  revisions: number;
  reviews: ProbeReviewEntry[];
  rejectReason: string | null;
  difficulty: DifficultyLevel | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProbeTurnRecord {
  id: number;
  probeId: number;
  turnNo: number;
  expectedBehavior: ExpectedBehavior;
  tactic: AdversaryTactic | null;
  userContent: string;
  referenceAnswer: string;
  rubric: ProbeRubric;
  attempts: number;
  createdAt: string;
}

export interface ProbeCalibrationRecord {
  id: number;
  probeId: number;
  turnNo: number;
  bareModel: string;
  graderModel: string;
  bareAnswer: string;
  behaviorOk: boolean;
  score: number;
  detail: Record<string, unknown>;
  bareCallId: number | null;
  graderCallId: number | null;
  createdAt: string;
}

export interface SuiteRubricEntry {
  turnNo: number;
  expectedBehavior: ExpectedBehavior;
  tactic: AdversaryTactic | null;
  rubric: ProbeRubric;
}

export interface SuiteVersionRecord {
  id: number;
  name: string;
  itemCount: number;
  sha256: string;
  manifest: Record<string, unknown>;
  frozenAt: string;
}

export interface SuiteItemRecord {
  id: number;
  suiteId: number;
  itemKey: string;
  videoKey: string;
  probeType: ProbeType;
  difficulty: DifficultyLevel | null;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  rubrics: SuiteRubricEntry[];
}

export interface EvalRunRecord {
  id: number;
  suiteId: number;
  suiteName: string;
  candidate: string;
  model: string;
  historyMode: EvalHistoryMode;
  systemPrompt: string | null;
  config: Record<string, unknown>;
  status: RunLifecycleStatus;
  startedAt: string;
  endedAt: string | null;
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
  graderModel: string;
  behaviorOk: boolean;
  stance: 0 | 1 | 2;
  keyPointCoverage: number;
  forbiddenHits: number;
  hallucinationHits: number;
  failureSignalHits: number;
  style: 0 | 1 | 2;
  score: number;
  detail: Record<string, unknown>;
  callId: number | null;
  createdAt: string;
}

export interface InsertSourceMaterialInput {
  videoId: string;
  videoKey?: string;
  mainMaterialId?: number | null;
  partCount?: number;
  content: string;
  sourcePath?: string | null;
  splitSnapshot?: string;
}

export interface CreateProbeInput {
  runId: number;
  sourceMaterialId: number;
  slotIndex: number;
  probeType: ProbeType;
  persona: string;
  targetTurns: number;
  question: string;
  anchor: string;
  trap: string;
  anchorVerified: boolean;
}

export interface SaveProbeTurnInput {
  probeId: number;
  turnNo: number;
  expectedBehavior: ExpectedBehavior;
  tactic?: AdversaryTactic | null;
  userContent: string;
  referenceAnswer: string;
  rubric: ProbeRubric;
  attempts?: number;
}

export interface StartAgentCallInput {
  runRef: string;
  role: EvalRole;
  model: string;
  inputRefs: Record<string, unknown>;
}

export interface EvalStoreSummary {
  schemaVersion: string;
  sourceMaterials: number;
  sourceVideos: number;
  probeRuns: Record<string, number>;
  probesByStatus: Record<string, number>;
  probesByType: Record<string, number>;
  probesByDifficulty: Record<string, number>;
  probeTurns: number;
  probeCalibrations: number;
  suites: Array<{
    name: string;
    itemCount: number;
    sha256: string;
    frozenAt: string;
  }>;
  evalRuns: number;
  evalPredictions: number;
  evalScores: number;
  agentCalls: number;
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseJsonArray<T = unknown>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
