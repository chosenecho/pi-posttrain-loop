import { nonEmpty, validateMaxTurns, validateSplit } from "../shared/schema.js";
import { attachNegativeToolDeclaration, buildSampleToolDefinitions, buildToolStepMessages, pickWebSearchToolVariant } from "../shared/tool-schema.js";
import type { DatasetSplit, ToolStep, TrainingMessage, TrainingSampleLine } from "../shared/types.js";
import { createSeededRng, shuffleInPlace } from "../shared/utils.js";
import type { ExportOptions, MergedExportOptions, MergedExportRecord, MergedExportResult, ResultTurnRow } from "./store/schema-sql.js";

export interface ExportRunCandidate {
  id: number;
  kind: string;
  exportPolicy: Record<string, unknown>;
}

interface ExportCandidates {
  rows: readonly ResultTurnRow[];
  toolStepsByAttempt: ReadonlyMap<number, ToolStep[]>;
  materialInfo: ReadonlyMap<number, { videoKey: string; split: DatasetSplit }>;
}

function groupResults(rows: readonly ResultTurnRow[]): Map<number, ResultTurnRow[]> {
  const grouped = new Map<number, ResultTurnRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.result_id);
    if (list) list.push(row);
    else grouped.set(row.result_id, [row]);
  }
  return grouped;
}

function buildSampleLine(turns: ResultTurnRow[], toolStepsByAttempt: ReadonlyMap<number, ToolStep[]>, options: {
  systemPrompt?: string;
  generalizeTools: boolean;
  alwaysDeclareSearch?: boolean;
  toolRng: () => number;
}): TrainingSampleLine {
  const allSteps: ToolStep[] = [];
  for (const turn of turns) {
    const steps = toolStepsByAttempt.get(Number(turn.attempt_id));
    if (steps && steps.length > 0) allSteps.push(...steps);
  }
  const firstTurn = turns[0];
  const runProfile = firstTurn?.run_profile ?? undefined;
  const questionMode = firstTurn?.question_mode ?? undefined;
  const needsToolDefs = allSteps.length > 0 || Boolean(options.alwaysDeclareSearch)
    || runProfile === "search" || runProfile === "todo" || runProfile === "clarify"
    || questionMode === "todo_plan" || questionMode === "clarify_question";
  const variant = needsToolDefs ? pickWebSearchToolVariant(options.toolRng, options.generalizeTools) : undefined;
  const messages: TrainingMessage[] = [];
  if (options.systemPrompt !== undefined) messages.push({ role: "system", content: options.systemPrompt });
  for (const turn of turns) {
    messages.push({ role: "user", content: turn.user_content });
    const steps = toolStepsByAttempt.get(Number(turn.attempt_id));
    if (steps && steps.length > 0 && variant) {
      messages.push(...buildToolStepMessages(steps, variant, { format: "plain", callIdPrefix: `t${turn.turn_no}` }));
    }
    messages.push({ role: "assistant", content: turn.assistant_content });
  }
  const toolDefs = needsToolDefs ? buildSampleToolDefinitions({
    steps: allSteps, searchVariant: variant, profile: runProfile, questionMode, alwaysIncludeSearch: options.alwaysDeclareSearch,
  }) : [];
  return toolDefs.length > 0 ? { tools: toolDefs, messages } : { messages };
}

export function projectRunSamples(rows: readonly ResultTurnRow[], toolStepsByAttempt: ReadonlyMap<number, ToolStep[]>, options: ExportOptions): TrainingSampleLine[] {
  const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;
  const generalizeTools = options.generalizeTools ?? true;
  const toolRng = createSeededRng(options.seed ?? 42);
  return [...groupResults(rows).values()].map((turns) => buildSampleLine(turns, toolStepsByAttempt, { systemPrompt, generalizeTools, toolRng }));
}

