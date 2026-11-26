import { nowIso } from "../shared/utils.js";
import { extractSuiteDialogueTurns } from "./eval-runner.js";
import {
  EvalStore,
  PROBE_TYPES,
  type EvalHistoryMode,
  type EvalRunRecord,
  type EvalScoreRecord,
  type ExpectedBehavior,
  type ProbeType,
  type SuiteItemRecord,
} from "./store/index.js";

export interface ItemScoreSummary {
  suiteItemId: number;
  itemKey: string;
  videoKey: string;
  probeType: ProbeType;
  difficulty: string;
  question: string;
  turnCount: number;
  scoredTurns: number;
  itemScore: number;
  allBehaviorOk: boolean;
  anyHallucinated: boolean;
  meanStyle: number;
}

export interface TypeMetricBucket {
  itemCount: number;
  turnCount: number;
  meanScore: number;
  behaviorPassRate: number;
  hallucinationRate: number;
}

export interface BehaviorMetricBucket {
  turnCount: number;
  meanScore: number;
  behaviorPassRate: number;
}

export interface DifficultyMetricBucket {
  itemCount: number;
  meanScore: number;
  behaviorPassRate: number;
}

export interface CandidateSuiteMetrics {
  evalRunId: number;
  suiteName: string;
  candidate: string;
  model: string;
  graderModels: string[];
  historyMode: EvalHistoryMode;
  status: string;
  totalItems: number;
  scoredItems: number;
  totalTurns: number;
  scoredTurns: number;
  errorTurns: number;
  meanItemScore: number;
  meanTurnScore: number;
  itemBehaviorPassRate: number;
  turnBehaviorPassRate: number;
  hallucinationRate: number;
  meanStyle: number;
  byType: Record<string, TypeMetricBucket>;
  byBehavior: Record<string, BehaviorMetricBucket>;
  byDifficulty: Record<string, DifficultyMetricBucket>;
  items: ItemScoreSummary[];
}

export interface PairwiseItemDelta {
  itemKey: string;
  probeType: ProbeType;
  difficulty: string;
  question: string;
  baselineScore: number;
  targetScore: number;
  deltaScore: number;
  baselineBehaviorOk: boolean;
  targetBehaviorOk: boolean;
}

export interface PairwiseSuiteComparison {
  suiteName: string;
  baselineCandidate: string;
  baselineRunId: number;
  targetCandidate: string;
  targetRunId: number;
  sharedItems: number;
  deltaMeanItemScore: number;
  deltaBehaviorPassRate: number;
  deltaHallucinationRate: number;
  wins: number;
  ties: number;
  losses: number;
  topImprovements: PairwiseItemDelta[];
  topRegressions: PairwiseItemDelta[];
}

export interface EvalComparisonReport {
  generatedAt: string;
  suites: string[];
  candidates: string[];
  entries: CandidateSuiteMetrics[];
  comparisons: PairwiseSuiteComparison[];
}

export interface BuildEvalReportOptions {
  evalStore: EvalStore;
  suites?: string[];
  candidates?: string[];
  runIds?: number[];
  baselineCandidate?: string;
  historyMode?: EvalHistoryMode;
}

