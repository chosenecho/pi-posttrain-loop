import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  runWithRetry,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "../retry.js";
import { nonEmpty, validateConcurrency } from "../schema.js";
import { publicErrorMessage, toPublicError } from "../shared/public-error.js";
import { runConcurrentPool } from "../shared/concurrency.js";
import type { RoleRunner } from "../types.js";
import {
  EvalStore,
  type CalibrationTurnRecord,
  type DifficultyLevel,
  type ExpectedBehavior,
  type ProbeRecord,
} from "./eval-db.js";
import type { CalibrationPromptBundle } from "./eval-prompts.js";
import { classifyProbeDifficulty, scoreGradedTurn, type ScoredTurn } from "./grader-core.js";
import { parseGradeResult, type ProbeRubricV2 } from "./probe-schema.js";

export interface RunProbeCalibrationOptions {
  evalStore: EvalStore;
  probes: ProbeRecord[];
  prompts: CalibrationPromptBundle["prompts"];
  skills: CalibrationPromptBundle["skills"];
  runBareModel: RoleRunner;
  bareModelId: string;
  runGrader: RoleRunner;
  graderModelId: string;
  concurrency?: number;
  callMaxAttempts?: number;
  callRetryDelayMs?: number;
  onProgress?: (message: string) => void;
}

export interface CalibratedProbeReportItem {
  probeId: number;
  videoId: string;
  probeType: string;
  expectedBehavior: ExpectedBehavior;
  targetTurns: number;
  difficulty: DifficultyLevel;
  aggregateScore: number;
  allBehaviorOk: boolean;
  question: string;
  turns: Array<{
    turnNo: number;
    tactic: string | null;
    expectedBehavior: ExpectedBehavior;
    user: string;
    bareAnswer: string;
    score: ScoredTurn;
    rationale: string;
  }>;
}

export interface RunProbeCalibrationSummary {
  runId: number;
  calibrationRunIds?: number[];
  bareModelId: string;
  graderModelId: string;
  sameModelNotice: boolean;
  totalProbes: number;
  calibratedProbes: number;
  errors: number;
  difficultyCounts: Record<DifficultyLevel, number>;
  easyRatio: number;
  meanScore: number;
  bareBehaviorPassRate: number;
  byType: Record<string, {
    total: number;
    easy: number;
    medium: number;
    hard: number;
    meanScore: number;
    behaviorPassRate: number;
  }>;
  byBehavior: Record<string, {
    turns: number;
    behaviorPassRate: number;
    meanScore: number;
  }>;
  totalAgentCalls: number;
  items: CalibratedProbeReportItem[];
}

/**
 * Calibrates accepted probes by running a transcript-free bare generic model on each probe
 * (never receiving `material`, `anchor`, `trap`, or author style rules), then grading each
 * turn against `rubric_v2` + `referenceAnswer` to assign `easy` / `medium` / `hard`.
 */
