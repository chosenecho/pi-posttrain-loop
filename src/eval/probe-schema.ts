import { asObject, nonEmpty, parseJson } from "../schema.js";
import {
  ADVERSARY_TACTICS,
  EXPECTED_BEHAVIOR_BY_TYPE,
  isTrapProbeType,
  PROBE_TYPES,
  type AdversaryTactic,
  type ExpectedBehavior,
  type ProbeType,
} from "./eval-db.js";

/** Kept only for read-only train-overlap audit reporting in suite-freeze (never used as a build kill switch). */
export const DUPLICATE_NGRAM_THRESHOLD = 0.6;

export type GraderVerdict = "pass" | "partial" | "fail";

export interface DraftProbeItem {
  slotIndex: number;
  probeType: ProbeType;
  persona: string;
  targetTurns: number;
  expectedBehavior: ExpectedBehavior;
  question: string;
  anchor: string;
  trap: string;
}

export interface DraftProbeBatch {
  probes: DraftProbeItem[];
  skipReason?: string;
}

export interface CriticReview {
  decision: "accept" | "revise" | "reject";
  issues: string[];
  feedback: string;
}

export interface VerifierReview {
  decision: "pass" | "revise" | "drop";
  issues: string[];
  feedback: string;
}

export interface ProbeRubricV2 {
  expectedBehavior: ExpectedBehavior;
  stance: string;
  keyPoints: string[];
  forbidden: string[];
  mustNotHallucinate: string[];
  failureSignals: string[];
}

export interface AdversaryTurnDraft {
  tactic: AdversaryTactic;
  userContent: string;
  trap: string;
}

export interface GraderTurnJudgement {
  /** Holistic semantic verdict from the grader agent (primary signal in v3). */
  verdict?: GraderVerdict;
  /** Holistic substantive score (0..100) directly judged by the grader agent (primary signal in v3). */
  score?: number;
  behaviorOk: boolean;
  /** Whether the candidate fabricated unseen facts/sources/numbers. */
  hallucinated?: boolean;
  stance: 0 | 1 | 2;
  matchedKeyPoints: number[];
  /** True when the grader explicitly supplied `matchedKeyPoints` (even if `[]`); false when omitted. */
  matchedKeyPointsProvided?: boolean;
  forbiddenHits: number[];
  hallucinationHits: number[];
  failureSignalHits: number[];
  style: 0 | 1 | 2;
  rationale: string;
}

/** Strips whitespace and punctuation for text matching / overlap auditing. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Advisory diagnostic checking whether `anchor` appears in `material` (exact or >=85% 5-gram containment).
 * Never blocks the agent loop — passed to `probe-critic` purely as an informational hint.
 */
export function verifyAnchorInMaterial(anchor: string, material: string): boolean {
  const normAnchor = normalizeForMatch(anchor);
  const normMaterial = normalizeForMatch(material);
  if (normAnchor.length < 6 || normMaterial.length === 0) return false;
  if (normMaterial.includes(normAnchor)) return true;
  if (normAnchor.length < 12) return false;

  const n = 5;
  const totalGrams = normAnchor.length - n + 1;
  if (totalGrams <= 0) return false;
  let matched = 0;
  for (let i = 0; i < totalGrams; i++) {
    if (normMaterial.includes(normAnchor.slice(i, i + n))) {
      matched++;
    }
  }
  return matched / totalGrams >= 0.85;
}

/** Character n-gram Jaccard similarity (default bigram n=2), used for read-only train-overlap auditing. */
export function charNgramJaccard(a: string, b: string, n = 2): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;

  const effectiveN = Math.min(n, na.length, nb.length);
  const gramsOf = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - effectiveN; i++) {
      set.add(s.slice(i, i + effectiveN));
    }
    return set;
  };

  const setA = gramsOf(na);
  const setB = gramsOf(nb);
  let intersection = 0;
  for (const g of setA) {
    if (setB.has(g)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Finds the closest duplicate match among `existingQuestions` above `threshold` (audit utility). */
export function findNearDuplicate(
  question: string,
  existingQuestions: readonly string[],
  threshold = DUPLICATE_NGRAM_THRESHOLD,
): { matchedQuestion: string; similarity: number } | undefined {
  let best: { matchedQuestion: string; similarity: number } | undefined;
  for (const existing of existingQuestions) {
    const similarity = charNgramJaccard(question, existing, 2);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { matchedQuestion: existing, similarity };
    }
  }
  return best;
}

/** Tolerant string list normalizer: filters blanks, deduplicates silently, trims optional max length. */
function normalizeStringList(value: unknown, max?: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    items.push(trimmed);
    if (max !== undefined && items.length >= max) break;
  }
  return items;
}

