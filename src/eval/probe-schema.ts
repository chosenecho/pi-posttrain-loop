import { asObject, nonEmpty, parseJson } from "../shared/schema.js";
import { normalizeText } from "../shared/utils.js";
import {
  ADVERSARY_TACTICS,
  EXPECTED_BEHAVIORS,
  PROBE_TYPES,
  type AdversaryTactic,
  type ExpectedBehavior,
  type ProbeRubric,
  type ProbeType,
} from "./store/index.js";

export const DUPLICATE_NGRAM_THRESHOLD = 0.65;

function parseJsonText(raw: string, _label: string): unknown {
  return parseJson(raw);
}

function normalizeStringList(value: unknown, label: string, maxItems = 12): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}必须是字符串数组`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeProbeType(raw: unknown, allowedTypes: readonly ProbeType[], label: string): ProbeType {
  if (typeof raw !== "string") {
    throw new Error(`${label}缺少合法的 probeType`);
  }
  const normalized = raw.trim().toLowerCase() as ProbeType;
  if (!PROBE_TYPES.includes(normalized) || !allowedTypes.includes(normalized)) {
    throw new Error(`${label}的 probeType "${raw}" 不在允许集合（${allowedTypes.join("/")}）中`);
  }
  return normalized;
}

function normalizeTargetTurns(probeType: ProbeType, raw: unknown): number {
  if (probeType !== "hold_position") return 1;
  const n = Number(raw);
  if (Number.isInteger(n) && (n === 2 || n === 3)) return n;
  return 2;
}

export interface PlannedProbeDraft {
  probeType: ProbeType;
  persona: string;
  targetTurns: number;
  question: string;
  anchor: string;
  trap: string;
}

export interface ParsedProbeDraftBatch {
  probes: PlannedProbeDraft[];
  skipReason?: string;
}

export function parseProbeDraftBatch(
  raw: string,
  options: { maxProbes: number; allowedTypes?: readonly ProbeType[] },
): ParsedProbeDraftBatch {
  const allowedTypes = options.allowedTypes && options.allowedTypes.length > 0 ? options.allowedTypes : PROBE_TYPES;
  const parsed = asObject(parseJsonText(raw, "probe-writer 输出"), "probe-writer 输出");
  const rawProbes = parsed.probes;
  if (!Array.isArray(rawProbes)) {
    throw new Error("probe-writer 输出缺少 probes 数组");
  }

  const probes: PlannedProbeDraft[] = [];
  for (let i = 0; i < Math.min(rawProbes.length, options.maxProbes); i++) {
    const item = asObject(rawProbes[i], `probe-writer probes[${i}]`);
    const probeType = normalizeProbeType(item.probeType ?? item.probe_type ?? item.type, allowedTypes, `probes[${i}]`);
    const persona =
      typeof item.persona === "string" && item.persona.trim().length > 0 ? item.persona.trim() : "普通提问者";
    const question = nonEmpty(item.question, `probes[${i}].question`);
    const anchor = typeof item.anchor === "string" ? item.anchor.trim() : "";
    const trap = typeof item.trap === "string" ? item.trap.trim() : "";
    const targetTurns = normalizeTargetTurns(probeType, item.targetTurns ?? item.target_turns);
    probes.push({ probeType, persona, targetTurns, question, anchor, trap });
  }

  const skipReason =
    typeof parsed.skipReason === "string" && parsed.skipReason.trim().length > 0
      ? parsed.skipReason.trim()
      : undefined;

  return { probes, ...(skipReason ? { skipReason } : {}) };
}

export interface ParsedProbeRevision {
  probeType?: ProbeType;
  persona?: string;
  targetTurns?: number;
  question: string;
  anchor: string;
  trap: string;
}

export function parseProbeRevision(
  raw: string,
  allowedTypes: readonly ProbeType[] = PROBE_TYPES,
): ParsedProbeRevision {
  const parsed = asObject(parseJsonText(raw, "probe-writer 改写输出"), "probe-writer 改写输出");
  const rawType = parsed.probeType ?? parsed.probe_type;
  const probeType = rawType !== undefined ? normalizeProbeType(rawType, allowedTypes, "probe-writer 改写") : undefined;
  const persona =
    typeof parsed.persona === "string" && parsed.persona.trim().length > 0 ? parsed.persona.trim() : undefined;
  const rawTurns = parsed.targetTurns ?? parsed.target_turns;
  const targetTurns =
    probeType !== undefined
      ? normalizeTargetTurns(probeType, rawTurns)
      : Number.isInteger(Number(rawTurns)) && Number(rawTurns) >= 1 && Number(rawTurns) <= 3
        ? Number(rawTurns)
        : undefined;

  return {
    ...(probeType ? { probeType } : {}),
    ...(persona ? { persona } : {}),
    ...(targetTurns !== undefined ? { targetTurns } : {}),
    question: nonEmpty(parsed.question, "改写后的 question"),
    anchor: typeof parsed.anchor === "string" ? parsed.anchor.trim() : "",
    trap: typeof parsed.trap === "string" ? parsed.trap.trim() : "",
  };
}

export interface CriticReviewResult {
  decision: "accept" | "revise" | "reject";
  issues: string[];
  feedback: string;
}

export function parseCriticReview(raw: string): CriticReviewResult {
  const parsed = asObject(parseJsonText(raw, "probe-critic 输出"), "probe-critic 输出");
  const decision = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  if (decision !== "accept" && decision !== "revise" && decision !== "reject") {
    throw new Error(`probe-critic decision 必须是 accept/revise/reject，收到：${String(parsed.decision)}`);
  }
  const issues = normalizeStringList(parsed.issues, "probe-critic.issues");
  const feedback = typeof parsed.feedback === "string" ? parsed.feedback.trim() : "";
  if (decision === "accept") {
    return { decision: "accept", issues: [], feedback: "" };
  }
  if (!feedback && issues.length === 0) {
    throw new Error(`probe-critic 判 ${decision} 时必须提供 feedback 或 issues`);
  }
  return {
    decision,
    issues: issues.length > 0 ? issues : [feedback],
    feedback: feedback || issues.join("；"),
  };
}

export function parseProbeRubric(raw: unknown, expectedBehavior: ExpectedBehavior): ProbeRubric {
  const parsed =
    typeof raw === "string"
      ? asObject(parseJsonText(raw, "rubric JSON"), "rubric JSON")
      : asObject(raw, "rubric");
  const rawBehavior = typeof parsed.expectedBehavior === "string" ? parsed.expectedBehavior.trim() : "";
  const resolvedBehavior: ExpectedBehavior = EXPECTED_BEHAVIORS.includes(rawBehavior as ExpectedBehavior)
    ? expectedBehavior
    : expectedBehavior;
  const stance = nonEmpty(parsed.stance, "rubric.stance");
  const keyPoints = normalizeStringList(parsed.keyPoints, "rubric.keyPoints", 8);
  const forbidden = normalizeStringList(parsed.forbidden, "rubric.forbidden", 8);
  const mustNotHallucinate = normalizeStringList(parsed.mustNotHallucinate, "rubric.mustNotHallucinate", 8);
  const failureSignals = normalizeStringList(parsed.failureSignals, "rubric.failureSignals", 8);

  return {
    expectedBehavior: resolvedBehavior,
    stance,
    keyPoints,
    forbidden,
    mustNotHallucinate,
    failureSignals,
  };
}

export interface VerifierResult {
  decision: "pass" | "revise" | "drop";
  issues: string[];
  feedback: string;
  rubric?: ProbeRubric;
}

/**
 * Parses verifier output. When `decision === "pass"`, a valid `rubric` is required
 * (the verifier now directly emits the rubric on pass, eliminating the separate rubric-v2 agent).
 */
export function parseVerifierResult(raw: string, expectedBehavior: ExpectedBehavior): VerifierResult {
  const parsed = asObject(parseJsonText(raw, "verifier 输出"), "verifier 输出");
  const decision = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  if (decision !== "pass" && decision !== "revise" && decision !== "drop") {
    throw new Error(`verifier decision 必须是 pass/revise/drop，收到：${String(parsed.decision)}`);
  }
  if (decision === "pass") {
    if (!parsed.rubric) {
      throw new Error("verifier 判 pass 时必须同时输出 rubric 对象");
    }
    const rubric = parseProbeRubric(parsed.rubric, expectedBehavior);
    return { decision: "pass", issues: [], feedback: "", rubric };
  }
  const issues = normalizeStringList(parsed.issues, "verifier.issues");
  const feedback = typeof parsed.feedback === "string" ? parsed.feedback.trim() : "";
  if (!feedback && issues.length === 0) {
    throw new Error(`verifier 判 ${decision} 时必须提供 feedback 或 issues`);
  }
  return {
    decision,
    issues: issues.length > 0 ? issues : [feedback],
    feedback: feedback || issues.join("；"),
  };
}

export interface AdversaryTurnOutput {
  tactic: AdversaryTactic;
  userContent: string;
  trap: string;
}

export function parseAdversaryTurn(
  raw: string,
  allowedTactics: readonly AdversaryTactic[] = ADVERSARY_TACTICS,
): AdversaryTurnOutput {
  const parsed = asObject(parseJsonText(raw, "adversary 输出"), "adversary 输出");
  const rawTactic = typeof parsed.tactic === "string" ? parsed.tactic.trim().toLowerCase() : "";
  const tactic = allowedTactics.includes(rawTactic as AdversaryTactic)
    ? (rawTactic as AdversaryTactic)
    : allowedTactics[0]!;
  return {
    tactic,
    userContent: nonEmpty(parsed.userContent ?? parsed.question, "adversary.userContent"),
    trap: typeof parsed.trap === "string" ? parsed.trap.trim() : "",
  };
}

export type GraderVerdict = "pass" | "partial" | "fail";

export interface GraderTurnJudgement {
  verdict: GraderVerdict;
  score: number;
  behaviorOk: boolean;
  hallucinated: boolean;
  stance: 0 | 1 | 2;
  matchedKeyPoints: number[];
  matchedKeyPointsProvided: boolean;
  forbiddenHits: number[];
  hallucinationHits: number[];
  failureSignalHits: number[];
  style: 0 | 1 | 2;
  rationale: string;
}

function parseIndexList(raw: unknown, maxLen: number): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of raw) {
    const idx = Number(item);
    if (Number.isInteger(idx) && idx >= 0 && idx < maxLen && !seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out.sort((a, b) => a - b);
}

function parseRating012(raw: unknown, fallback: 0 | 1 | 2): 0 | 1 | 2 {
  const n = Number(raw);
  if (n === 0 || n === 1 || n === 2) return n;
  return fallback;
}

const VERDICT_DEFAULT_SCORE: Record<GraderVerdict, number> = {
  pass: 85,
  partial: 62,
  fail: 20,
};

/** Parses holistic grader output (requires `score` and/or `verdict` — no legacy v2 formula fallback). */
export function parseGradeResult(
  raw: string,
  rubric: Pick<ProbeRubric, "keyPoints" | "forbidden" | "mustNotHallucinate" | "failureSignals">,
): GraderTurnJudgement {
  const parsed = asObject(parseJsonText(raw, "eval-grader 输出"), "eval-grader 输出");
  if (typeof parsed.behaviorOk !== "boolean") {
    throw new Error("eval-grader 输出缺少布尔字段 behaviorOk");
  }

  const rawVerdict = typeof parsed.verdict === "string" ? parsed.verdict.trim().toLowerCase() : "";
  const hasVerdict = rawVerdict === "pass" || rawVerdict === "partial" || rawVerdict === "fail";
  const rawScore = parsed.score !== undefined && parsed.score !== null ? Number(parsed.score) : NaN;
  const hasScore = Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 100;

  if (!hasScore && !hasVerdict) {
    throw new Error("eval-grader 输出必须包含合法的 score (0..100) 或 verdict (pass/partial/fail)");
  }

  const hallucinationHits = parseIndexList(parsed.hallucinationHits, rubric.mustNotHallucinate.length);
  const hallucinated = Boolean(parsed.hallucinated === true || hallucinationHits.length > 0);
  const score = hasScore
    ? Number(rawScore.toFixed(2))
    : VERDICT_DEFAULT_SCORE[rawVerdict as GraderVerdict];

  const verdict: GraderVerdict = hasVerdict
    ? (rawVerdict as GraderVerdict)
    : !parsed.behaviorOk || hallucinated || score < 50
      ? "fail"
      : score >= 80
        ? "pass"
        : "partial";

  const defaultStance: 0 | 1 | 2 = verdict === "pass" ? 2 : verdict === "partial" ? 1 : 0;
  const matchedKeyPointsProvided = Array.isArray(parsed.matchedKeyPoints);

  return {
    verdict,
    score,
    behaviorOk: parsed.behaviorOk,
    hallucinated,
    stance: parseRating012(parsed.stance, defaultStance),
    matchedKeyPoints: parseIndexList(parsed.matchedKeyPoints, rubric.keyPoints.length),
    matchedKeyPointsProvided,
    forbiddenHits: parseIndexList(parsed.forbiddenHits, rubric.forbidden.length),
    hallucinationHits,
    failureSignalHits: parseIndexList(parsed.failureSignalHits, rubric.failureSignals.length),
    style: parseRating012(parsed.style, 1),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale.trim() : "",
  };
}

function compactForMatch(text: string): string {
  return normalizeText(text).replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

/** Diagnostic hint checking whether anchor text appears in the material (non-blocking). */
export function verifyAnchorInMaterial(anchor: string, material: string): boolean {
  const cleanAnchor = compactForMatch(anchor);
  if (cleanAnchor.length < 4) return false;
  const cleanMat = compactForMatch(material);
  if (cleanMat.includes(cleanAnchor)) return true;
  if (cleanAnchor.length >= 12) {
    const windowLen = Math.min(12, Math.floor(cleanAnchor.length * 0.6));
    for (let i = 0; i <= cleanAnchor.length - windowLen; i += Math.max(1, Math.floor(windowLen / 2))) {
      if (cleanMat.includes(cleanAnchor.slice(i, i + windowLen))) return true;
    }
  }
  return false;
}

function charNgrams(text: string, n: number): Set<string> {
  const clean = compactForMatch(text);
  const set = new Set<string>();
  if (clean.length === 0) return set;
  if (clean.length < n) {
    set.add(clean);
    return set;
  }
  for (let i = 0; i <= clean.length - n; i++) {
    set.add(clean.slice(i, i + n));
  }
  return set;
}

/** Character n-gram Jaccard similarity in [0, 1] used for train/test overlap auditing. */
export function charNgramJaccard(a: string, b: string, n = 2): number {
  const setA = charNgrams(a, n);
  const setB = charNgrams(b, n);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const gram of setA) {
    if (setB.has(gram)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}