export async function runProbeCalibration(options: RunProbeCalibrationOptions): Promise<RunProbeCalibrationSummary> {
  const { evalStore, probes, runBareModel, bareModelId, runGrader, graderModelId } = options;
  if (probes.length === 0) {
    throw new Error("没有可供难度标定的已通过考题（accepted probes）");
  }

  const concurrency = validateConcurrency(options.concurrency ?? 1);
  const callMaxAttempts = validateCallMaxAttempts(options.callMaxAttempts ?? DEFAULT_CALL_MAX_ATTEMPTS);
  const callRetryDelayMs = validateCallRetryDelayMs(options.callRetryDelayMs ?? DEFAULT_CALL_RETRY_DELAY_MS);
  const barePrompt = nonEmpty(options.prompts.bareAnswer, "bare-answer 系统提示词");
  const graderPrompt = nonEmpty(options.prompts.evalGrader, "eval-grader 系统提示词");

  evalStore.markInterruptedRuns();

  const runId = evalStore.createRun({
    kind: "calibrate",
    config: {
      bareModelId,
      graderModelId,
      probeCount: probes.length,
      probeIds: probes.map((p) => p.id),
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
    },
    prompts: {
      bare_answer: barePrompt,
      eval_grader: graderPrompt,
    },
    skills: options.skills,
  });

  const runRef = `probe_run:${runId}`;
  const calibratedItems: CalibratedProbeReportItem[] = [];
  let errors = 0;

  async function invokeTracked<T>(params: {
    role: "bare_answer" | "eval_grader";
    runner: RoleRunner;
    model: string;
    systemPrompt: string;
    inputRefs: Record<string, unknown>;
    wireInput: Record<string, unknown>;
    parse: (raw: string) => T;
    tag: string;
  }): Promise<{ callId: number; output: string; parsed: T }> {
    const callId = evalStore.startCall({
      runRef,
      role: params.role,
      model: params.model,
      inputRefs: params.inputRefs,
    });
    let lastRawOutput: string | undefined;
    try {
      const result = await runWithRetry({
        maxAttempts: callMaxAttempts,
        delayMs: callRetryDelayMs,
        run: async () => {
          lastRawOutput = undefined;
          const output = await params.runner({
            role: params.role,
            systemPrompt: params.systemPrompt,
            input: params.wireInput,
          });
          lastRawOutput = output;
          try {
            return { output, parsed: params.parse(output) };
          } catch (error) {
            throw toPublicError(error, "model_output_invalid");
          }
        },
        onRetry: (attempt, max, error) => {
          options.onProgress?.(`${params.tag} ${params.role} 失败（第 ${attempt}/${max} 次），重试：${publicErrorMessage(error)}`);
        },
      });
      evalStore.finishCall(callId, { output: result.output });
      return { callId, output: result.output, parsed: result.parsed };
    } catch (error) {
      const msg = publicErrorMessage(error);
      evalStore.finishCall(callId, { output: lastRawOutput, error: msg });
      throw toPublicError(error);
    }
  }

  try {
    await runConcurrentPool(probes, concurrency, async (probe, idx) => {
      const source = evalStore.getSourceMaterial(probe.sourceMaterialId);
      const videoId = source?.videoId ?? String(probe.sourceMaterialId);
      const tag = `[cal ${idx + 1}/${probes.length}:p${probe.id}:${probe.probeType}]`;

      try {
        const dialogue = evalStore.getProbeDialogue(probe.id);
        if (dialogue.length === 0) {
          throw new Error(`Probe ${probe.id} 没有已通过的对话轮次`);
        }

        const turnScores: ScoredTurn[] = [];
        const reportTurns: CalibratedProbeReportItem["turns"] = [];
        const goldHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

        for (const turn of dialogue) {
          if (!turn.rubric || typeof turn.rubric !== "object") {
            throw new Error(`Probe ${probe.id} Turn ${turn.turnNo} 缺少评分卡 v2`);
          }
          const rubric = turn.rubric as ProbeRubricV2;

          // Step 1: Bare generic model answers COLD (strictly NO material / anchor / trap / expectedBehavior)
          const bareInput: Record<string, unknown> = {
            ...(goldHistory.length > 0 ? { history: [...goldHistory] } : {}),
            question: turn.user,
          };
          const bareCall = await invokeTracked({
            role: "bare_answer",
            runner: runBareModel,
            model: bareModelId,
            systemPrompt: barePrompt,
            inputRefs: {
              probe_id: probe.id,
              turn_no: turn.turnNo,
              history_turns: goldHistory.length / 2,
            },
            wireInput: bareInput,
            parse: (raw) => nonEmpty(raw, "裸答正文"),
            tag: `${tag}[t${turn.turnNo}:bare]`,
          });

          // Step 2: Grader grades bareAnswer against rubric_v2 + referenceAnswer (NO material)
          const gradeInput: Record<string, unknown> = {
            ...(goldHistory.length > 0 ? { history: [...goldHistory] } : {}),
            question: turn.user,
            probeType: probe.probeType,
            expectedBehavior: turn.expectedBehavior,
            ...(turn.tactic ? { tactic: turn.tactic } : {}),
            rubric,
            referenceAnswer: turn.answer,
            candidateAnswer: bareCall.parsed,
          };
          const gradeCall = await invokeTracked({
            role: "eval_grader",
            runner: runGrader,
            model: graderModelId,
            systemPrompt: graderPrompt,
            inputRefs: {
              probe_id: probe.id,
              turn_no: turn.turnNo,
              bare_call_id: bareCall.callId,
            },
            wireInput: gradeInput,
            parse: (raw) => parseGradeResult(raw, rubric),
            tag: `${tag}[t${turn.turnNo}:grade]`,
          });

          const scored = scoreGradedTurn(gradeCall.parsed, rubric);
          turnScores.push(scored);

          evalStore.saveCalibration({
            runId,
            probeId: probe.id,
            turnNo: turn.turnNo,
            bareModel: bareModelId,
            graderModel: graderModelId,
            bareAnswer: bareCall.parsed,
            behaviorOk: scored.behaviorOk,
            stance: scored.stance,
            keyPointCoverage: scored.keyPointCoverage,
            forbiddenHits: scored.forbiddenHits,
            hallucinationHits: scored.hallucinationHits,
            failureSignalHits: scored.failureSignalHits,
            style: scored.style,
            score: scored.finalScore,
            detail: {
              judgement: gradeCall.parsed,
              scored,
            },
            bareCallId: bareCall.callId,
            gradeCallId: gradeCall.callId,
          });

          reportTurns.push({
            turnNo: turn.turnNo,
            tactic: turn.tactic,
            expectedBehavior: turn.expectedBehavior,
            user: turn.user,
            bareAnswer: bareCall.parsed,
            score: scored,
            rationale: gradeCall.parsed.rationale,
          });

          // Advance gold history for multi-turn pressure probes
          goldHistory.push({ role: "user", content: turn.user });
          goldHistory.push({ role: "assistant", content: turn.answer });
        }

        const classified = classifyProbeDifficulty(turnScores);
        evalStore.setProbeDifficulty(probe.id, classified.difficulty);

        calibratedItems.push({
          probeId: probe.id,
          videoId,
          probeType: probe.probeType,
          expectedBehavior: probe.expectedBehavior,
          targetTurns: dialogue.length,
          difficulty: classified.difficulty,
          aggregateScore: classified.aggregateScore,
          allBehaviorOk: classified.allBehaviorOk,
          question: probe.question,
          turns: reportTurns,
        });

        options.onProgress?.(
          `${tag} -> ${classified.difficulty} (score=${classified.aggregateScore}, behaviorOk=${classified.allBehaviorOk})`,
        );
      } catch (error) {
        errors++;
        options.onProgress?.(`${tag} calibration error: ${publicErrorMessage(error)}`);
      }
    });

    evalStore.finishRun(runId, "completed");
  } catch (error) {
    evalStore.finishRun(runId, "failed", publicErrorMessage(error));
    throw toPublicError(error);
  }

  const totalCallsRow = evalStore.db.prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ?").get(runRef) as { c: number };
  return aggregateCalibrationSummary({
    runId,
    bareModelId,
    graderModelId,
    totalProbes: probes.length,
    errors,
    totalAgentCalls: Number(totalCallsRow.c),
    items: calibratedItems,
  });
}