function round(n: number, digits = 2): number {
  return Number(n.toFixed(digits));
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function signed(delta: number, digits = 2): string {
  const s = delta.toFixed(digits);
  return delta > 0 ? `+${s}` : s;
}

function resolveTurnBehavior(item: SuiteItemRecord, turnNo: number, score: EvalScoreRecord): ExpectedBehavior {
  const fromDetail = score.detail.expectedBehavior;
  if (typeof fromDetail === "string" && PROBE_TYPES.includes(fromDetail as ProbeType)) {
    return fromDetail as ExpectedBehavior;
  }
  const entry = item.rubrics.find((r) => r.turnNo === turnNo);
  if (entry) return entry.expectedBehavior;
  return item.probeType;
}

function computeCandidateMetrics(evalStore: EvalStore, run: EvalRunRecord): CandidateSuiteMetrics {
  const suiteItems = evalStore.listSuiteItems(run.suiteId);
  const predictions = evalStore.listEvalPredictions(run.id);
  const scores = evalStore.listEvalScores(run.id);

  const scoreByPredId = new Map<number, EvalScoreRecord>();
  const graderModelSet = new Set<string>();
  for (const sc of scores) {
    scoreByPredId.set(sc.predictionId, sc);
    graderModelSet.add(sc.graderModel);
  }

  const predsByItemId = new Map<number, typeof predictions>();
  let errorTurns = 0;
  for (const pred of predictions) {
    if (pred.error !== null) errorTurns++;
    const list = predsByItemId.get(pred.suiteItemId);
    if (list) list.push(pred);
    else predsByItemId.set(pred.suiteItemId, [pred]);
  }

  const itemSummaries: ItemScoreSummary[] = [];
  const byTypeAcc = new Map<string, { items: number; turns: number; scoreSum: number; behaviorPass: number; hallu: number }>();
  const byBehaviorAcc = new Map<string, { turns: number; scoreSum: number; behaviorPass: number }>();
  const byDiffAcc = new Map<string, { items: number; scoreSum: number; behaviorPass: number }>();

  let totalTurns = 0;
  let scoredTurns = 0;
  let turnScoreSum = 0;
  let turnBehaviorOkCount = 0;
  let turnHalluCount = 0;
  let styleSum = 0;

  for (const item of suiteItems) {
    const turns = extractSuiteDialogueTurns(item);
    totalTurns += turns.length;
    const itemPreds = predsByItemId.get(item.id) ?? [];
    const itemScores: Array<{ turnNo: number; score: EvalScoreRecord }> = [];
    for (const pred of itemPreds) {
      const sc = scoreByPredId.get(pred.id);
      if (sc) itemScores.push({ turnNo: pred.turnNo, score: sc });
    }
    if (itemScores.length === 0) continue;

    let itemTurnScoreSum = 0;
    let itemStyleSum = 0;
    let allBehaviorOk = true;
    let anyHallucinated = false;

    for (const { turnNo, score } of itemScores) {
      scoredTurns++;
      turnScoreSum += score.score;
      itemTurnScoreSum += score.score;
      styleSum += score.style;
      itemStyleSum += score.style;

      const hallu = score.hallucinationHits > 0;
      if (score.behaviorOk) turnBehaviorOkCount++;
      else allBehaviorOk = false;
      if (hallu) {
        turnHalluCount++;
        anyHallucinated = true;
      }

      const beh = resolveTurnBehavior(item, turnNo, score);
      const bAcc = byBehaviorAcc.get(beh) ?? { turns: 0, scoreSum: 0, behaviorPass: 0 };
      bAcc.turns++;
      bAcc.scoreSum += score.score;
      if (score.behaviorOk) bAcc.behaviorPass++;
      byBehaviorAcc.set(beh, bAcc);
    }

    const itemScore = round(itemTurnScoreSum / itemScores.length);
    const meanStyle = round(itemStyleSum / itemScores.length);
    const difficulty = item.difficulty ?? "uncalibrated";

    itemSummaries.push({
      suiteItemId: item.id,
      itemKey: item.itemKey,
      videoKey: item.videoKey,
      probeType: item.probeType,
      difficulty,
      question: turns[0]?.user ?? "",
      turnCount: turns.length,
      scoredTurns: itemScores.length,
      itemScore,
      allBehaviorOk,
      anyHallucinated,
      meanStyle,
    });

    const tAcc = byTypeAcc.get(item.probeType) ?? { items: 0, turns: 0, scoreSum: 0, behaviorPass: 0, hallu: 0 };
    tAcc.items++;
    tAcc.turns += itemScores.length;
    tAcc.scoreSum += itemScore;
    if (allBehaviorOk) tAcc.behaviorPass++;
    if (anyHallucinated) tAcc.hallu++;
    byTypeAcc.set(item.probeType, tAcc);

    const dAcc = byDiffAcc.get(difficulty) ?? { items: 0, scoreSum: 0, behaviorPass: 0 };
    dAcc.items++;
    dAcc.scoreSum += itemScore;
    if (allBehaviorOk) dAcc.behaviorPass++;
    byDiffAcc.set(difficulty, dAcc);
  }

  const scoredItems = itemSummaries.length;
  const meanItemScore = scoredItems > 0 ? round(itemSummaries.reduce((s, x) => s + x.itemScore, 0) / scoredItems) : 0;
  const meanTurnScore = scoredTurns > 0 ? round(turnScoreSum / scoredTurns) : 0;
  const itemBehaviorPassRate =
    scoredItems > 0 ? round(itemSummaries.filter((x) => x.allBehaviorOk).length / scoredItems, 4) : 0;
  const turnBehaviorPassRate = scoredTurns > 0 ? round(turnBehaviorOkCount / scoredTurns, 4) : 0;
  const hallucinationRate = scoredTurns > 0 ? round(turnHalluCount / scoredTurns, 4) : 0;
  const meanStyle = scoredTurns > 0 ? round(styleSum / scoredTurns) : 0;

  const byType: Record<string, TypeMetricBucket> = {};
  for (const [k, v] of byTypeAcc.entries()) {
    byType[k] = {
      itemCount: v.items,
      turnCount: v.turns,
      meanScore: round(v.scoreSum / v.items),
      behaviorPassRate: round(v.behaviorPass / v.items, 4),
      hallucinationRate: round(v.hallu / v.items, 4),
    };
  }

  const byBehavior: Record<string, BehaviorMetricBucket> = {};
  for (const [k, v] of byBehaviorAcc.entries()) {
    byBehavior[k] = {
      turnCount: v.turns,
      meanScore: round(v.scoreSum / v.turns),
      behaviorPassRate: round(v.behaviorPass / v.turns, 4),
    };
  }

  const byDifficulty: Record<string, DifficultyMetricBucket> = {};
  for (const [k, v] of byDiffAcc.entries()) {
    byDifficulty[k] = {
      itemCount: v.items,
      meanScore: round(v.scoreSum / v.items),
      behaviorPassRate: round(v.behaviorPass / v.items, 4),
    };
  }

  return {
    evalRunId: run.id,
    suiteName: run.suiteName,
    candidate: run.candidate,
    model: run.model,
    graderModels: [...graderModelSet].sort(),
    historyMode: run.historyMode,
    status: run.status,
    totalItems: suiteItems.length,
    scoredItems,
    totalTurns,
    scoredTurns,
    errorTurns,
    meanItemScore,
    meanTurnScore,
    itemBehaviorPassRate,
    turnBehaviorPassRate,
    hallucinationRate,
    meanStyle,
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

  for (const tItem of target.items) {
    const bItem = baseByKey.get(tItem.itemKey);
    if (!bItem) continue;
    const deltaScore = round(tItem.itemScore - bItem.itemScore);
    if (deltaScore > 1) wins++;
    else if (deltaScore < -1) losses++;
    else ties++;

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
    });
  }

  const topImprovements = [...deltas].filter((d) => d.deltaScore > 0).sort((a, b) => b.deltaScore - a.deltaScore).slice(0, 5);
  const topRegressions = [...deltas].filter((d) => d.deltaScore < 0).sort((a, b) => a.deltaScore - b.deltaScore).slice(0, 5);

  return {
    suiteName: base.suiteName,
    baselineCandidate: base.candidate,
    baselineRunId: base.evalRunId,
    targetCandidate: target.candidate,
    targetRunId: target.evalRunId,
    sharedItems: deltas.length,
    deltaMeanItemScore: round(target.meanItemScore - base.meanItemScore),
    deltaBehaviorPassRate: round(target.itemBehaviorPassRate - base.itemBehaviorPassRate, 4),
    deltaHallucinationRate: round(target.hallucinationRate - base.hallucinationRate, 4),
    wins,
    ties,
    losses,
    topImprovements,
    topRegressions,
  };
}

