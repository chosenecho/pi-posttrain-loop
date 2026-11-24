import { asObject, nonEmpty, parseJson } from "../schema.js";
import { EXPECTED_BEHAVIORS, type ExpectedBehavior, type ProbeType } from "./eval-db.js";

export const DUPLICATE_NGRAM_THRESHOLD = 0.6;

export interface DraftProbeItem {
  slotIndex: number;
  question: string;
  anchor: string;
  trap: string;
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
  userContent: string;
  trap: string;
}

export interface GraderTurnJudgement {
  behaviorOk: boolean;
  stance: 0 | 1 | 2;
  matchedKeyPoints: number[];
  forbiddenHits: number[];
  hallucinationHits: number[];
  failureSignalHits: number[];
  style: 0 | 1 | 2;
  rationale: string;
}

/** Strips whitespace and punctuation for robust Chinese/English text matching. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Deterministic check verifying whether `anchor` genuinely comes from `material`.
 * 1. Exact normalized substring match (handles whitespace/punctuation/newline differences).
 * 2. Fallback for minor single-char ASR/punctuation edits: for normalized anchors >= 12 chars,
 *    requires >= 90% 5-gram containment inside `material`.
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
  return matched / totalGrams >= 0.9;
}

/** Character n-gram Jaccard similarity (default bigram n=2 for Chinese short questions) used for pre-critic dedup. */
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

/** Finds the closest duplicate match among `existingQuestions` above `threshold`. */
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

function parseUniqueStringList(value: unknown, label: string, min: number, max: number): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  if (value.length < min || value.length > max) {
    throw new Error(`${label} 长度必须在 ${min}–${max} 之间（实际 ${value.length}）`);
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = nonEmpty(value[i], `${label}[${i}]`);
    if (seen.has(item)) {
      throw new Error(`${label} 包含重复项：${item}`);
    }
    seen.add(item);
    items.push(item);
  }
  return items;
}

function parseSingleDraftItem(rawItem: unknown, label: string): DraftProbeItem {
  const obj = asObject(rawItem, label);
  const slotIndex = Number(obj.slotIndex);
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 1) {
    throw new Error(`${label}.slotIndex 必须是正整数`);
  }
  return {
    slotIndex,
    question: nonEmpty(obj.question, `${label}.question`),
    anchor: nonEmpty(obj.anchor, `${label}.anchor`),
    trap: nonEmpty(obj.trap, `${label}.trap`),
  };
}

export function parseDraftProbes(text: string, expectedSlotIndices: readonly number[]): DraftProbeItem[] {
  const value = asObject(parseJson(text), "对抗出题结果");
  if (!Array.isArray(value.probes)) {
    throw new Error("对抗出题结果必须包含 probes 数组");
  }
  const items = value.probes.map((rawItem, idx) => parseSingleDraftItem(rawItem, `probes[${idx}]`));
  const expectedSet = new Set(expectedSlotIndices);
  const seen = new Set<number>();
  for (const item of items) {
    if (!expectedSet.has(item.slotIndex)) {
      throw new Error(`对抗出题结果包含未请求的 slotIndex=${item.slotIndex}`);
    }
    if (seen.has(item.slotIndex)) {
      throw new Error(`对抗出题结果包含重复的 slotIndex=${item.slotIndex}`);
    }
    seen.add(item.slotIndex);
  }
  const missing = expectedSlotIndices.filter((idx) => !seen.has(idx));
  if (missing.length > 0) {
    throw new Error(`对抗出题结果缺少槽位：${missing.join(", ")}`);
  }
  return items.sort((a, b) => a.slotIndex - b.slotIndex);
}

export function parseRevisedProbe(text: string, expectedSlotIndex: number): DraftProbeItem {
  const value = asObject(parseJson(text), "单题改写结果");
  // Tolerate a single-element `{ probes: [...] }` wrapper if model echoed batch shape.
  const target = Array.isArray(value.probes) && value.probes.length === 1
    ? asObject(value.probes[0], "单题改写结果 probes[0]")
    : value;
  const slotIndex = target.slotIndex === undefined ? expectedSlotIndex : Number(target.slotIndex);
  if (slotIndex !== expectedSlotIndex) {
    throw new Error(`单题改写结果 slotIndex 不一致：预期 ${expectedSlotIndex}，实际 ${String(target.slotIndex)}`);
  }
  return {
    slotIndex,
    question: nonEmpty(target.question, "revised.question"),
    anchor: nonEmpty(target.anchor, "revised.anchor"),
    trap: nonEmpty(target.trap, "revised.trap"),
  };
}

export function parseCriticReview(text: string): CriticReview {
  const value = asObject(parseJson(text), "审题结果");
  const { decision, issues, feedback } = value;
  if (decision !== "accept" && decision !== "revise" && decision !== "reject") {
    throw new Error("审题 decision 必须为 accept、revise 或 reject");
  }
  if (!Array.isArray(issues) || !issues.every((item) => typeof item === "string")) {
    throw new Error("审题 issues 必须是字符串数组");
  }
  if (typeof feedback !== "string") {
    throw new Error("审题 feedback 必须是字符串");
  }
  const trimmedIssues = issues.map((s) => s.trim()).filter(Boolean);
  const trimmedFeedback = feedback.trim();
  if (decision === "accept" && trimmedIssues.length > 0) {
    throw new Error("accept 的 issues 必须为空数组");
  }
  if (decision === "revise" && !trimmedFeedback) {
    throw new Error("revise 必须附带非空 feedback");
  }
  if (decision === "reject" && trimmedIssues.length === 0 && !trimmedFeedback) {
    throw new Error("reject 必须说明拒绝原因");
  }
  return {
    decision,
    issues: trimmedIssues,
    feedback: trimmedFeedback,
  };
}

