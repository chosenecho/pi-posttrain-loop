import {
  EvalStore,
  type DifficultyLevel,
  type EvalHistoryMode,
  type EvalRunRecord,
  type EvalScoreRecord,
} from "./eval-db.js";
import { extractSuiteDialogueTurns } from "./eval-runner.js";
import { BEHAVIOR_FAIL_SCORE_CAP } from "./grader-core.js";

export interface ItemScoreSummary {
  suiteItemId: number;
  itemKey: string;
  videoKey: string;
  probeType: string;
  difficulty: DifficultyLevel | "uncalibrated";
  expectedTurns: number;
  scoredTurns: number;
  itemScore: number;
  allBehaviorOk: boolean;
  turnMeanScore: number;
  forbiddenTurns: number;
  hallucinationTurns: number;
  failureSignalTurns: number;
  question: string;
  worstRationale: string;
}

export interface TypeMetricBucket {
  items: number;
  turns: number;
  itemMeanScore: number;
  itemBehaviorPassRate: number;
  turnMeanScore: number;
  turnBehaviorPassRate: number;
}

export interface BehaviorMetricBucket {
  turns: number;
  behaviorPassRate: number;
  meanScore: number;
}

export interface DifficultyMetricBucket {
  items: number;
  itemMeanScore: number;
  itemBehaviorPassRate: number;
}

export interface CandidateSuiteMetrics {
  evalRunId: number;
  suiteName: string;
  suiteKind: "in_distribution" | "adversarial";
  candidate: string;
  model: string;
  graderModels: string[];
  historyMode: EvalHistoryMode;
  status: string;
  sameModelNotice: boolean;
  expectedItems: number;
  expectedTurns: number;
  scoredItems: number;
  scoredTurns: number;
  turnCoverage: number;
  itemMeanScore: number;
  itemBehaviorPassRate: number;
  turnMeanScore: number;
  turnBehaviorPassRate: number;
  meanStance: number;
  meanKeyPointCoverage: number;
  meanStyle: number;
  forbiddenHitRate: number;
  hallucinationHitRate: number;
  failureSignalHitRate: number;
  byType: Record<string, TypeMetricBucket>;
  byBehavior: Record<string, BehaviorMetricBucket>;
  byDifficulty: Record<string, DifficultyMetricBucket>;
  items: ItemScoreSummary[];
}

export interface PairwiseItemDelta {
  itemKey: string;
  probeType: string;
  difficulty: string;
  question: string;
  baselineScore: number;
  targetScore: number;
  deltaScore: number;
  baselineBehaviorOk: boolean;
  targetBehaviorOk: boolean;
  targetRationale: string;
}

export interface PairwiseSuiteComparison {
  suiteName: string;
  baseline: string;
  target: string;
  commonItems: number;
  deltaItemScore: number;
  deltaItemBehaviorPassRate: number;
  deltaTurnScore: number;
  deltaMeanStance: number;
  deltaKeyPointCoverage: number;
  deltaMeanStyle: number;
  deltaHallucinationHitRate: number;
  wins: number;
  ties: number;
  losses: number;
  behaviorFlippedToPass: number;
  behaviorFlippedToFail: number;
  topImproved: PairwiseItemDelta[];
  topRegressed: PairwiseItemDelta[];
}

export interface EvalComparisonReport {
  generatedAt: string;
  historyMode: EvalHistoryMode;
  suites: string[];
  candidates: string[];
  baselineCandidate?: string;
  entries: CandidateSuiteMetrics[];
  comparisons: PairwiseSuiteComparison[];
  missingPairs: Array<{ suiteName: string; candidate: string }>;
}

export interface BuildEvalReportOptions {
  evalStore: EvalStore;
  suites?: string[];
  candidates?: string[];
  runIds?: number[];
  historyMode?: EvalHistoryMode;
  baselineCandidate?: string;
}

const KEY_ADVERSARIAL_TYPES = ["premise_trap", "hallucination_bait", "pressure"] as const;

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function signed(val: number, suffix = ""): string {
  const prefix = val > 0 ? "+" : "";
  return `${prefix}${val.toFixed(2)}${suffix}`;
}

function signedPct(deltaRatio: number): string {
  const pts = deltaRatio * 100;
  const prefix = pts > 0 ? "+" : "";
  return `${prefix}${pts.toFixed(1)}pp`;
}