export function buildEvalReport(options: BuildEvalReportOptions): EvalComparisonReport {
  const { evalStore } = options;
  const allRuns = evalStore.listEvalRuns({
    suiteNames: options.suites,
    candidates: options.candidates,
    runIds: options.runIds,
    historyMode: options.historyMode,
  });

  // When runIds aren't pinned, pick latest scored run per (suiteName, candidate)
  const selectedRuns: EvalRunRecord[] = [];
  if (options.runIds && options.runIds.length > 0) {
    selectedRuns.push(...allRuns);
  } else {
    const latestByKey = new Map<string, EvalRunRecord>();
    for (const run of allRuns) {
      if (evalStore.listEvalScores(run.id).length === 0) continue;
      latestByKey.set(`${run.suiteName}\0${run.candidate}`, run);
    }
    selectedRuns.push(...latestByKey.values());
  }

  const entries = selectedRuns.map((run) => computeCandidateMetrics(evalStore, run));
  const suites = [...new Set(entries.map((e) => e.suiteName))];
  const candidates = [...new Set(entries.map((e) => e.candidate))];

  const comparisons: PairwiseSuiteComparison[] = [];
  if (options.baselineCandidate) {
    for (const suiteName of suites) {
      const suiteEntries = entries.filter((e) => e.suiteName === suiteName);
      const base = suiteEntries.find((e) => e.candidate === options.baselineCandidate);
      if (!base) continue;
      for (const target of suiteEntries) {
        if (target.evalRunId === base.evalRunId) continue;
        comparisons.push(comparePair(base, target));
      }
    }
  }

  return {
    generatedAt: nowIso(),
    suites,
    candidates,
    entries,
    comparisons,
  };
}

