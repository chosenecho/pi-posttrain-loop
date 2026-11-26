import {
  ADVERSARY_TACTICS,
  EXPECTED_BEHAVIOR_BY_TYPE,
  PROBE_TYPES,
  type AdversaryTactic,
  type ExpectedBehavior,
  type ProbeType,
  type SourceMaterialRecord,
} from "./store/index.js";

export const PROBE_PERSONAS = [
  "学生",
  "打工人",
  "杠精网友",
  "学者",
  "同情者",
  "反对者",
] as const;
export type ProbePersona = (typeof PROBE_PERSONAS)[number];

/** Default full 6-type adversarial mix weights (soft guidance for the planning/writing agent). */
export const DEFAULT_PROBE_MIX: Readonly<Record<ProbeType, number>> = {
  wild_short: 20,
  premise_trap: 20,
  contrast: 15,
  transfer: 15,
  hallucination_bait: 15,
  pressure: 15,
  trap_misattribution: 0,
  trap_unknown_detail: 0,
  trap_forced_decision: 0,
  trap_unfounded_judgment: 0,
};

/** Default 4-type trap-refusal mix weights (`--profile trap`). */
export const DEFAULT_TRAP_PROBE_MIX: Readonly<Record<ProbeType, number>> = {
  wild_short: 0,
  premise_trap: 0,
  contrast: 0,
  transfer: 0,
  hallucination_bait: 0,
  pressure: 0,
  trap_misattribution: 25,
  trap_unknown_detail: 25,
  trap_forced_decision: 25,
  trap_unfounded_judgment: 25,
};

/** Legacy M1 single-turn-only mix (no multi-turn pressure). */
export const DEFAULT_M1_PROBE_MIX: Readonly<Record<ProbeType, number>> = {
  wild_short: 25,
  premise_trap: 25,
  contrast: 15,
  transfer: 20,
  hallucination_bait: 15,
  pressure: 0,
  trap_misattribution: 0,
  trap_unknown_detail: 0,
  trap_forced_decision: 0,
  trap_unfounded_judgment: 0,
};

export interface SoftMixGuidance {
  allowedTypes: ProbeType[];
  targetWeights: Partial<Record<ProbeType, number>>;
  currentCounts: Partial<Record<ProbeType, number>>;
  underrepresentedTypes: ProbeType[];
}

export interface PlannedProbeSlot {
  sourceMaterialId: number;
  videoId: string;
  videoKey: string;
  slotIndex: number;
  probeType: ProbeType;
  persona: ProbePersona;
  expectedBehavior: ExpectedBehavior;
  targetTurns: number;
  /** Advisory adversary tactics for turns 2..targetTurns (legacy planner compatibility). */
  tactics: AdversaryTactic[];
}

export function normalizeProbeMix(mix?: Partial<Record<ProbeType, number>>): Record<ProbeType, number> {
  if (!mix) return { ...DEFAULT_PROBE_MIX };
  const result = Object.fromEntries(PROBE_TYPES.map((t) => [t, 0])) as Record<ProbeType, number>;
  for (const t of PROBE_TYPES) {
    result[t] = mix[t] ?? 0;
  }
  return result;
}

export function parseProbeMix(raw: string): Record<ProbeType, number> {
  const mix = Object.fromEntries(PROBE_TYPES.map((t) => [t, 0])) as Record<ProbeType, number>;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("--mix 不能为空");
  }
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0 || eq === part.length - 1) {
      throw new Error(`--mix 格式错误：${part}（应为 type=weight，例如 wild_short=25,premise_trap=25）`);
    }
    const key = part.slice(0, eq).trim() as ProbeType;
    const val = Number(part.slice(eq + 1).trim());
    if (!PROBE_TYPES.includes(key)) {
      throw new Error(`未知题型：${key}（可选：${PROBE_TYPES.join(", ")}）`);
    }
    if (!Number.isFinite(val) || val < 0) {
      throw new Error(`题型权重必须为非负数：${part}`);
    }
    mix[key] = val;
  }
  const total = Object.values(mix).reduce((acc, v) => acc + v, 0);
  if (total <= 0) {
    throw new Error("--mix 至少需要一个正权重题型");
  }
  return mix;
}

/**
 * Builds soft global balance guidance for the autonomous `probe-writer` agent.
 * Unlike rigid slot locking, this tells the agent which probe types are allowed and which ones
 * are currently underrepresented globally, while leaving the final per-video count and types
 * to the agent after reading the transcript.
 */