function aggregateCalibrationSummary(params: {
  runId: number;
  calibrationRunIds?: number[];
  bareModelId: string;
  graderModelId: string;
  totalProbes: number;
  errors: number;
  totalAgentCalls: number;
  items: CalibratedProbeReportItem[];
}): RunProbeCalibrationSummary {
  const calibratedItems = [...params.items].sort((a, b) => a.probeId - b.probeId);

  const difficultyCounts: Record<DifficultyLevel, number> = { easy: 0, medium: 0, hard: 0 };
  const byTypeAcc: Record<string, { total: number; easy: number; medium: number; hard: number; scoreSum: number; behaviorPass: number }> = {};
  const byBehaviorAcc: Record<string, { turns: number; scoreSum: number; behaviorPass: number }> = {};

  let totalScoreSum = 0;
  let totalBehaviorPass = 0;

  for (const item of calibratedItems) {
    difficultyCounts[item.difficulty]++;
    totalScoreSum += item.aggregateScore;
    if (item.allBehaviorOk) totalBehaviorPass++;

    const t = byTypeAcc[item.probeType] ?? { total: 0, easy: 0, medium: 0, hard: 0, scoreSum: 0, behaviorPass: 0 };
    t.total++;
    t[item.difficulty]++;
    t.scoreSum += item.aggregateScore;
    if (item.allBehaviorOk) t.behaviorPass++;
    byTypeAcc[item.probeType] = t;

    for (const turn of item.turns) {
      const b = byBehaviorAcc[turn.expectedBehavior] ?? { turns: 0, scoreSum: 0, behaviorPass: 0 };
      b.turns++;
      b.scoreSum += turn.score.finalScore;
      if (turn.score.behaviorOk) b.behaviorPass++;
      byBehaviorAcc[turn.expectedBehavior] = b;
    }
  }

  const byType: RunProbeCalibrationSummary["byType"] = {};
  for (const [k, v] of Object.entries(byTypeAcc).sort((a, b) => a[0].localeCompare(b[0]))) {
    byType[k] = {
      total: v.total,
      easy: v.easy,
      medium: v.medium,
      hard: v.hard,
      meanScore: Number((v.scoreSum / v.total).toFixed(2)),
      behaviorPassRate: Number((v.behaviorPass / v.total).toFixed(4)),
    };
  }

  const byBehavior: RunProbeCalibrationSummary["byBehavior"] = {};
  for (const [k, v] of Object.entries(byBehaviorAcc).sort((a, b) => a[0].localeCompare(b[0]))) {
    byBehavior[k] = {
      turns: v.turns,
      behaviorPassRate: Number((v.behaviorPass / v.turns).toFixed(4)),
      meanScore: Number((v.scoreSum / v.turns).toFixed(2)),
    };
  }

  const n = calibratedItems.length;
  return {
    runId: params.runId,
    ...(params.calibrationRunIds ? { calibrationRunIds: params.calibrationRunIds } : {}),
    bareModelId: params.bareModelId,
    graderModelId: params.graderModelId,
    sameModelNotice: params.bareModelId === params.graderModelId,
    totalProbes: params.totalProbes,
    calibratedProbes: n,
    errors: params.errors,
    difficultyCounts,
    easyRatio: n > 0 ? Number((difficultyCounts.easy / n).toFixed(4)) : 0,
    meanScore: n > 0 ? Number((totalScoreSum / n).toFixed(2)) : 0,
    bareBehaviorPassRate: n > 0 ? Number((totalBehaviorPass / n).toFixed(4)) : 0,
    byType,
    byBehavior,
    totalAgentCalls: params.totalAgentCalls,
    items: calibratedItems,
  };
}

