import { assertDistinctDatabaseFiles } from "../shared/database-path.js";
import { combineSignals, throwIfAborted } from "../shared/cancellation.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nonEmpty } from "../shared/schema.js";
import { extractVideoKey, nowIso, sha256Hex } from "../shared/utils.js";
import { DataMakerStore } from "../synth/store/index.js";
import { charNgramJaccard, DUPLICATE_NGRAM_THRESHOLD } from "./probe-schema.js";
import { verifySourceSplits } from "./source-import.js";
import {
  EvalStore,
  type DifficultyLevel,
  type ProbeRecord,
  type ProbeType,
  type SourceMaterialRecord,
  type SuiteRubricEntry,
} from "./store/index.js";

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

export interface FreezeSuiteOptions {
  evalStore: EvalStore;
  name: string;
  runId?: number;
  executionRunId?: number;
  allowPartialBuild?: boolean;
  signal?: AbortSignal;
  probeTypes?: readonly ProbeType[];
  maxEasyRatio?: number;
  allowUncalibrated?: boolean;
  allowActiveRuns?: boolean;
  mainDbPath?: string;
  trainSimThreshold?: number;
  failOnTrainSim?: number;
  exportPath?: string;
  manifestOutPath?: string;
}

export interface FreezeSuiteReport {
  created: boolean;
  suiteName: string;
  itemCount: number;
  turnCount: number;
  videoCount: number;
  sha256: string;
  byType: Record<string, number>;
  byDifficulty: Record<string, number>;
  byBehavior: Record<string, number>;
  byVideo: Record<string, number>;
  runIds: number[];
  executionRunIds: number[];
  buildPlanIds: number[];
  easyRatio: number;
  maxEasyRatio: number;
  excludedEasyProbeIds: number[];
  trainOverlapScan: TrainOverlapScanReport | null;
  exportPath?: string;
  manifestOutPath?: string;
}

type MainQuestionSnapshot = ReturnType<DataMakerStore["readCorpusQuestionSnapshot"]>;
function readMainQuestionSnapshot(path: string): MainQuestionSnapshot {
  const mainStore = new DataMakerStore(path, { readOnly: true });
  try { return mainStore.readCorpusQuestionSnapshot(); } finally { mainStore.close(); }
}