function extractTurnExpectedBehavior(score: EvalScoreRecord): string {
  const fromDetail = score.detail.expectedBehavior;
  if (typeof fromDetail === "string" && fromDetail.trim()) return fromDetail.trim();
  return score.itemExpectedBehavior ?? "answer";
}

function extractRationale(score: EvalScoreRecord): string {
  const judgement = score.detail.judgement;
  if (judgement && typeof judgement === "object" && "rationale" in judgement) {
    return String((judgement as { rationale?: unknown }).rationale ?? "");
  }
  return "";
}

function computeRunMetrics(evalStore: EvalStore, run: EvalRunRecord): CandidateSuiteMetrics {
  const suiteItems = evalStore.listSuiteItemsBySuiteId(run.suiteId);
  const scores = evalStore.listEvalScores(run.id);

  const expectedTurnsByItemId = new Map<number, number>();
  const questionByItemId = new Map<number, string>();
  let expectedTurns = 0;
  for (const item of suiteItems) {
    const turns = extractSuiteDialogueTurns(item);
    expectedTurnsByItemId.set(item.id, turns.length);
    questionByItemId.set(item.id, turns[0]?.user ?? "");
    expectedTurns += turns.length;
  }

  const scoresByItemId = new Map<number, EvalScoreRecord[]>();
  const graderModelSet = new Set<string>();
  let sameModelNotice = false;

  const byBehaviorAcc = new Map<string, { turns: number; pass: number; scoreSum: number }>();

  let turnScoreSum = 0;
  let turnBehaviorPass = 0;
  let stanceSum = 0;
  let kpSum = 0;
  let styleSum = 0;
  let forbiddenTurns = 0;
  let hallucinationTurns = 0;
  let failureSignalTurns = 0;

  for (const sc of scores) {
    graderModelSet.add(sc.graderModel);
    if (sc.detail.sameModelNotice === true || sc.graderModel.trim().toLowerCase() === run.model.trim().toLowerCase()) {
      sameModelNotice = true;
    }

    const list = scoresByItemId.get(sc.suiteItemId);
    if (list) list.push(sc);
    else scoresByItemId.set(sc.suiteItemId, [sc]);

    turnScoreSum += sc.score;
    if (sc.behaviorOk) turnBehaviorPass++;
    stanceSum += sc.stance;
    kpSum += sc.keyPointCoverage;
    styleSum += sc.style;
    if (sc.forbiddenHits > 0) forbiddenTurns++;
    if (sc.hallucinationHits > 0) hallucinationTurns++;
    if (sc.failureSignalHits > 0) failureSignalTurns++;

    const beh = extractTurnExpectedBehavior(sc);
    const b = byBehaviorAcc.get(beh) ?? { turns: 0, pass: 0, scoreSum: 0 };
    b.turns++;
    if (sc.behaviorOk) b.pass++;
    b.scoreSum += sc.score;
    byBehaviorAcc.set(beh, b);
  }

  const itemSummaries: ItemScoreSummary[] = [];
  const byTypeAcc = new Map<string, {
    items: number;
    turns: number;
    itemScoreSum: number;
    itemPass: number;
    turnScoreSum: number;
    turnPass: number;
  }>();
  const byDiffAcc = new Map<string, { items: number; itemScoreSum: number; itemPass: number }>();

  let itemScoreSum = 0;
  let itemBehaviorPass = 0;

  for (const item of suiteItems) {
    const itemScores = scoresByItemId.get(item.id);
    if (!itemScores || itemScores.length === 0) continue;

    const allBehaviorOk = itemScores.every((s) => s.behaviorOk);
    const turnMean = itemScores.reduce((s, x) => s + x.score, 0) / itemScores.length;
    const itemScore = round2(allBehaviorOk ? turnMean : Math.min(turnMean, BEHAVIOR_FAIL_SCORE_CAP));

    const worstTurn = [...itemScores].sort((a, b) => a.score - b.score || a.turnNo - b.turnNo)[0]!;
    const probeType = item.probeType ?? "in_distribution";
    const difficulty: DifficultyLevel | "uncalibrated" = item.difficulty ?? "uncalibrated";

    itemSummaries.push({
      suiteItemId: item.id,
      itemKey: item.itemKey,
      videoKey: item.videoKey,
      probeType,
      difficulty,
      expectedTurns: expectedTurnsByItemId.get(item.id) ?? itemScores.length,
      scoredTurns: itemScores.length,
      itemScore,
      allBehaviorOk,
      turnMeanScore: round2(turnMean),
      forbiddenTurns: itemScores.filter((s) => s.forbiddenHits > 0).length,
      hallucinationTurns: itemScores.filter((s) => s.hallucinationHits > 0).length,
      failureSignalTurns: itemScores.filter((s) => s.failureSignalHits > 0).length,
      question: questionByItemId.get(item.id) ?? "",
      worstRationale: extractRationale(worstTurn),
    });

    itemScoreSum += itemScore;
    if (allBehaviorOk) itemBehaviorPass++;

    const t = byTypeAcc.get(probeType) ?? {
      items: 0,
      turns: 0,
      itemScoreSum: 0,
      itemPass: 0,
      turnScoreSum: 0,
      turnPass: 0,
    };
    t.items++;
    t.turns += itemScores.length;
    t.itemScoreSum += itemScore;
    if (allBehaviorOk) t.itemPass++;
    t.turnScoreSum += itemScores.reduce((s, x) => s + x.score, 0);
    t.turnPass += itemScores.filter((s) => s.behaviorOk).length;
    byTypeAcc.set(probeType, t);

    const d = byDiffAcc.get(difficulty) ?? { items: 0, itemScoreSum: 0, itemPass: 0 };
    d.items++;
    d.itemScoreSum += itemScore;
    if (allBehaviorOk) d.itemPass++;
    byDiffAcc.set(difficulty, d);
  }

  const scoredItems = itemSummaries.length;
  const scoredTurns = scores.length;

  const byType: Record<string, TypeMetricBucket> = {};
  for (const [k, v] of [...byTypeAcc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byType[k] = {
      items: v.items,
      turns: v.turns,
      itemMeanScore: v.items > 0 ? round2(v.itemScoreSum / v.items) : 0,
      itemBehaviorPassRate: v.items > 0 ? round4(v.itemPass / v.items) : 0,
      turnMeanScore: v.turns > 0 ? round2(v.turnScoreSum / v.turns) : 0,
      turnBehaviorPassRate: v.turns > 0 ? round4(v.turnPass / v.turns) : 0,
    };
  }

  const byBehavior: Record<string, BehaviorMetricBucket> = {};
  for (const [k, v] of [...byBehaviorAcc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byBehavior[k] = {
      turns: v.turns,
      behaviorPassRate: v.turns > 0 ? round4(v.pass / v.turns) : 0,
      meanScore: v.turns > 0 ? round2(v.scoreSum / v.turns) : 0,
    };
  }

  const byDifficulty: Record<string, DifficultyMetricBucket> = {};
  for (const key of ["hard", "medium", "easy", "uncalibrated"]) {
    const v = byDiffAcc.get(key);
    if (!v) continue;
    byDifficulty[key] = {
      items: v.items,
      itemMeanScore: v.items > 0 ? round2(v.itemScoreSum / v.items) : 0,
      itemBehaviorPassRate: v.items > 0 ? round4(v.itemPass / v.items) : 0,
    };
  }

  return {
    evalRunId: run.id,
    suiteName: run.suiteName,
    suiteKind: run.suiteKind,
    candidate: run.candidate,
    model: run.model,
    graderModels: [...graderModelSet].sort(),
    historyMode: run.historyMode,
    status: run.status,
    sameModelNotice,
    expectedItems: suiteItems.length,
    expectedTurns,
    scoredItems,
    scoredTurns,
    turnCoverage: expectedTurns > 0 ? round4(scoredTurns / expectedTurns) : 0,
    itemMeanScore: scoredItems > 0 ? round2(itemScoreSum / scoredItems) : 0,
    itemBehaviorPassRate: scoredItems > 0 ? round4(itemBehaviorPass / scoredItems) : 0,
    turnMeanScore: scoredTurns > 0 ? round2(turnScoreSum / scoredTurns) : 0,
    turnBehaviorPassRate: scoredTurns > 0 ? round4(turnBehaviorPass / scoredTurns) : 0,
    meanStance: scoredTurns > 0 ? round2(stanceSum / scoredTurns) : 0,
    meanKeyPointCoverage: scoredTurns > 0 ? round4(kpSum / scoredTurns) : 0,
    meanStyle: scoredTurns > 0 ? round2(styleSum / scoredTurns) : 0,
    forbiddenHitRate: scoredTurns > 0 ? round4(forbiddenTurns / scoredTurns) : 0,
    hallucinationHitRate: scoredTurns > 0 ? round4(hallucinationTurns / scoredTurns) : 0,
    failureSignalHitRate: scoredTurns > 0 ? round4(failureSignalTurns / scoredTurns) : 0,
    byType,
    byBehavior,
    byDifficulty,
    items: itemSummaries,
  };
}

function comparePair(base: CandidateSuiteMetrics, target: CandidateSuiteMetrics): PairwiseSuiteComparison {
  const baseByKey = new Map(base.items.map((i) => [i.itemKey, i]));
  const deltas: PairwiseItemDelta[] = [];

  let wins = 0;
  let ties = 0;
  let losses = 0;
  let behaviorFlippedToPass = 0;
  let behaviorFlippedToFail = 0;

  for (const tItem of target.items) {
    const bItem = baseByKey.get(tItem.itemKey);
    if (!bItem) continue;
    const deltaScore = round2(tItem.itemScore - bItem.itemScore);

    if (!bItem.allBehaviorOk && tItem.allBehaviorOk) behaviorFlippedToPass++;
    if (bItem.allBehaviorOk && !tItem.allBehaviorOk) behaviorFlippedToFail++;

    if (deltaScore >= 1 || (!bItem.allBehaviorOk && tItem.allBehaviorOk)) {
      wins++;
    } else if (deltaScore <= -1 || (bItem.allBehaviorOk && !tItem.allBehaviorOk)) {
      losses++;
    } else {
      ties++;
    }

    deltas.push({
      itemKey: tItem.itemKey,
      probeType: tItem.probeType,
      difficulty: tItem.difficulty,
      question: tItem.question,
      baselineScore: bItem.itemScore,
      targetScore: tItem.itemScore,
      deltaScore,
      baselineBehaviorOk: bItem.allBehaviorOk,
      targetBehaviorOk: tItem.allBehaviorOk,
      targetRationale: tItem.worstRationale,
    });
  }

  const topImproved = [...deltas]
    .filter((d) => d.deltaScore > 0 || (!d.baselineBehaviorOk && d.targetBehaviorOk))
    .sort((a, b) => b.deltaScore - a.deltaScore || a.itemKey.localeCompare(b.itemKey))
    .slice(0, 5);

  const topRegressed = [...deltas]
    .filter((d) => d.deltaScore < 0 || (d.baselineBehaviorOk && !d.targetBehaviorOk))
    .sort((a, b) => a.deltaScore - b.deltaScore || a.itemKey.localeCompare(b.itemKey))
    .slice(0, 5);

  return {
    suiteName: base.suiteName,
    baseline: base.candidate,
    target: target.candidate,
    commonItems: deltas.length,
    deltaItemScore: round2(target.itemMeanScore - base.itemMeanScore),
    deltaItemBehaviorPassRate: round4(target.itemBehaviorPassRate - base.itemBehaviorPassRate),
    deltaTurnScore: round2(target.turnMeanScore - base.turnMeanScore),
    deltaMeanStance: round2(target.meanStance - base.meanStance),
    deltaKeyPointCoverage: round4(target.meanKeyPointCoverage - base.meanKeyPointCoverage),
    deltaMeanStyle: round2(target.meanStyle - base.meanStyle),
    deltaHallucinationHitRate: round4(target.hallucinationHitRate - base.hallucinationHitRate),
    wins,
    ties,
    losses,
    behaviorFlippedToPass,
    behaviorFlippedToFail,
    topImproved,
    topRegressed,
  };
}

/**
 * Builds a structured multi-suite × multi-candidate evaluation report directly from `eval.sqlite`.
 */
export function buildEvalReport(options: BuildEvalReportOptions): EvalComparisonReport {
  const { evalStore } = options;
  const historyMode: EvalHistoryMode = options.historyMode ?? "gold";

  const selectedRuns: EvalRunRecord[] = [];
  const missingPairs: Array<{ suiteName: string; candidate: string }> = [];

  if (options.runIds && options.runIds.length > 0) {
    for (const id of options.runIds) {
      const run = evalStore.getEvalRun(id);
      if (!run) throw new Error(`未找到评测运行：eval_run #${id}`);
      selectedRuns.push(run);
    }
  } else {
    const allRuns = evalStore.listEvalRuns({ historyMode });
    const gradedRuns = allRuns.filter((r) => evalStore.listEvalScores(r.id).length > 0);
    if (gradedRuns.length === 0) {
      throw new Error(`未找到已批卷的评测运行（historyMode=${historyMode}），请先运行 eval run 与 eval grade`);
    }

    const suites = options.suites && options.suites.length > 0
      ? options.suites
      : [...new Set(gradedRuns.map((r) => r.suiteName))];
    const candidates = options.candidates && options.candidates.length > 0
      ? options.candidates
      : [...new Set(gradedRuns.map((r) => r.candidate))];

    for (const suiteName of suites) {
      for (const candidate of candidates) {
        const matches = gradedRuns.filter((r) => r.suiteName === suiteName && r.candidate === candidate);
        if (matches.length === 0) {
          missingPairs.push({ suiteName, candidate });
          continue;
        }
        // Pick the newest graded run for (suiteName, candidate)
        selectedRuns.push(matches[matches.length - 1]!);
      }
    }
  }

  if (selectedRuns.length === 0) {
    throw new Error("未匹配到任何已批卷的 (suite, candidate) 组合");
  }

  const entries = selectedRuns.map((run) => computeRunMetrics(evalStore, run));
  const suites = options.suites && options.suites.length > 0
    ? options.suites.filter((s) => entries.some((e) => e.suiteName === s))
    : [...new Set(entries.map((e) => e.suiteName))];
  const candidates = options.candidates && options.candidates.length > 0
    ? options.candidates.filter((c) => entries.some((e) => e.candidate === c))
    : [...new Set(entries.map((e) => e.candidate))];

  const baselineCandidate = options.baselineCandidate
    ? (candidates.includes(options.baselineCandidate) ? options.baselineCandidate : undefined)
    : (candidates.length >= 2 ? candidates[0] : undefined);

  const comparisons: PairwiseSuiteComparison[] = [];
  if (baselineCandidate) {
    for (const suiteName of suites) {
      const baseEntry = entries.find((e) => e.suiteName === suiteName && e.candidate === baselineCandidate);
      if (!baseEntry) continue;
      for (const cand of candidates) {
        if (cand === baselineCandidate) continue;
        const targetEntry = entries.find((e) => e.suiteName === suiteName && e.candidate === cand);
        if (!targetEntry) continue;
        comparisons.push(comparePair(baseEntry, targetEntry));
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    historyMode: selectedRuns[0]!.historyMode,
    suites,
    candidates,
    ...(baselineCandidate ? { baselineCandidate } : {}),
    entries,
    comparisons,
    missingPairs,
  };
}

/**
 * Renders a Markdown report covering Suite × Candidate overview, adversarial behavior gates,
 * type/behavior/difficulty breakdowns, pairwise deltas, and worst failure diagnostics.
 */
export function renderEvalReportMarkdown(report: EvalComparisonReport, topFailures = 6): string {
  const lines: string[] = [];
  lines.push("# 候选模型脱稿盲测对比报告（M3 / P2）");
  lines.push("");
  lines.push(`- **生成时间**：\`${report.generatedAt}\``);
  lines.push(`- **测试套卷**：${report.suites.map((s) => `\`${s}\``).join("、")}`);
  lines.push(`- **候选模型**：${report.candidates.map((c) => `\`${c}\``).join(" vs ")}`);
  lines.push(`- **多轮历史模式**：\`${report.historyMode}\``);
  if (report.baselineCandidate) {
    lines.push(`- **对比基线**：\`${report.baselineCandidate}\``);
  }
  if (report.entries.some((e) => e.sameModelNotice)) {
    lines.push("- **⚠️ 同源提示**：部分评测批次的批卷模型与候选模型相同（`--allow-same-model`），仅适合联调或同套对比，正式结论建议使用异族裁判模型。");
  }
  if (report.missingPairs.length > 0) {
    lines.push(
      `- **缺测组合**：${report.missingPairs.map((p) => `\`${p.suiteName} × ${p.candidate}\``).join("、")}`,
    );
  }
  lines.push("");

  // 1. Overall Suite x Candidate summary
  lines.push("## 1. 总览（套卷 × 候选模型）");
  lines.push("");
  lines.push("| 套卷 | 候选 | Run | 覆盖率 | 题均分 | 题级行为通过 | 轮均分 | Stance | 要点覆盖 | Style | 禁区命中 | 幻觉命中 | 失败信号 |");
  lines.push("| :--- | :--- | :---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const suiteName of report.suites) {
    for (const cand of report.candidates) {
      const e = report.entries.find((x) => x.suiteName === suiteName && x.candidate === cand);
      if (!e) continue;
      lines.push(
        `| \`${e.suiteName}\` | **${e.candidate}** (\`${e.model}\`) | #${e.evalRunId} | ${e.scoredTurns}/${e.expectedTurns} (${pct(e.turnCoverage)}) | **${e.itemMeanScore.toFixed(2)}** | **${pct(e.itemBehaviorPassRate)}** | ${e.turnMeanScore.toFixed(2)} | ${e.meanStance.toFixed(2)}/2 | ${pct(e.meanKeyPointCoverage)} | ${e.meanStyle.toFixed(2)}/2 | ${pct(e.forbiddenHitRate)} | ${pct(e.hallucinationHitRate)} | ${pct(e.failureSignalHitRate)} |`,
      );
    }
  }
  lines.push("");

  // 2. Pairwise Delta summary
  if (report.comparisons.length > 0) {
    lines.push("## 2. 相对基线变化（Δ）与逐题胜负");
    lines.push("");
    lines.push("| 套卷 | 对比 | 共同题数 | Δ 题均分 | Δ 行为通过率 | Δ 幻觉率 | 胜 / 平 / 负 | 行为转通过 / 转失败 |");
    lines.push("| :--- | :--- | :---: | ---: | ---: | ---: | :---: | :---: |");
    for (const cmp of report.comparisons) {
      lines.push(
        `| \`${cmp.suiteName}\` | \`${cmp.baseline}\` → \`${cmp.target}\` | ${cmp.commonItems} | **${signed(cmp.deltaItemScore)}** | **${signedPct(cmp.deltaItemBehaviorPassRate)}** | ${signedPct(cmp.deltaHallucinationHitRate)} | ${cmp.wins} / ${cmp.ties} / ${cmp.losses} | +${cmp.behaviorFlippedToPass} / -${cmp.behaviorFlippedToFail} |`,
      );
    }
    lines.push("");
  }

  // 3. Per-suite detailed breakdown
  for (const suiteName of report.suites) {
    const suiteEntries = report.entries.filter((e) => e.suiteName === suiteName);
    if (suiteEntries.length === 0) continue;
    const isAdv = suiteEntries[0]!.suiteKind === "adversarial";
    lines.push(`## 套卷明细：\`${suiteName}\`（${isAdv ? "对抗实战卷" : "同分布基准卷"}）`);
    lines.push("");

    // Adversarial key gates highlight
    if (isAdv) {
      lines.push("### 重点对抗闸门（`premise_trap` / `hallucination_bait` / `pressure`）");
      lines.push("");
      lines.push("| 候选 | `premise_trap` 通过率 / 均分 | `hallucination_bait` 通过率 / 均分 | `pressure` 通过率 / 均分 |");
      lines.push("| :--- | :---: | :---: | :---: |");
      for (const e of suiteEntries) {
        const cols = KEY_ADVERSARIAL_TYPES.map((t) => {
          const b = e.byType[t];
          return b ? `${pct(b.itemBehaviorPassRate)} / ${b.itemMeanScore.toFixed(1)}` : "—";
        });
        lines.push(`| **${e.candidate}** | ${cols.join(" | ")} |`);
      }
      lines.push("");
    }

    // By probe_type
    const allTypes = [...new Set(suiteEntries.flatMap((e) => Object.keys(e.byType)))].sort();
    if (allTypes.length > 0) {
      lines.push("### 按题型分布（`probe_type`）");
      lines.push("");
      const header = ["题型", ...suiteEntries.map((e) => `\`${e.candidate}\`（均分 / 行为通过）`)];
      lines.push(`| ${header.join(" | ")} |`);
      lines.push(`| :--- | ${suiteEntries.map(() => ":---:").join(" | ")} |`);
      for (const t of allTypes) {
        const cells = suiteEntries.map((e) => {
          const b = e.byType[t];
          return b ? `${b.itemMeanScore.toFixed(2)} / ${pct(b.itemBehaviorPassRate)} (n=${b.items})` : "—";
        });
        lines.push(`| \`${t}\` | ${cells.join(" | ")} |`);
      }
      lines.push("");
    }

    // By expectedBehavior
    const allBehaviors = [...new Set(suiteEntries.flatMap((e) => Object.keys(e.byBehavior)))].sort();
    if (allBehaviors.length > 0) {
      lines.push("### 按轮次预期行为（`expectedBehavior`）");
      lines.push("");
      const header = ["预期行为", ...suiteEntries.map((e) => `\`${e.candidate}\`（通过率 / 轮均分）`)];
      lines.push(`| ${header.join(" | ")} |`);
      lines.push(`| :--- | ${suiteEntries.map(() => ":---:").join(" | ")} |`);
      for (const beh of allBehaviors) {
        const cells = suiteEntries.map((e) => {
          const b = e.byBehavior[beh];
          return b ? `${pct(b.behaviorPassRate)} / ${b.meanScore.toFixed(2)} (${b.turns} 轮)` : "—";
        });
        lines.push(`| \`${beh}\` | ${cells.join(" | ")} |`);
      }
      lines.push("");
    }

    // By difficulty
    const allDiffs = ["hard", "medium", "easy", "uncalibrated"].filter((d) =>
      suiteEntries.some((e) => e.byDifficulty[d] !== undefined),
    );
    if (allDiffs.length > 0 && !(allDiffs.length === 1 && allDiffs[0] === "uncalibrated")) {
      lines.push("### 按难度分层（`difficulty`）");
      lines.push("");
      const header = ["难度", ...suiteEntries.map((e) => `\`${e.candidate}\`（均分 / 行为通过）`)];
      lines.push(`| ${header.join(" | ")} |`);
      lines.push(`| :--- | ${suiteEntries.map(() => ":---:").join(" | ")} |`);
      for (const d of allDiffs) {
        const cells = suiteEntries.map((e) => {
          const b = e.byDifficulty[d];
          return b ? `${b.itemMeanScore.toFixed(2)} / ${pct(b.itemBehaviorPassRate)} (n=${b.items})` : "—";
        });
        lines.push(`| \`${d}\` | ${cells.join(" | ")} |`);
      }
      lines.push("");
    }

    // Pairwise Top Improved / Regressed for this suite
    const suiteComparisons = report.comparisons.filter((c) => c.suiteName === suiteName);
    for (const cmp of suiteComparisons) {
      if (cmp.topImproved.length > 0) {
        lines.push(`### 进步最大样本（\`${cmp.baseline}\` → \`${cmp.target}\`）`);
        lines.push("");
        for (const item of cmp.topImproved) {
          lines.push(
            `- \`${item.itemKey}\` (\`${item.probeType}\`): ${item.baselineScore} → **${item.targetScore}** (${signed(item.deltaScore)}, behavior ${item.baselineBehaviorOk}→${item.targetBehaviorOk}) — ${item.question.slice(0, 60)}`,
          );
        }
        lines.push("");
      }
      if (cmp.topRegressed.length > 0) {
        lines.push(`### 退步样本预警（\`${cmp.baseline}\` → \`${cmp.target}\`）`);
        lines.push("");
        for (const item of cmp.topRegressed) {
          lines.push(
            `- \`${item.itemKey}\` (\`${item.probeType}\`): ${item.baselineScore} → **${item.targetScore}** (${signed(item.deltaScore)}, behavior ${item.baselineBehaviorOk}→${item.targetBehaviorOk}) — ${item.question.slice(0, 60)}`,
          );
          if (item.targetRationale) {
            lines.push(`  - 批卷说明：${item.targetRationale}`);
          }
        }
        lines.push("");
      }
    }

    // Worst failure diagnostics for each candidate
    if (topFailures > 0) {
      for (const e of suiteEntries) {
        const worst = [...e.items]
          .filter((i) => !i.allBehaviorOk || i.itemScore < 60)
          .sort((a, b) => a.itemScore - b.itemScore || a.itemKey.localeCompare(b.itemKey))
          .slice(0, topFailures);
        if (worst.length === 0) continue;
        lines.push(`### 失分诊断抽样：\`${e.candidate}\`（最低 ${worst.length} 题）`);
        lines.push("");
        for (const w of worst) {
          lines.push(
            `- \`${w.itemKey}\` (\`${w.probeType}\`, \`${w.difficulty}\`, score=${w.itemScore}, behaviorOk=\`${w.allBehaviorOk}\`): ${w.question.slice(0, 70)}`,
          );
          if (w.worstRationale) {
            lines.push(`  - 批卷说明：${w.worstRationale}`);
          }
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}