function reconstructScoredTurn(cal: CalibrationTurnRecord): ScoredTurn {
  const detailScored = cal.detail?.scored as Partial<ScoredTurn> | undefined;
  const stance = (cal.stance === 0 || cal.stance === 1 || cal.stance === 2 ? cal.stance : 0) as 0 | 1 | 2;
  const style = (cal.style === 0 || cal.style === 1 || cal.style === 2 ? cal.style : 0) as 0 | 1 | 2;
  const finalScore = typeof detailScored?.finalScore === "number" ? detailScored.finalScore : cal.score;
  const hallucinated = typeof detailScored?.hallucinated === "boolean"
    ? detailScored.hallucinated
    : cal.hallucinationHits > 0;
  const verdict = detailScored?.verdict === "pass" || detailScored?.verdict === "partial" || detailScored?.verdict === "fail"
    ? detailScored.verdict
    : !cal.behaviorOk || hallucinated || finalScore < 50
      ? "fail"
      : finalScore >= 80
        ? "pass"
        : "partial";
  return {
    verdict,
    behaviorOk: cal.behaviorOk,
    hallucinated,
    stance,
    keyPointCoverage: cal.keyPointCoverage,
    forbiddenHits: cal.forbiddenHits,
    hallucinationHits: cal.hallucinationHits,
    failureSignalHits: cal.failureSignalHits,
    style,
    contentScore: typeof detailScored?.contentScore === "number" ? detailScored.contentScore : cal.score,
    penalty: typeof detailScored?.penalty === "number" ? detailScored.penalty : 0,
    rawScore: typeof detailScored?.rawScore === "number" ? detailScored.rawScore : cal.score,
    cappedByBehavior: typeof detailScored?.cappedByBehavior === "boolean" ? detailScored.cappedByBehavior : false,
    finalScore,
    substantiveScore:
      typeof detailScored?.substantiveScore === "number" ? detailScored.substantiveScore : cal.score,
  };
}

function extractCalibrationRationale(cal: CalibrationTurnRecord): string {
  const judgement = cal.detail?.judgement as { rationale?: unknown } | undefined;
  return typeof judgement?.rationale === "string" ? judgement.rationale : "";
}

/**
 * Assembles a full calibration summary directly from persisted `probe_calibrations` records
 * across one or multiple resumed calibration runs (offline, read-only friendly).
 */