function scanTrainQuestionSimilarity(
  mainDbPath: string,
  probes: readonly ProbeRecord[],
  threshold: number,
  snapshot: MainQuestionSnapshot,
): TrainOverlapScanReport {
  const splitByKey = new Map<string, string>();
  for (const row of snapshot.splits) {
    splitByKey.set(row.video_key, row.split);
  }

  const trainQuestions: string[] = [];
  for (const row of snapshot.questions) {
    if (splitByKey.get(extractVideoKey(row.video_id)) === "train") {
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
    return { selected: [...probes].sort((a, b) => a.id - b.id), excludedEasyProbeIds: [] };
  }

  const maxAllowedEasy =
    maxEasyRatio <= 0
      ? 0
      : Math.floor((nonEasy.length * maxEasyRatio) / (1 - maxEasyRatio) + 1e-12);

  if (easy.length <= maxAllowedEasy) {
    return { selected: [...probes].sort((a, b) => a.id - b.id), excludedEasyProbeIds: [] };
  }

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
  const excludedEasyProbeIds = sortedEasy
    .slice(maxAllowedEasy)
    .map((p) => p.id)
    .sort((a, b) => a - b);

  return {
    selected: [...nonEasy, ...keptEasy].sort((a, b) => a.id - b.id),
    excludedEasyProbeIds,
  };
}

/**
 * Freezes accepted calibrated probes into an immutable suite in `eval.sqlite`,
 * enforcing active-run guards, easy-ratio caps, main-DB split verification,
 * train-set 2-gram similarity auditing, and deterministic JSONL hashing.
 */
export async function freezeEvalSuite(options: FreezeSuiteOptions): Promise<FreezeSuiteReport> {
  const { evalStore } = options;
  if (options.mainDbPath !== undefined) assertDistinctDatabaseFiles(options.mainDbPath, evalStore.path);
  const suiteName = nonEmpty(options.name, "--suite");
  const maxEasyRatio = options.maxEasyRatio ?? DEFAULT_MAX_EASY_RATIO;
  if (!Number.isFinite(maxEasyRatio) || maxEasyRatio < 0 || maxEasyRatio > 1) {
    throw new Error("--max-easy-ratio 必须在 [0, 1] 范围内");
  }
  const trainSimThreshold = options.trainSimThreshold ?? DUPLICATE_NGRAM_THRESHOLD;
  const signal = combineSignals(evalStore.signal, options.signal);
  throwIfAborted(signal);
  if (options.runId !== undefined && options.executionRunId !== undefined) throw new Error("runId 与 executionRunId 只能指定一个");

  const frozen = evalStore.transaction(() => {

    if (!options.allowActiveRuns) {
      const activeRuns = evalStore.listActiveRuns(["probe_build", "calibrate"]);
      if (activeRuns.length > 0) {
        const desc = activeRuns.map((r) => `#${r.id}(${r.kind})`).join(", ");
        throw new Error(
          `存在正在运行中的任务（${desc}），禁止并发冻结套卷；请等待其结束，或显式传入 --allow-active-runs`,
        );
      }
    }

    const plans = evalStore.listBuildPlans(options.executionRunId !== undefined ? { executionRunId: options.executionRunId } : options.runId !== undefined ? { originRunId: options.runId } : {});
    const checkedPlans = options.executionRunId !== undefined || options.runId !== undefined ? plans : evalStore.listBuildPlans({ latestOnly: true });
    const omittedPlans = checkedPlans.filter((plan) => !plan.planComplete || !["done", "skipped"].includes(plan.status));
    if (omittedPlans.length && !options.allowPartialBuild) {
      throw new Error(`build_partial: 未完成造题计划 ${omittedPlans.map((plan) => `#${plan.id}(${plan.errorCode ?? plan.status})`).join(", ")}`);
    }
    const accepted = evalStore.listProbes({
      runId: options.runId,
      executionRunId: options.executionRunId,
      status: "accepted",
      probeTypes: options.probeTypes,
    });
    if (accepted.length === 0) {
      throw new Error("未找到任何已通过（accepted）的考题，无法冻结套卷");
    }

    if (!options.allowUncalibrated) {
      const uncalibrated = accepted.filter((p) => p.difficulty === null);
      if (uncalibrated.length > 0) {
        throw new Error(
          `存在 ${uncalibrated.length} 道尚未完成难度标定的考题（如 probe #${uncalibrated[0]!.id}）；请先标定，或显式传入 --allow-uncalibrated`,
        );
      }
    }

    const { selected, excludedEasyProbeIds } = selectWithEasyCap(evalStore, accepted, maxEasyRatio);
    if (selected.length === 0) {
      throw new Error(`按 --max-easy-ratio ${maxEasyRatio} 筛选后没有任何考题可冻结`);
    }

    const sourceCache = new Map<number, SourceMaterialRecord>();
    const usedSources: SourceMaterialRecord[] = [];
    const seenSourceIds = new Set<number>();

    interface ExportedSuiteLine {
      itemKey: string;
      videoKey: string;
      probeType: ProbeType;
      difficulty: DifficultyLevel | null;
      persona: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      rubrics: SuiteRubricEntry[];
    }

    const exportedLines: ExportedSuiteLine[] = [];
    const suiteItems: Array<{
      itemKey: string;
      videoKey: string;
      probeType: ProbeType;
      difficulty: DifficultyLevel | null;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      rubrics: SuiteRubricEntry[];
    }> = [];

    const byType: Record<string, number> = {};
    const byDifficulty: Record<string, number> = {};
    const byBehavior: Record<string, number> = {};
    const byVideo: Record<string, number> = {};
    const runIdSet = new Set<number>();
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

      throwIfAborted(signal);
      const turns = evalStore.listProbeTurns(probe.id);
      if (turns.length !== probe.targetTurns || turns.some((turn, index) => turn.turnNo !== index + 1)) {
        throw new Error(`probe #${probe.id} 对话轮数不完整：预期 ${probe.targetTurns} 轮，实际 ${turns.length} 轮`);
      }

      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
      const rubrics: SuiteRubricEntry[] = [];
      for (const turn of turns) {
        messages.push({ role: "user", content: turn.userContent });
        messages.push({ role: "assistant", content: turn.referenceAnswer });
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
      byVideo[source.videoKey] = (byVideo[source.videoKey] ?? 0) + 1;
      runIdSet.add(probe.runId);
      byType[probe.probeType] = (byType[probe.probeType] ?? 0) + 1;
      const diffKey = probe.difficulty ?? "uncalibrated";
      byDifficulty[diffKey] = (byDifficulty[diffKey] ?? 0) + 1;

      exportedLines.push({
        itemKey,
        videoKey: source.videoKey,
        probeType: probe.probeType,
        difficulty: probe.difficulty,
        persona: probe.persona,
        messages,
        rubrics,
      });
      suiteItems.push({
        itemKey,
        videoKey: source.videoKey,
        probeType: probe.probeType,
        difficulty: probe.difficulty,
        messages,
        rubrics,
      });
    }

    let trainOverlapScan: TrainOverlapScanReport | null = null;
    if (options.mainDbPath) {
      const mainSnapshot = readMainQuestionSnapshot(options.mainDbPath);
      verifySourceSplits(options.mainDbPath, usedSources, mainSnapshot.splits);
      trainOverlapScan = scanTrainQuestionSimilarity(options.mainDbPath, selected, trainSimThreshold, mainSnapshot);
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
    const sortedRunIds = [...runIdSet].sort((a, b) => a - b);

    const sourceSha256s: Record<string, string> = {};
    for (const s of [...usedSources].sort((a, b) => a.videoId.localeCompare(b.videoId))) {
      sourceSha256s[s.videoId] = s.contentSha256;
    }

    const selectedIds = new Set(selected.map((probe) => probe.id));
    const buildPlanIds = plans.filter((plan) => evalStore.listBuildSlots(plan.id).some((slot) => slot.probeId !== null && selectedIds.has(slot.probeId))).map((plan) => plan.id).sort((a, b) => a - b);
    const executionRunIds = options.executionRunId === undefined ? [] : [options.executionRunId];
    const buildOmissions = omittedPlans.map((plan) => ({ planId: plan.id, reason: plan.errorCode ?? plan.status, planComplete: plan.planComplete, pendingSlots: evalStore.listBuildSlots(plan.id).filter((slot) => !["accepted", "rejected", "dropped"].includes(slot.status)).length }));
    const manifest: Record<string, unknown> = {
      suiteName,
      runIds: sortedRunIds,
      executionRunIds,
      buildPlanIds,
      probeIds: selected.map((probe) => probe.id),
      buildOmissions,
      partialBuild: buildOmissions.length > 0,
      sourceMaterialIds: usedSources.map((source) => source.id).sort((a, b) => a - b),
      itemCount: selected.length,
      turnCount,
      videoCount: sortedVideoKeys.length,
      videoKeys: sortedVideoKeys,
      byVideo,
      byType,
      byDifficulty,
      byBehavior,
      easyRatio,
      maxEasyRatio,
      excludedEasyProbeIds,
      sourceSha256s,
      trainOverlapScan,
      sha256,
      frozenAt: nowIso(),
    };

    throwIfAborted(signal);
    const { created, suite } = evalStore.freezeSuite({
      name: suiteName,
      sha256,
      manifest,
      items: suiteItems,
    });

    return { suite, jsonl, report: {
      created,
      suiteName: suite.name,
      itemCount: suite.itemCount,
      turnCount,
      videoCount: sortedVideoKeys.length,
      sha256: suite.sha256,
      byType,
      byDifficulty,
      byBehavior,
      byVideo,
      runIds: sortedRunIds,
      executionRunIds,
      buildPlanIds,
      easyRatio,
      maxEasyRatio,
      excludedEasyProbeIds,
      trainOverlapScan,
      ...(options.exportPath ? { exportPath: options.exportPath } : {}),
      ...(options.manifestOutPath ? { manifestOutPath: options.manifestOutPath } : {}),
    } };
  });
  const { suite, jsonl } = frozen;
  if (options.exportPath) {
    await mkdir(dirname(options.exportPath), { recursive: true });
    await writeFile(options.exportPath, jsonl, "utf8");
  }
  if (options.manifestOutPath) {
    await mkdir(dirname(options.manifestOutPath), { recursive: true });
    await writeFile(options.manifestOutPath, JSON.stringify(suite.manifest, null, 2) + "\n", "utf8");
  }

  return frozen.report;
}