/** Own selection, projection, RNG consumption, dedup and video validation splitting without a database. */
export function createMergedExportPolicy(options: MergedExportOptions): {
  selectRunIds(candidates: readonly ExportRunCandidate[]): number[];
  project(candidates: ExportCandidates): MergedExportResult;
} {
  const hasRunIds = options.runIds !== undefined && options.runIds.length > 0;
  const allFormal = Boolean(options.allFormal);
  if (hasRunIds && allFormal) throw new Error("runIds 与 allFormal 不能同时指定");
  if (!hasRunIds && !allFormal) throw new Error("必须指定 runIds 或 allFormal");
  const targetSplit = options.split !== undefined ? validateSplit(options.split) : undefined;
  const dedup = options.dedup ?? "latest";
  if (dedup !== "latest" && dedup !== "earliest" && dedup !== "error") throw new Error("dedup 必须为 latest、earliest 或 error");
  if (options.minTurns !== undefined) validateMaxTurns(options.minTurns);
  if (options.maxTurns !== undefined) validateMaxTurns(options.maxTurns);
  if (options.minTurns !== undefined && options.maxTurns !== undefined && options.minTurns > options.maxTurns) throw new Error("minTurns 不能大于 maxTurns");
  if (options.valRatio !== undefined && (!Number.isFinite(options.valRatio) || options.valRatio <= 0 || options.valRatio >= 1)) throw new Error("valRatio 必须是 (0, 1) 之间的小数");
  const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;
  const excludeSet = new Set(options.excludeRunIds ?? []);
  const enabled = (value: unknown) => value === true || value === 1;
  return {
    selectRunIds(candidates) {
      if (allFormal) {
        const effectiveSplit = targetSplit ?? "train";
        return candidates.filter((candidate) => {
          if (candidate.kind !== "answer_judge") return false;
          const policy = candidate.exportPolicy;
          return effectiveSplit === "train"
            ? enabled(policy.training_enabled) && (policy.split ?? "train") === "train"
            : enabled(policy.eval_enabled) || enabled(policy.training_enabled) || policy.split === effectiveSplit;
        }).map((candidate) => candidate.id).filter((id) => !excludeSet.has(id));
      }
      const requested = [...new Set(options.runIds!)];
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      for (const id of requested) {
        if (!Number.isSafeInteger(id) || id < 1) throw new Error(`无效的 run_id：${id}`);
        const candidate = byId.get(id);
        if (!candidate) throw new Error(`未找到 run_id=${id}`);
        if (candidate.kind !== "answer_judge") throw new Error(`run_id=${id} 不是 answer_judge 运行（kind=${candidate.kind}）`);
      }
      return requested.filter((id) => !excludeSet.has(id));
    },
    project({ rows, toolStepsByAttempt, materialInfo }) {
      const generalizeTools = options.generalizeTools ?? true;
      const negativeToolsRatio = options.negativeToolsRatio ?? 0;
      if (!Number.isFinite(negativeToolsRatio) || negativeToolsRatio < 0 || negativeToolsRatio > 1) throw new Error("negativeToolsRatio 必须是 [0, 1] 之间的小数");
      const toolRng = createSeededRng((options.seed ?? 42) + 1009);
      const effectiveSplit = targetSplit ?? (allFormal ? "train" : undefined);
      const filtered = rows.filter((row) => effectiveSplit === undefined || (materialInfo.get(Number(row.material_id))?.split ?? "train") === effectiveSplit);
      const byQuestion = new Map<number, MergedExportRecord[]>();
      // Projection precedes dedup deliberately: discarded versions still consume tool RNG values.
      for (const turns of groupResults(filtered).values()) {
        const first = turns[0]!;
        let sample = buildSampleLine(turns, toolStepsByAttempt, { systemPrompt, generalizeTools, toolRng });
        if (!sample.tools && negativeToolsRatio > 0 && toolRng() < negativeToolsRatio) sample = attachNegativeToolDeclaration(sample, toolRng, generalizeTools);
        const record: MergedExportRecord = {
          resultId: Number(first.result_id), runId: Number(first.run_id), questionId: Number(first.question_id),
          materialId: Number(first.material_id), turnCount: Number(first.turn_count), sample,
        };
        const list = byQuestion.get(record.questionId);
        if (list) list.push(record);
        else byQuestion.set(record.questionId, [record]);
      }
      const selected: MergedExportRecord[] = [];
      let duplicateQuestionsResolved = 0;
      const conflicts: string[] = [];
      for (const [questionId, list] of [...byQuestion.entries()].sort((a, b) => a[0] - b[0])) {
        list.sort((a, b) => a.runId - b.runId);
        if (list.length > 1) {
          if (dedup === "error") { conflicts.push(`q${questionId} (runs: ${list.map((r) => r.runId).join(",")})`); continue; }
          duplicateQuestionsResolved += list.length - 1;
          selected.push(dedup === "latest" ? list[list.length - 1]! : list[0]!);
        } else selected.push(list[0]!);
      }
      if (conflicts.length > 0) throw new Error(`发现同题多版本冲突（--dedup error）：${conflicts.join("; ")}`);
      const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
      const allMaterials = [...new Set(selected.map((record) => record.materialId))].sort((a, b) => a - b);
      const videoKey = (materialId: number) => materialInfo.get(materialId)?.videoKey ?? String(materialId);
      const allVideoKeys = [...new Set(allMaterials.map(videoKey))].sort();
      let train: MergedExportRecord[];
      let val: MergedExportRecord[];
      if (options.valRatio !== undefined) {
        if (allVideoKeys.length < 2) throw new Error("按视频切分验证集至少需要 2 个不同视频（material）");
        const shuffledVideoKeys = shuffleInPlace([...allVideoKeys], rng);
        const count = Math.min(allVideoKeys.length - 1, Math.max(1, Math.round(allVideoKeys.length * options.valRatio)));
        const validationVideoKeys = new Set(shuffledVideoKeys.slice(0, count));
        train = selected.filter((record) => !validationVideoKeys.has(videoKey(record.materialId)));
        val = selected.filter((record) => validationVideoKeys.has(videoKey(record.materialId)));
      } else { train = [...selected]; val = []; }
      if (options.shuffle) { shuffleInPlace(train, rng); if (val.length > 0) shuffleInPlace(val, rng); }
      const countsByRunId: Record<number, number> = {};
      const turnCountDistribution: Record<number, number> = {};
      for (const record of selected) {
        countsByRunId[record.runId] = (countsByRunId[record.runId] ?? 0) + 1;
        turnCountDistribution[record.turnCount] = (turnCountDistribution[record.turnCount] ?? 0) + 1;
      }
      return {
        train, val, includedRunIds: Object.keys(countsByRunId).map(Number).sort((a, b) => a - b), countsByRunId,
        turnCountDistribution, duplicateQuestionsResolved, materialCount: allMaterials.length,
        trainMaterialCount: new Set(train.map((record) => record.materialId)).size,
        valMaterialCount: new Set(val.map((record) => record.materialId)).size,
      };
    },
  };
}