export function summarizeCalibrationFromStore(options: {
  evalStore: EvalStore;
  probes: ProbeRecord[];
  calibrationRunId?: number;
}): RunProbeCalibrationSummary {
  const { evalStore, probes, calibrationRunId } = options;
  const items: CalibratedProbeReportItem[] = [];
  const calRunIdSet = new Set<number>();
  const bareModels = new Set<string>();
  const graderModels = new Set<string>();

  for (const probe of probes) {
    if (probe.difficulty === null) continue;
    const dialogue = evalStore.getProbeDialogue(probe.id);
    if (dialogue.length === 0) continue;

    const calRows = evalStore.listCompleteCalibrationsForProbe(probe.id, dialogue.length, calibrationRunId);
    const byTurnNo = new Map<number, CalibrationTurnRecord>();
    for (const row of calRows) {
      byTurnNo.set(row.turnNo, row);
    }
    if (dialogue.some((t) => !byTurnNo.has(t.turnNo))) {
      continue;
    }

    const source = evalStore.getSourceMaterial(probe.sourceMaterialId);
    const videoId = source?.videoId ?? String(probe.sourceMaterialId);

    const turnScores: ScoredTurn[] = [];
    const reportTurns: CalibratedProbeReportItem["turns"] = [];
    for (const turn of dialogue) {
      const cal = byTurnNo.get(turn.turnNo)!;
      calRunIdSet.add(cal.runId);
      bareModels.add(cal.bareModel);
      graderModels.add(cal.graderModel);
      const scored = reconstructScoredTurn(cal);
      turnScores.push(scored);
      reportTurns.push({
        turnNo: turn.turnNo,
        tactic: turn.tactic,
        expectedBehavior: turn.expectedBehavior,
        user: turn.user,
        bareAnswer: cal.bareAnswer ?? "",
        score: scored,
        rationale: extractCalibrationRationale(cal),
      });
    }

    const classified = classifyProbeDifficulty(turnScores);
    items.push({
      probeId: probe.id,
      videoId,
      probeType: probe.probeType,
      expectedBehavior: probe.expectedBehavior,
      targetTurns: dialogue.length,
      difficulty: probe.difficulty,
      aggregateScore: classified.aggregateScore,
      allBehaviorOk: classified.allBehaviorOk,
      question: probe.question,
      turns: reportTurns,
    });
  }

  const calibrationRunIds = [...calRunIdSet].sort((a, b) => a - b);
  let totalAgentCalls = 0;
  for (const rId of calibrationRunIds) {
    const row = evalStore.db.prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ?").get(`probe_run:${rId}`) as { c: number };
    totalAgentCalls += Number(row.c);
  }

  const bareModelId = bareModels.size > 0 ? [...bareModels].sort().join(", ") : "unknown";
  const graderModelId = graderModels.size > 0 ? [...graderModels].sort().join(", ") : "unknown";

  return aggregateCalibrationSummary({
    runId: calibrationRunIds.length > 0 ? calibrationRunIds[calibrationRunIds.length - 1] : 0,
    calibrationRunIds,
    bareModelId,
    graderModelId,
    totalProbes: probes.length,
    errors: Math.max(0, probes.length - items.length),
    totalAgentCalls,
    items,
  });
}