export function renderEvalReportMarkdown(report: EvalComparisonReport, topFailures = 6): string {
  const lines: string[] = [];
  lines.push("# 盲测评测对比报告");
  lines.push("");
  lines.push(`- **生成时间**: ${report.generatedAt}`);
  lines.push(`- **套卷**: ${report.suites.join(", ") || "（无）"}`);
  lines.push(`- **候选模型**: ${report.candidates.join(", ") || "（无）"}`);
  lines.push("");

  if (report.entries.length === 0) {
    lines.push("暂无已批卷的评测记录。");
    return lines.join("\n");
  }

  for (const suiteName of report.suites) {
    const suiteEntries = report.entries.filter((e) => e.suiteName === suiteName);
    lines.push(`## 套卷：\`${suiteName}\``);
    lines.push("");
    lines.push("| 候选 | Run | 历史 | 已评题/轮 | 题均分 | 行为通过率 | 幻觉率 | 文风 (0-2) |");
    lines.push("| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |");
    for (const e of suiteEntries) {
      lines.push(
        `| \`${e.candidate}\` | #${e.evalRunId} | ${e.historyMode} | ${e.scoredItems}/${e.totalItems} (${e.scoredTurns}t) | **${e.meanItemScore}** | ${pct(e.itemBehaviorPassRate)} | ${pct(e.hallucinationRate)} | ${e.meanStyle} |`,
      );
    }
    lines.push("");

    // Per 5-type breakdown
    lines.push("### 按题型分布（5 类）");
    lines.push("");
    lines.push("| 候选 | `answer` | `correct_premise` | `acknowledge_gap` | `refuse` | `hold_position` |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const e of suiteEntries) {
      const cells = PROBE_TYPES.map((t) => {
        const b = e.byType[t];
        return b ? `${pct(b.behaviorPassRate)} / ${b.meanScore} (n=${b.itemCount})` : "-";
      });
      lines.push(`| \`${e.candidate}\` | ${cells.join(" | ")} |`);
    }
    lines.push("");

    // Difficulty breakdown
    lines.push("### 按难度分层");
    lines.push("");
    lines.push("| 候选 | `hard` | `medium` | `easy` |");
    lines.push("| --- | --- | --- | --- |");
    for (const e of suiteEntries) {
      const cells = (["hard", "medium", "easy"] as const).map((d) => {
        const b = e.byDifficulty[d];
        return b ? `${pct(b.behaviorPassRate)} / ${b.meanScore} (n=${b.itemCount})` : "-";
      });
      lines.push(`| \`${e.candidate}\` | ${cells.join(" | ")} |`);
    }
    lines.push("");

    // Pairwise comparisons
    const suiteComps = report.comparisons.filter((c) => c.suiteName === suiteName);
    for (const c of suiteComps) {
      lines.push(`### 对比：\`${c.baselineCandidate}\` → \`${c.targetCandidate}\`（共 ${c.sharedItems} 题）`);
      lines.push("");
      lines.push(
        `- 题均分 Δ **${signed(c.deltaMeanItemScore)}** ｜ 行为通过率 Δ **${signed(c.deltaBehaviorPassRate * 100, 1)}%** ｜ 幻觉率 Δ **${signed(c.deltaHallucinationRate * 100, 1)}%** ｜ 胜/平/负 **${c.wins} / ${c.ties} / ${c.losses}**`,
      );
      if (c.topImprovements.length > 0) {
        lines.push("- **主要提升**：");
        for (const item of c.topImprovements) {
          lines.push(
            `  - \`${item.itemKey}\` (\`${item.probeType}\`): ${item.baselineScore} → **${item.targetScore}** (${signed(item.deltaScore)}) — ${item.question.slice(0, 60)}`,
          );
        }
      }
      if (c.topRegressions.length > 0) {
        lines.push("- **主要回退**：");
        for (const item of c.topRegressions) {
          lines.push(
            `  - \`${item.itemKey}\` (\`${item.probeType}\`): ${item.baselineScore} → **${item.targetScore}** (${signed(item.deltaScore)}) — ${item.question.slice(0, 60)}`,
          );
        }
      }
      lines.push("");
    }

    // Top failures per candidate
    for (const e of suiteEntries) {
      const worst = [...e.items]
        .filter((i) => !i.allBehaviorOk || i.itemScore < 60)
        .sort((a, b) => a.itemScore - b.itemScore)
        .slice(0, topFailures);
      if (worst.length === 0) continue;
      lines.push(`### 典型失分题（\`${e.candidate}\` #${e.evalRunId}）`);
      lines.push("");
      for (const w of worst) {
        lines.push(
          `- \`${w.itemKey}\` (\`${w.probeType}\`, \`${w.difficulty}\`, score=${w.itemScore}, behaviorOk=\`${w.allBehaviorOk}\`): ${w.question.slice(0, 70)}`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}
