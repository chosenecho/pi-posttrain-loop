import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DataMakerStore, extractVideoKey } from "../db.js";
import { nonEmpty } from "../schema.js";
import {
  EvalStore,
  nowIso,
  sha256Hex,
  type DifficultyLevel,
  type ProbeRecord,
  type SourceMaterialRecord,
} from "./eval-db.js";
import { charNgramJaccard, DUPLICATE_NGRAM_THRESHOLD } from "./probe-schema.js";
import { verifySourceSplits } from "./source-import.js";

export const DEFAULT_MAX_EASY_RATIO = 0.2;

export interface TrainOverlapNeighbor {
  probeId: number;
  itemKey: string;
  probeQuestion: string;
  trainQuestion: string;
  similarity: number;
}

export interface TrainOverlapScanReport {
  mainDbPath: string;
  trainQuestionCount: number;
  scannedProbes: number;
  threshold: number;
  maxSimilarity: number;
  aboveThresholdCount: number;
  topNeighbors: TrainOverlapNeighbor[];
}

export interface FreezeAdversarialSuiteOptions {
  evalStore: EvalStore;
  name: string;
  runId?: number;
  maxEasyRatio?: number;
  allowUncalibrated?: boolean;
  /** When provided, re-verifies split='test' integrity and scans train-split question similarity (read-only). */
  mainDbPath?: string;
  trainSimThreshold?: number;
  failOnTrainSim?: number;
  exportPath?: string;
  manifestOutPath?: string;
}

export interface FreezeAdversarialSuiteReport {
  created: boolean;
  suiteName: string;
  kind: "adversarial";
  itemCount: number;
  turnCount: number;
  videoCount: number;
  sha256: string;
  byType: Record<string, number>;
  byDifficulty: Record<string, number>;
  byBehavior: Record<string, number>;
  byPersona: Record<string, number>;
  easyRatio: number;
  maxEasyRatio: number;
  excludedEasyProbeIds: number[];
  trainOverlapScan: TrainOverlapScanReport | null;
  exportPath?: string;
  manifestOutPath?: string;
}

function scanTrainQuestionSimilarity(
  mainDbPath: string,
  probes: readonly ProbeRecord[],
  threshold: number,
): TrainOverlapScanReport {
  const mainStore = new DataMakerStore(mainDbPath, { readOnly: true });
  try {
    const splitByKey = new Map<string, string>();
    for (const row of mainStore.listVideoSplits()) {
      splitByKey.set(row.video_key, row.split);
    }

    const rows = mainStore.db.prepare(`
      SELECT q.question, m.video_id
      FROM questions q
      JOIN materials m ON m.id = q.material_id
    `).all() as Array<{ question: string; video_id: string }>;

    const trainQuestions: string[] = [];
    for (const row of rows) {
      const videoKey = extractVideoKey(row.video_id);
      if (splitByKey.get(videoKey) === "train") {
        trainQuestions.push(row.question);
      }
    }

    const neighbors: TrainOverlapNeighbor[] = [];
    let maxSimilarity = 0;
    let aboveThresholdCount = 0;

    for (const probe of probes) {
      let bestSim = 0;
      let bestTrainQ = "";
      for (const tq of trainQuestions) {
        const sim = charNgramJaccard(probe.question, tq, 2);
        if (sim > bestSim) {
          bestSim = sim;
          bestTrainQ = tq;
        }
      }
      const rounded = Number(bestSim.toFixed(4));
      if (rounded > maxSimilarity) maxSimilarity = rounded;
      if (rounded >= threshold) aboveThresholdCount++;
      if (bestTrainQ) {
        neighbors.push({
          probeId: probe.id,
          itemKey: `probe:${probe.id}`,
          probeQuestion: probe.question,
          trainQuestion: bestTrainQ,
          similarity: rounded,
        });
      }
    }

    neighbors.sort((a, b) => b.similarity - a.similarity || a.probeId - b.probeId);

    return {
      mainDbPath,
      trainQuestionCount: trainQuestions.length,
      scannedProbes: probes.length,
      threshold,
      maxSimilarity,
      aboveThresholdCount,
      topNeighbors: neighbors.slice(0, 10),
    };
  } finally {
    mainStore.close();
  }
}