function selectStratifiedSample(items: readonly CalibratedProbeReportItem[], limit: number): CalibratedProbeReportItem[] {
  if (items.length <= limit) return [...items];
  const byType = new Map<string, CalibratedProbeReportItem[]>();
  for (const item of items) {
    const bucket = byType.get(item.probeType);
    if (bucket) bucket.push(item);
    else byType.set(item.probeType, [item]);
  }
  const buckets = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, list]) => list);
  const selected: CalibratedProbeReportItem[] = [];
  let round = 0;
  while (selected.length < limit) {
    let added = false;
    for (const bucket of buckets) {
      if (round < bucket.length && selected.length < limit) {
        selected.push(bucket[round]);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return selected;
}

export function renderCalibrationReportMarkdown(summary: RunProbeCalibrationSummary): string {
  const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
  const lines: string[] = [];
  const runIdLabel = summary.calibrationRunIds && summary.calibrationRunIds.length > 1
    ? summary.calibrationRunIds.join(", ")
    : String(summary.runId);
  lines.push("# 对抗考题难度标定报告（Difficulty Calibration）");
  lines.push("");
  lines.push(`- **Calibration Run ID**: \`${runIdLabel}\``);
  lines.push(`- **裸答模型（无原稿）**: \`${summary.bareModelId}\`　｜　**批卷模型**: \`${summary.graderModelId}\``);
  lines.push(`- **标定完成**: ${summary.calibratedProbes} / ${summary.totalProbes} 题（未完成/错误：${summary.errors}，调用：${summary.totalAgentCalls} 次）`);
  lines.push(`- **通用模型裸答表现**: 均分 **${summary.meanScore}** / 100　｜　行为闸门全通过率 **${pct(summary.bareBehaviorPassRate)}**`);
  lines.push("");
  lines.push("## 1. 总体难度分层");
  lines.push("");
  lines.push("| 难度 | 题数 | 占比 | 含义 |");
  lines.push("| --- | ---: | ---: | --- |");
  const total = Math.max(1, summary.calibratedProbes);
  lines.push(`| \`hard\` | ${summary.difficultyCounts.hard} | ${pct(summary.difficultyCounts.hard / total)} | 通用模型踩坑或未通过行为闸门（得分 < 50） |`);
  lines.push(`| \`medium\` | ${summary.difficultyCounts.medium} | ${pct(summary.difficultyCounts.medium / total)} | 通用模型通过行为闸门但要点/风格不全（50–79） |`);
  lines.push(`| \`easy\` | ${summary.difficultyCounts.easy} | ${pct(summary.difficultyCounts.easy / total)} | 通用模型不看原稿已高分过关（≥ 80，冻结时按 \`--max-easy-ratio\` 限流） |`);
  lines.push("");
  lines.push("## 2. 按题型分层");
  lines.push("");
  lines.push("| 题型 `probe_type` | 题数 | `hard` | `medium` | `easy` | 裸答均分 | 行为闸门通过率 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [type, stats] of Object.entries(summary.byType)) {
    lines.push(`| \`${type}\` | ${stats.total} | ${stats.hard} | ${stats.medium} | ${stats.easy} | ${stats.meanScore} | ${pct(stats.behaviorPassRate)} |`);
  }
  lines.push("");
  lines.push("## 3. 按预期行为分层（轮次级）");
  lines.push("");
  lines.push("| 预期行为 `expectedBehavior` | 轮次数 | 裸答行为闸门通过率 | 裸答均分 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [beh, stats] of Object.entries(summary.byBehavior)) {
    lines.push(`| \`${beh}\` | ${stats.turns} | ${pct(stats.behaviorPassRate)} | ${stats.meanScore} |`);
  }
  lines.push("");

  const easyItems = summary.items.filter((i) => i.difficulty === "easy");
  lines.push(`## 4. 全部 \`easy\` 题目清单（共 ${easyItems.length} 道，供冻结前复核）`);
  lines.push("");
  if (easyItems.length === 0) {
    lines.push("（无 `easy` 题目，全部题目均对通用裸答模型具备区分度。）");
  } else {
    for (const item of easyItems) {
      lines.push(`- **Probe ${item.probeId}**（\`${item.probeType}\` / \`${item.videoId}\` / 裸答 ${item.aggregateScore} 分）：${item.question}`);
      const firstReason = item.turns[0]?.rationale ?? "";
      if (firstReason) lines.push(`  - 批卷说明：${firstReason}`);
    }
  }
  lines.push("");

  const mediumItems = summary.items.filter((i) => i.difficulty === "medium");
  const mediumShown = mediumItems.slice(0, 15);
  lines.push(`## 5. \`medium\` 题目清单（共 ${mediumItems.length} 道${mediumShown.length < mediumItems.length ? `，展示前 ${mediumShown.length} 道` : ""}）`);
  lines.push("");
  if (mediumShown.length === 0) {
    lines.push("（无 `medium` 题目。）");
  } else {
    for (const item of mediumShown) {
      lines.push(`- **Probe ${item.probeId}**（\`${item.probeType}\` / \`${item.videoId}\` / 裸答 ${item.aggregateScore} 分 / ${item.targetTurns} 轮）：${item.question}`);
      const firstReason = item.turns[0]?.rationale ?? "";
      if (firstReason) lines.push(`  - 批卷说明：${firstReason}`);
    }
  }
  lines.push("");

  const hardSample = selectStratifiedSample(
    summary.items.filter((i) => i.difficulty === "hard"),
    12,
  );
  lines.push(`## 6. 典型 \`hard\` 题目示例（按题型分层抽样展示 ${hardSample.length} 道）`);
  lines.push("");
  for (const item of hardSample) {
    lines.push(`### Probe ${item.probeId}（\`${item.probeType}\` / \`${item.videoId}\` / 裸答 ${item.aggregateScore} 分 / ${item.targetTurns} 轮）`);
    for (const t of item.turns) {
      const tacticLabel = t.tactic ? ` / tactic=\`${t.tactic}\`` : "";
      lines.push(`- **Turn ${t.turnNo}**（\`${t.expectedBehavior}\`${tacticLabel}，得分 ${t.score.finalScore}，behaviorOk=\`${t.score.behaviorOk}\`）：${t.user}`);
      lines.push(`  - 批卷理由：${t.rationale}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