export function buildSoftMixGuidance(
  mix: Readonly<Record<ProbeType, number>>,
  currentCounts: Partial<Record<ProbeType, number>> = {},
): SoftMixGuidance {
  const allowedTypes = PROBE_TYPES.filter((t) => (mix[t] ?? 0) > 0);
  if (allowedTypes.length === 0) {
    throw new Error("题型配比至少需要一个正权重类型");
  }
  const totalWeight = allowedTypes.reduce((sum, t) => sum + (mix[t] ?? 0), 0);
  const totalCurrent = allowedTypes.reduce((sum, t) => sum + Math.max(0, currentCounts[t] ?? 0), 0);

  const targetWeights: Partial<Record<ProbeType, number>> = {};
  const filteredCounts: Partial<Record<ProbeType, number>> = {};
  const deficits: Array<{ type: ProbeType; deficit: number }> = [];

  for (const t of allowedTypes) {
    const targetShare = (mix[t] ?? 0) / totalWeight;
    targetWeights[t] = Number((targetShare * 100).toFixed(1));
    const count = Math.max(0, currentCounts[t] ?? 0);
    filteredCounts[t] = count;
    const actualShare = totalCurrent > 0 ? count / totalCurrent : 0;
    deficits.push({ type: t, deficit: targetShare - actualShare });
  }

  const underrepresentedTypes = totalCurrent > 0
    ? deficits
        .filter((d) => d.deficit > 0.02)
        .sort((a, b) => b.deficit - a.deficit)
        .map((d) => d.type)
    : [...allowedTypes];

  return {
    allowedTypes,
    targetWeights,
    currentCounts: filteredCounts,
    underrepresentedTypes,
  };
}

/**
 * Legacy deterministic Smooth Weighted Round-Robin (SWRR) slot allocator.
 * Retained for optional reference/testing; the default `runProbeBuild` now lets the agent
 * autonomously plan per-video probe count and types using `buildSoftMixGuidance`.
 */
export function planProbeSlots(
  sources: readonly SourceMaterialRecord[],
  options: {
    probesPerVideo: number;
    mix?: Partial<Record<ProbeType, number>>;
    seed?: number;
  },
): Map<number, PlannedProbeSlot[]> {
  const { probesPerVideo } = options;
  if (!Number.isSafeInteger(probesPerVideo) || probesPerVideo < 1 || probesPerVideo > 20) {
    throw new Error("probesPerVideo 必须是 1–20 的整数");
  }
  const effectiveMix = normalizeProbeMix(options.mix);
  const activeTypes = PROBE_TYPES.filter((t) => effectiveMix[t] > 0);
  if (activeTypes.length === 0) {
    throw new Error("题型配比至少需要一个正权重类型");
  }

  const totalWeight = activeTypes.reduce((sum, t) => sum + effectiveMix[t], 0);
  const currentWeights = new Map<ProbeType, number>();
  for (const t of activeTypes) {
    currentWeights.set(t, 0);
  }

  function nextType(): ProbeType {
    let bestType = activeTypes[0];
    let bestWeight = -Infinity;
    for (const t of activeTypes) {
      const updated = (currentWeights.get(t) ?? 0) + effectiveMix[t];
      currentWeights.set(t, updated);
      if (updated > bestWeight) {
        bestWeight = updated;
        bestType = t;
      }
    }
    currentWeights.set(bestType, (currentWeights.get(bestType) ?? 0) - totalWeight);
    return bestType;
  }

  const personaOffset = options.seed !== undefined ? Math.abs(options.seed) : 0;
  const plan = new Map<number, PlannedProbeSlot[]>();
  let globalSlot = 0;
  let pressureCount = 0;
  let tacticCursor = personaOffset % ADVERSARY_TACTICS.length;

  for (let vIdx = 0; vIdx < sources.length; vIdx++) {
    const source = sources[vIdx];
    const slots: PlannedProbeSlot[] = [];
    for (let slotIndex = 1; slotIndex <= probesPerVideo; slotIndex++) {
      const probeType = nextType();
      const persona = PROBE_PERSONAS[(personaOffset + globalSlot + vIdx) % PROBE_PERSONAS.length];
      let targetTurns = 1;
      const tactics: AdversaryTactic[] = [];
      if (probeType === "pressure") {
        targetTurns = pressureCount % 3 === 2 ? 3 : 2;
        pressureCount++;
        const needed = targetTurns - 1;
        for (let t = 0; t < needed; t++) {
          tactics.push(ADVERSARY_TACTICS[(tacticCursor + t) % ADVERSARY_TACTICS.length]);
        }
        tacticCursor = (tacticCursor + needed) % ADVERSARY_TACTICS.length;
      }
      slots.push({
        sourceMaterialId: source.id,
        videoId: source.videoId,
        videoKey: source.videoKey,
        slotIndex,
        probeType,
        persona,
        expectedBehavior: EXPECTED_BEHAVIOR_BY_TYPE[probeType],
        targetTurns,
        tactics,
      });
      globalSlot++;
    }
    plan.set(source.id, slots);
  }

  return plan;
}

export function summarizePlan(plan: Map<number, PlannedProbeSlot[]>): {
  totalSlots: number;
  byType: Record<string, number>;
  byPersona: Record<string, number>;
} {
  let totalSlots = 0;
  const byType: Record<string, number> = {};
  const byPersona: Record<string, number> = {};
  for (const slots of plan.values()) {
    for (const slot of slots) {
      totalSlots++;
      byType[slot.probeType] = (byType[slot.probeType] ?? 0) + 1;
      byPersona[slot.persona] = (byPersona[slot.persona] ?? 0) + 1;
    }
  }
  return { totalSlots, byType, byPersona };
}