function normalizeProbeType(raw: unknown, allowedTypes: readonly ProbeType[], fallback?: ProbeType): ProbeType {
  if (typeof raw === "string") {
    const trimmed = raw.trim() as ProbeType;
    if (PROBE_TYPES.includes(trimmed) && allowedTypes.includes(trimmed)) {
      return trimmed;
    }
  }
  if (fallback && allowedTypes.includes(fallback)) {
    return fallback;
  }
  throw new Error(`无效或未允许的 probeType：${String(raw)}（允许：${allowedTypes.join(", ")}）`);
}

function normalizeTargetTurns(probeType: ProbeType, raw: unknown, fallback?: number): number {
  if (probeType === "pressure") {
    const num = Number(raw);
    if (Number.isSafeInteger(num)) {
      return Math.max(2, Math.min(3, num));
    }
    if (fallback !== undefined && fallback >= 2 && fallback <= 3) {
      return fallback;
    }
    return 2;
  }
  if (isTrapProbeType(probeType)) {
    const num = Number(raw);
    if (Number.isSafeInteger(num)) {
      return Math.max(1, Math.min(2, num));
    }
    if (fallback !== undefined && fallback >= 1 && fallback <= 2) {
      return fallback;
    }
    return 1;
  }
  return 1;
}

function normalizeOptionalText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export interface ParseDraftProbesOptions {
  maxProbes: number;
  allowedTypes?: readonly ProbeType[];
}

/**
 * Tolerantly parses agent-planned draft probes (`0 .. maxProbes`).
 * Allows `probes: []` with an optional `skipReason` when the agent judges the transcript
 * has no cross-video transferable theoretical substance.
 */
export function parseDraftProbes(text: string, options: ParseDraftProbesOptions): DraftProbeBatch {
  const value = asObject(parseJson(text), "对抗出题结果");
  if (!Array.isArray(value.probes)) {
    throw new Error("对抗出题结果必须包含 probes 数组");
  }
  const allowedTypes = options.allowedTypes && options.allowedTypes.length > 0
    ? options.allowedTypes
    : PROBE_TYPES;
  const skipReason = typeof value.skipReason === "string" && value.skipReason.trim().length > 0
    ? value.skipReason.trim()
    : undefined;

  const probes: DraftProbeItem[] = [];
  const cap = Math.max(1, options.maxProbes);
  for (let i = 0; i < value.probes.length && probes.length < cap; i++) {
    const obj = asObject(value.probes[i], `probes[${i}]`);
    const question = nonEmpty(obj.question, `probes[${i}].question`);
    const probeType = normalizeProbeType(obj.probeType, allowedTypes);
    const persona = normalizeOptionalText(obj.persona, "网友");
    const targetTurns = normalizeTargetTurns(probeType, obj.targetTurns);
    const anchor = normalizeOptionalText(obj.anchor, "");
    const trap = normalizeOptionalText(obj.trap, "");
    probes.push({
      slotIndex: probes.length + 1,
      probeType,
      persona,
      targetTurns,
      expectedBehavior: EXPECTED_BEHAVIOR_BY_TYPE[probeType],
      question,
      anchor,
      trap,
    });
  }

  return { probes, ...(skipReason ? { skipReason } : {}) };
}

export interface ReviseProbeFallback {
  slotIndex: number;
  probeType: ProbeType;
  persona: string;
  targetTurns: number;
  allowedTypes?: readonly ProbeType[];
}

/**
 * Tolerantly parses a single revised probe. Allows the writer agent to pivot `probeType`,
 * `persona`, or `targetTurns` if critic feedback recommends changing angle.
 */