function selectWithEasyCap(
  evalStore: EvalStore,
  probes: readonly ProbeRecord[],
  maxEasyRatio: number,
): { selected: ProbeRecord[]; excludedEasyProbeIds: number[] } {
  const nonEasy: ProbeRecord[] = [];
  const easy: ProbeRecord[] = [];
  for (const p of probes) {
    if (p.difficulty === "easy") easy.push(p);
    else nonEasy.push(p);
  }

  if (easy.length === 0 || maxEasyRatio >= 1) {
    return {
      selected: [...probes].sort((a, b) => a.id - b.id),
      excludedEasyProbeIds: [],
    };
  }

  const maxAllowedEasy = maxEasyRatio <= 0
    ? 0
    : Math.floor((nonEasy.length * maxEasyRatio) / (1 - maxEasyRatio) + 1e-12);

  if (easy.length <= maxAllowedEasy) {
    return {
      selected: [...probes].sort((a, b) => a.id - b.id),
      excludedEasyProbeIds: [],
    };
  }

  // Deterministically keep the hardest (lowest bare-model calibration score) among easy probes.
  const scoreById = new Map<number, number>();
  for (const p of easy) {
    const cals = evalStore.listCompleteCalibrationsForProbe(p.id, p.targetTurns);
    const avg = cals.length > 0 ? cals.reduce((s, c) => s + c.score, 0) / cals.length : 100;
    scoreById.set(p.id, avg);
  }
  const sortedEasy = [...easy].sort(
    (a, b) => (scoreById.get(a.id) ?? 100) - (scoreById.get(b.id) ?? 100) || a.id - b.id,
  );
  const keptEasy = sortedEasy.slice(0, maxAllowedEasy);
  const excludedEasyProbeIds = sortedEasy.slice(maxAllowedEasy).map((p) => p.id).sort((a, b) => a - b);

  return {
    selected: [...nonEasy, ...keptEasy].sort((a, b) => a.id - b.id),
    excludedEasyProbeIds,
  };
}

/**
 * Freezes accepted adversarial probes from `eval.sqlite` into an immutable `adversarial` suite
 * (e.g. `adv-v1`), enforcing difficulty easy-ratio caps, main-DB split verification, train-set
 * n-gram overlap auditing, deterministic JSONL snapshot hashing, and optional file export.
 */