export function parseVerifierReview(text: string): VerifierReview {
  const value = asObject(parseJson(text), "参考答案核验结果");
  const { decision, issues, feedback } = value;
  if (decision !== "pass" && decision !== "revise" && decision !== "drop") {
    throw new Error("核验 decision 必须为 pass、revise 或 drop");
  }
  if (!Array.isArray(issues) || !issues.every((item) => typeof item === "string")) {
    throw new Error("核验 issues 必须是字符串数组");
  }
  if (typeof feedback !== "string") {
    throw new Error("核验 feedback 必须是字符串");
  }
  const trimmedIssues = issues.map((s) => s.trim()).filter(Boolean);
  const trimmedFeedback = feedback.trim();
  if (decision === "pass" && trimmedIssues.length > 0) {
    throw new Error("pass 的 issues 必须为空数组");
  }
  if (decision === "revise" && !trimmedFeedback) {
    throw new Error("revise 必须附带非空 feedback");
  }
  if (decision === "drop" && trimmedIssues.length === 0 && !trimmedFeedback) {
    throw new Error("drop 必须说明放弃原因");
  }
  return {
    decision,
    issues: trimmedIssues,
    feedback: trimmedFeedback,
  };
}

export function parseProbeRubric(
  text: string,
  expectedBehavior: ExpectedBehavior,
  probeType?: ProbeType,
): ProbeRubricV2 {
  const value = asObject(parseJson(text), "评分卡 v2 结果");
  const rawBehavior = nonEmpty(value.expectedBehavior, "rubric.expectedBehavior");
  if (!EXPECTED_BEHAVIORS.includes(rawBehavior as ExpectedBehavior)) {
    throw new Error(`无效的 rubric.expectedBehavior：${rawBehavior}`);
  }
  if (rawBehavior !== expectedBehavior) {
    throw new Error(`rubric.expectedBehavior 与代码锁定值不一致：预期 ${expectedBehavior}，实际 ${rawBehavior}`);
  }
  const stance = nonEmpty(value.stance, "rubric.stance");
  const minKeyPoints = expectedBehavior === "acknowledge_gap" ? 0 : 1;
  const keyPoints = parseUniqueStringList(value.keyPoints ?? [], "rubric.keyPoints", minKeyPoints, 6);
  const forbidden = parseUniqueStringList(value.forbidden ?? [], "rubric.forbidden", 0, 5);
  const minHallucinate = probeType === "hallucination_bait" || expectedBehavior === "acknowledge_gap" ? 1 : 0;
  const mustNotHallucinate = parseUniqueStringList(
    value.mustNotHallucinate ?? [],
    "rubric.mustNotHallucinate",
    minHallucinate,
    5,
  );
  const failureSignals = parseUniqueStringList(value.failureSignals, "rubric.failureSignals", 1, 4);

  return {
    expectedBehavior,
    stance,
    keyPoints,
    forbidden,
    mustNotHallucinate,
    failureSignals,
  };
}

export function parseAdversaryTurn(text: string): AdversaryTurnDraft {
  const value = asObject(parseJson(text), "多轮施压话术");
  return {
    userContent: nonEmpty(value.userContent, "adversary.userContent"),
    trap: nonEmpty(value.trap, "adversary.trap"),
  };
}

function parseIndexList(value: unknown, label: string, maxLength: number): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是整数索引数组`);
  }
  const seen = new Set<number>();
  const indices: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const idx = value[i];
    if (typeof idx !== "number" || !Number.isSafeInteger(idx) || idx < 0 || idx >= maxLength) {
      throw new Error(`${label}[${i}] 索引越界或无效：${String(idx)}（允许范围 0..${Math.max(0, maxLength - 1)}，数组长度 ${maxLength}）`);
    }
    if (!seen.has(idx)) {
      seen.add(idx);
      indices.push(idx);
    }
  }
  return indices.sort((a, b) => a - b);
}

function parseScore012(value: unknown, label: string): 0 | 1 | 2 {
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new Error(`${label} 必须是整数 0、1 或 2（实际 ${String(value)}）`);
  }
  return value;
}

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
  const stance = parseScore012(value.stance, "批卷 stance");
  const style = parseScore012(value.style, "批卷 style");
  const matchedKeyPoints = parseIndexList(value.matchedKeyPoints ?? [], "批卷 matchedKeyPoints", rubric.keyPoints.length);
  const forbiddenHits = parseIndexList(value.forbiddenHits ?? [], "批卷 forbiddenHits", rubric.forbidden.length);
  const hallucinationHits = parseIndexList(value.hallucinationHits ?? [], "批卷 hallucinationHits", rubric.mustNotHallucinate.length);
  const failureSignalHits = parseIndexList(value.failureSignalHits ?? [], "批卷 failureSignalHits", (rubric.failureSignals ?? []).length);
  const rationale = nonEmpty(value.rationale, "批卷 rationale");

  return {
    behaviorOk: value.behaviorOk,
    stance,
    matchedKeyPoints,
    forbiddenHits,
    hallucinationHits,
    failureSignalHits,
    style,
    rationale,
  };
}