export function parseRevisedProbe(text: string, fallback: ReviseProbeFallback): DraftProbeItem {
  const value = asObject(parseJson(text), "单题改写结果");
  const target = Array.isArray(value.probes) && value.probes.length === 1
    ? asObject(value.probes[0], "单题改写结果 probes[0]")
    : value;
  const allowedTypes = fallback.allowedTypes && fallback.allowedTypes.length > 0
    ? fallback.allowedTypes
    : PROBE_TYPES;
  const probeType = target.probeType !== undefined
    ? normalizeProbeType(target.probeType, allowedTypes, fallback.probeType)
    : fallback.probeType;
  const persona = normalizeOptionalText(target.persona, fallback.persona);
  const targetTurns = normalizeTargetTurns(probeType, target.targetTurns, fallback.targetTurns);
  return {
    slotIndex: fallback.slotIndex,
    probeType,
    persona,
    targetTurns,
    expectedBehavior: EXPECTED_BEHAVIOR_BY_TYPE[probeType],
    question: nonEmpty(target.question, "revised.question"),
    anchor: normalizeOptionalText(target.anchor, ""),
    trap: normalizeOptionalText(target.trap, ""),
  };
}

/** Tolerant critic review parser: normalizes benign `issues` on accept and synthesizes feedback when needed. */
export function parseCriticReview(text: string): CriticReview {
  const value = asObject(parseJson(text), "审题结果");
  const decision = typeof value.decision === "string" ? value.decision.trim().toLowerCase() : "";
  if (decision !== "accept" && decision !== "revise" && decision !== "reject") {
    throw new Error(`审题 decision 必须为 accept、revise 或 reject（实际：${String(value.decision)}）`);
  }
  const issues = normalizeStringList(value.issues);
  const rawFeedback = typeof value.feedback === "string" ? value.feedback.trim() : "";

  if (decision === "accept") {
    return { decision, issues: [], feedback: "" };
  }
  const feedback = rawFeedback || issues.join("；");
  if (!feedback) {
    throw new Error(`${decision} 必须提供说明（issues 或 feedback 至少一项非空）`);
  }
  return {
    decision,
    issues: issues.length > 0 ? issues : [feedback],
    feedback,
  };
}

/** Tolerant verifier review parser: normalizes benign `issues` on pass and synthesizes feedback when needed. */
export function parseVerifierReview(text: string): VerifierReview {
  const value = asObject(parseJson(text), "参考答案核验结果");
  const decision = typeof value.decision === "string" ? value.decision.trim().toLowerCase() : "";
  if (decision !== "pass" && decision !== "revise" && decision !== "drop") {
    throw new Error(`核验 decision 必须为 pass、revise 或 drop（实际：${String(value.decision)}）`);
  }
  const issues = normalizeStringList(value.issues);
  const rawFeedback = typeof value.feedback === "string" ? value.feedback.trim() : "";

  if (decision === "pass") {
    return { decision, issues: [], feedback: "" };
  }
  const feedback = rawFeedback || issues.join("；");
  if (!feedback) {
    throw new Error(`${decision} 必须提供说明（issues 或 feedback 至少一项非空）`);
  }
  return {
    decision,
    issues: issues.length > 0 ? issues : [feedback],
    feedback,
  };
}

/**
 * Tolerant rubric-v2 parser:
 * - Always aligns `expectedBehavior` with the turn's behavior instead of failing on echo mismatch.
 * - Silently deduplicates and trims arrays without throwing brittle length errors.
 * - Allows empty `keyPoints` (explicitly encouraged for `acknowledge_gap` / `hallucination_bait`).
 */
export function parseProbeRubric(
  text: string,
  expectedBehavior: ExpectedBehavior,
): ProbeRubricV2 {
  const value = asObject(parseJson(text), "评分卡 v2 结果");
  const stance = nonEmpty(value.stance, "rubric.stance");
  const keyPoints = normalizeStringList(value.keyPoints, 6);
  const forbidden = normalizeStringList(value.forbidden, 5);
  const mustNotHallucinate = normalizeStringList(value.mustNotHallucinate, 5);
  const failureSignals = normalizeStringList(value.failureSignals, 4);

  return {
    expectedBehavior,
    stance,
    keyPoints,
    forbidden,
    mustNotHallucinate,
    failureSignals,
  };
}