export async function freezeAdversarialSuite(
  options: FreezeAdversarialSuiteOptions,
): Promise<FreezeAdversarialSuiteReport> {
  const { evalStore } = options;
  const suiteName = nonEmpty(options.name, "--name");
  const maxEasyRatio = options.maxEasyRatio ?? DEFAULT_MAX_EASY_RATIO;
  if (!Number.isFinite(maxEasyRatio) || maxEasyRatio < 0 || maxEasyRatio > 1) {
    throw new Error("--max-easy-ratio 必须在 [0, 1] 范围内");
  }
  const trainSimThreshold = options.trainSimThreshold ?? DUPLICATE_NGRAM_THRESHOLD;

  const accepted = evalStore.listProbes({
    runId: options.runId,
    status: "accepted",
  });
  if (accepted.length === 0) {
    throw new Error("未找到任何已通过（accepted）的对抗考题，无法冻结套卷");
  }

  if (!options.allowUncalibrated) {
    const uncalibrated = accepted.filter((p) => p.difficulty === null);
    if (uncalibrated.length > 0) {
      throw new Error(
        `存在 ${uncalibrated.length} 道尚未完成难度标定的 accepted 考题（如 probe #${uncalibrated[0]!.id}）；请先运行 eval calibrate，或显式传入 --allow-uncalibrated`,
      );
    }
  }

  const { selected, excludedEasyProbeIds } = selectWithEasyCap(evalStore, accepted, maxEasyRatio);
  if (selected.length === 0) {
    throw new Error(`按 --max-easy-ratio ${maxEasyRatio} 筛选后没有任何考题可冻结`);
  }

  // Load and validate source materials and complete dialogues/rubrics
  const sourceCache = new Map<number, SourceMaterialRecord>();
  const usedSources: SourceMaterialRecord[] = [];
  const seenSourceIds = new Set<number>();

  interface ExportedSuiteLine {
    itemKey: string;
    videoKey: string;
    probeType: string;
    expectedBehavior: string;
    difficulty: DifficultyLevel | null;
    persona: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    rubrics: Array<{
      turnNo: number;
      expectedBehavior: string;
      tactic: string | null;
      rubric: unknown;
    }>;
  }

  const exportedLines: ExportedSuiteLine[] = [];
  const suiteItems: Array<{
    itemKey: string;
    videoKey: string;
    probeType: string | null;
    expectedBehavior: string | null;
    difficulty: DifficultyLevel | null;
    messages: unknown[];
    rubrics: unknown[];
  }> = [];

  const byType: Record<string, number> = {};
  const byDifficulty: Record<string, number> = {};
  const byBehavior: Record<string, number> = {};
  const byPersona: Record<string, number> = {};
  const videoKeys = new Set<string>();
  let turnCount = 0;

  for (const probe of selected) {
    let source = sourceCache.get(probe.sourceMaterialId);
    if (!source) {
      source = evalStore.getSourceMaterial(probe.sourceMaterialId);
      if (!source) {
        throw new Error(`probe #${probe.id} 缺少来源材料 source_material_id=${probe.sourceMaterialId}`);
      }
      sourceCache.set(probe.sourceMaterialId, source);
    }
    if (!seenSourceIds.has(source.id)) {
      seenSourceIds.add(source.id);
      usedSources.push(source);
    }

    const dialogue = evalStore.getProbeDialogue(probe.id);
    if (dialogue.length === 0) {
      throw new Error(`probe #${probe.id} 缺少通过的参考对话轮次`);
    }
    if (dialogue.length !== probe.targetTurns) {
      throw new Error(
        `probe #${probe.id} 对话轮数不完整：预期 ${probe.targetTurns} 轮，实际 ${dialogue.length} 轮`,
      );
    }
    for (const turn of dialogue) {
      if (!turn.rubric) {
        throw new Error(`probe #${probe.id} Turn ${turn.turnNo} 缺少评分卡 v2（probe_rubrics）`);
      }
    }

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const rubrics: ExportedSuiteLine["rubrics"] = [];
    for (const turn of dialogue) {
      messages.push({ role: "user", content: turn.user });
      messages.push({ role: "assistant", content: turn.answer });
      rubrics.push({
        turnNo: turn.turnNo,
        expectedBehavior: turn.expectedBehavior,
        tactic: turn.tactic,
        rubric: turn.rubric,
      });
      byBehavior[turn.expectedBehavior] = (byBehavior[turn.expectedBehavior] ?? 0) + 1;
      turnCount++;
    }

    const itemKey = `probe:${probe.id}`;
    videoKeys.add(source.videoKey);
    byType[probe.probeType] = (byType[probe.probeType] ?? 0) + 1;
    const diffKey = probe.difficulty ?? "uncalibrated";
    byDifficulty[diffKey] = (byDifficulty[diffKey] ?? 0) + 1;
    byPersona[probe.persona] = (byPersona[probe.persona] ?? 0) + 1;

    exportedLines.push({
      itemKey,
      videoKey: source.videoKey,
      probeType: probe.probeType,
      expectedBehavior: probe.expectedBehavior,
      difficulty: probe.difficulty,
      persona: probe.persona,
      messages,
      rubrics,
    });
    suiteItems.push({
      itemKey,
      videoKey: source.videoKey,
      probeType: probe.probeType,
      expectedBehavior: probe.expectedBehavior,
      difficulty: probe.difficulty,
      messages,
      rubrics,
    });
  }

  // Cross-DB verification & train question n-gram scan (read-only)
  let trainOverlapScan: TrainOverlapScanReport | null = null;
  if (options.mainDbPath) {
    verifySourceSplits(options.mainDbPath, usedSources);
    trainOverlapScan = scanTrainQuestionSimilarity(options.mainDbPath, selected, trainSimThreshold);
    if (options.failOnTrainSim !== undefined && trainOverlapScan.maxSimilarity >= options.failOnTrainSim) {
      const worst = trainOverlapScan.topNeighbors[0];
      throw new Error(
        `冻结拦截：考题与训练集问法最大相似度 ${trainOverlapScan.maxSimilarity} >= 阈值 ${options.failOnTrainSim}` +
        (worst ? `（${worst.itemKey} vs 训练集「${worst.trainQuestion.slice(0, 40)}」）` : ""),
      );
    }
  }

  const jsonl = exportedLines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  const sha256 = sha256Hex(jsonl);
  const easyCount = byDifficulty.easy ?? 0;
  const easyRatio = Number((easyCount / selected.length).toFixed(4));

  const sortedVideoKeys = [...videoKeys].sort();
  const sourceSha256s: Record<string, string> = {};
  for (const s of [...usedSources].sort((a, b) => a.videoId.localeCompare(b.videoId))) {
    sourceSha256s[s.videoId] = s.contentSha256;
  }

  const manifest: Record<string, unknown> = {
    suiteName,
    kind: "adversarial",
    runFilter: options.runId ?? "all",
    itemCount: selected.length,
    turnCount,
    videoCount: sortedVideoKeys.length,
    videoKeys: sortedVideoKeys,
    byType,
    byDifficulty,
    byBehavior,
    byPersona,
    easyRatio,
    maxEasyRatio,
    excludedEasyProbeIds,
    sourceSha256s,
    trainOverlapScan,
    sha256,
    frozenAt: nowIso(),
  };

  const { created, suite } = evalStore.freezeSuite({
    name: suiteName,
    kind: "adversarial",
    sha256,
    manifest,
    items: suiteItems,
  });

  if (options.exportPath) {
    await mkdir(dirname(options.exportPath), { recursive: true });
    await writeFile(options.exportPath, jsonl, "utf8");
  }
  if (options.manifestOutPath) {
    await mkdir(dirname(options.manifestOutPath), { recursive: true });
    await writeFile(options.manifestOutPath, JSON.stringify(suite.manifest, null, 2) + "\n", "utf8");
  }

  return {
    created,
    suiteName: suite.name,
    kind: "adversarial",
    itemCount: suite.itemCount,
    turnCount,
    videoCount: sortedVideoKeys.length,
    sha256: suite.sha256,
    byType,
    byDifficulty,
    byBehavior,
    byPersona,
    easyRatio,
    maxEasyRatio,
    excludedEasyProbeIds,
    trainOverlapScan,
    ...(options.exportPath ? { exportPath: options.exportPath } : {}),
    ...(options.manifestOutPath ? { manifestOutPath: options.manifestOutPath } : {}),
  };
}