/**
 * Parses an adversary pressure turn where the agent autonomously selects `tactic`
 * (or falls back gracefully if omitted).
 */
export function parseAdversaryTurn(
  text: string,
  fallbackTactic: AdversaryTactic = "pushback",
): AdversaryTurnDraft {
  const value = asObject(parseJson(text), "多轮施压话术");
  const rawTactic = typeof value.tactic === "string" ? value.tactic.trim() : "";
  const tactic: AdversaryTactic = ADVERSARY_TACTICS.includes(rawTactic as AdversaryTactic)
    ? (rawTactic as AdversaryTactic)
    : fallbackTactic;
  return {
    tactic,
    userContent: nonEmpty(value.userContent, "adversary.userContent"),
    trap: normalizeOptionalText(value.trap, "面对施压容易道歉改口或和稀泥"),
  };
}

/** Tolerant index list parser: filters out-of-bounds/duplicate values instead of failing the grading call. */
function parseTolerantIndexList(value: unknown, maxLength: number): number[] {
  if (!Array.isArray(value) || maxLength <= 0) return [];
  const seen = new Set<number>();
  const indices: number[] = [];
  for (const item of value) {
    const idx = typeof item === "number" ? item : Number(item);
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= maxLength) continue;
    if (!seen.has(idx)) {
      seen.add(idx);
      indices.push(idx);
    }
  }
  return indices.sort((a, b) => a - b);
}

function parseClamped012(value: unknown, fallback: 0 | 1 | 2 = 1): 0 | 1 | 2 {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded <= 0) return 0;
  if (rounded >= 2) return 2;
  return 1;
}

function parseOptionalVerdict(value: unknown): GraderVerdict | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "pass" || v === "partial" || v === "fail") return v;
  return undefined;
}

function parseOptionalScore(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Number(Math.max(0, Math.min(100, num)).toFixed(2));
}

/**
 * Parses both v3 holistic grader output (`verdict`, `score`, `behaviorOk`, `hallucinated`, `stance`, `style`, `rationale`)
 * and legacy v2 index-based grader output (`matchedKeyPoints`, `forbiddenHits`, `hallucinationHits`, `failureSignalHits`).
 */
export function parseGradeResult(
  text: string,
  rubric: {
    keyPoints: readonly string[];
    forbidden: readonly string[];
    mustNotHallucinate: readonly string[];
    failureSignals?: readonly string[];
  },
): GraderTurnJudgement {
  const value = asObject(parseJson(text), "批卷结果");
  if (typeof value.behaviorOk !== "boolean") {
    throw new Error("批卷 behaviorOk 必须是布尔值");
  }
  const verdict = parseOptionalVerdict(value.verdict);
  const score = parseOptionalScore(value.score);
  const stance = parseClamped012(value.stance, value.behaviorOk ? 1 : 0);
  const style = parseClamped012(value.style, 1);
  const matchedKeyPointsProvided = Array.isArray(value.matchedKeyPoints);
  const matchedKeyPoints = parseTolerantIndexList(value.matchedKeyPoints, rubric.keyPoints.length);
  const forbiddenHits = parseTolerantIndexList(value.forbiddenHits, rubric.forbidden.length);
  const hallucinationHits = parseTolerantIndexList(value.hallucinationHits, rubric.mustNotHallucinate.length);
  const failureSignalHits = parseTolerantIndexList(value.failureSignalHits, (rubric.failureSignals ?? []).length);
  const hallucinated = typeof value.hallucinated === "boolean"
    ? value.hallucinated
    : hallucinationHits.length > 0;
  const rationale = nonEmpty(value.rationale, "批卷 rationale");

  return {
    ...(verdict !== undefined ? { verdict } : {}),
    ...(score !== undefined ? { score } : {}),
    behaviorOk: value.behaviorOk,
    hallucinated,
    stance,
    matchedKeyPoints,
    matchedKeyPointsProvided,
    forbiddenHits,
    hallucinationHits,
    failureSignalHits,
    style,
    rationale,
  };
}
