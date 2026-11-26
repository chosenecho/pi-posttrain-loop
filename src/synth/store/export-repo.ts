import type { DatabaseSync } from "node:sqlite";
import { nonEmpty, validateMaxTurns, validateSplit } from "../../shared/schema.js";
import {
  attachNegativeToolDeclaration,
  buildToolDefinition,
  buildToolStepMessages,
  pickWebSearchToolVariant,
} from "../../shared/tool-schema.js";
import type { DatasetSplit, ToolStep, TrainingMessage, TrainingSampleLine } from "../../shared/types.js";
import { createSeededRng, nowIso, sha256Hex, shuffleInPlace } from "../../shared/utils.js";
import type { CorpusRepository } from "./corpus-repo.js";
import type { RunRepository } from "./run-repo.js";
import {
  formatSamplesJsonl,
  type DedupPolicy,
  type ExportOptions,
  type MergedExportOptions,
  type MergedExportRecord,
  type MergedExportResult,
  type ResultTurnRow,
} from "./schema-sql.js";

export class ExportRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hasTable: (name: string) => boolean,
    private readonly corpus: CorpusRepository,
    private readonly runs: RunRepository,
  ) {}

  private buildSampleLine(
    turns: ResultTurnRow[],
    toolStepsByAttempt: Map<number, ToolStep[]>,
    options: {
      systemPrompt?: string;
      generalizeTools: boolean;
      toolRng: () => number;
    },
  ): TrainingSampleLine {
    const hasAnyTools = turns.some((t) => (toolStepsByAttempt.get(Number(t.attempt_id))?.length ?? 0) > 0);
    const variant = hasAnyTools ? pickWebSearchToolVariant(options.toolRng, options.generalizeTools) : undefined;
    const messages: TrainingMessage[] = [];
    if (options.systemPrompt !== undefined) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    for (const turn of turns) {
      messages.push({ role: "user", content: turn.user_content });
      const steps = toolStepsByAttempt.get(Number(turn.attempt_id));
      if (steps && steps.length > 0 && variant) {
        messages.push(...buildToolStepMessages(steps, variant, {
          format: "plain",
          callIdPrefix: `t${turn.turn_no}`,
        }));
      }
      messages.push({ role: "assistant", content: turn.assistant_content });
    }
    return variant
      ? { tools: [buildToolDefinition(variant)], messages }
      : { messages };
  }

  exportRunSamples(runId: number, options: ExportOptions = {}): TrainingSampleLine[] {
    const rows = this.runs.queryResultTurns(runId);
    const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;
    const generalizeTools = options.generalizeTools ?? true;
    const toolRng = createSeededRng(options.seed ?? 42);
    const toolStepsByAttempt = this.runs.queryAttemptToolStepsMap(rows.map((r) => Number(r.attempt_id)));
    const grouped = new Map<number, ResultTurnRow[]>();
    for (const row of rows) {
      const list = grouped.get(row.result_id);
      if (list) list.push(row);
      else grouped.set(row.result_id, [row]);
    }
    const samples: TrainingSampleLine[] = [];
    for (const turns of grouped.values()) {
      samples.push(this.buildSampleLine(turns, toolStepsByAttempt, { systemPrompt, generalizeTools, toolRng }));
    }
    return samples;
  }

  exportRunJsonl(runId: number, options: ExportOptions = {}): string {
    return formatSamplesJsonl(this.exportRunSamples(runId, options));
  }

  exportMergedDataset(options: MergedExportOptions): MergedExportResult {
    const hasRunIds = options.runIds !== undefined && options.runIds.length > 0;
    const allFormal = Boolean(options.allFormal);
    if (hasRunIds && allFormal) {
      throw new Error("runIds 与 allFormal 不能同时指定");
    }
    if (!hasRunIds && !allFormal) {
      throw new Error("必须指定 runIds 或 allFormal");
    }
    const targetSplit = options.split !== undefined ? validateSplit(options.split) : undefined;
    const dedup: DedupPolicy = options.dedup ?? "latest";
    if (dedup !== "latest" && dedup !== "earliest" && dedup !== "error") {
      throw new Error("dedup 必须为 latest、earliest 或 error");
    }
    if (options.minTurns !== undefined) validateMaxTurns(options.minTurns);
    if (options.maxTurns !== undefined) validateMaxTurns(options.maxTurns);
    if (options.minTurns !== undefined && options.maxTurns !== undefined && options.minTurns > options.maxTurns) {
      throw new Error("minTurns 不能大于 maxTurns");
    }
    if (options.valRatio !== undefined && (!Number.isFinite(options.valRatio) || options.valRatio <= 0 || options.valRatio >= 1)) {
      throw new Error("valRatio 必须是 (0, 1) 之间的小数");
    }

    const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;
    const excludeSet = new Set(options.excludeRunIds ?? []);
    const materialInfo = this.corpus.getMaterialVideoAndSplitMap();

    let candidateRunIds: number[];
    if (allFormal) {
      const effectiveSplit = targetSplit ?? "train";
      const runRows = effectiveSplit === "train"
        ? (this.db.prepare(`
            SELECT id FROM runs
            WHERE kind = 'answer_judge'
              AND json_extract(export_policy_json, '$.training_enabled') = 1
              AND COALESCE(json_extract(export_policy_json, '$.split'), 'train') = 'train'
            ORDER BY id
          `).all() as Array<{ id: number }>)
        : (this.db.prepare(`
            SELECT id FROM runs
            WHERE kind = 'answer_judge'
              AND (
                json_extract(export_policy_json, '$.eval_enabled') = 1
                OR json_extract(export_policy_json, '$.training_enabled') = 1
                OR json_extract(export_policy_json, '$.split') = ?
              )
            ORDER BY id
          `).all(effectiveSplit) as Array<{ id: number }>);
      candidateRunIds = runRows.map((r) => Number(r.id)).filter((id) => !excludeSet.has(id));
    } else {
      const requested = [...new Set(options.runIds!)];
      for (const id of requested) {
        if (!Number.isSafeInteger(id) || id < 1) throw new Error(`无效的 run_id：${id}`);
        const exists = this.db.prepare("SELECT id, kind FROM runs WHERE id = ?").get(id) as { id: number; kind: string } | undefined;
        if (!exists) throw new Error(`未找到 run_id=${id}`);
        if (exists.kind !== "answer_judge") throw new Error(`run_id=${id} 不是 answer_judge 运行（kind=${exists.kind}）`);
      }
      candidateRunIds = requested.filter((id) => !excludeSet.has(id));
    }

    if (candidateRunIds.length === 0) {
      return {
        train: [],
        val: [],
        includedRunIds: [],
        countsByRunId: {},
        turnCountDistribution: {},
        duplicateQuestionsResolved: 0,
        materialCount: 0,
        trainMaterialCount: 0,
        valMaterialCount: 0,
      };
    }

    const placeholders = candidateRunIds.map(() => "?").join(", ");
    const params: number[] = [...candidateRunIds];
    let sql = `
      SELECT r.id AS result_id,
             i.run_id,
             q.id AS question_id,
             q.material_id,
             r.turn_count,
             t.turn_no,
             a.id AS attempt_id,
             COALESCE(t.user_content, q.question) AS user_content,
             a.answer AS assistant_content,
             a.attempt_no
      FROM results r
      JOIN run_items i ON i.id = r.run_item_id
      JOIN questions q ON q.id = i.question_id
      JOIN turns t ON t.run_item_id = i.id
      JOIN attempts a ON a.id = t.passed_attempt_id
      WHERE i.run_id IN (${placeholders})
    `;
    if (options.minTurns !== undefined) {
      sql += " AND r.turn_count >= ?";
      params.push(options.minTurns);
    }
    if (options.maxTurns !== undefined) {
      sql += " AND r.turn_count <= ?";
      params.push(options.maxTurns);
    }
    sql += " ORDER BY i.run_id, q.id, t.turn_no";

    const rows = this.db.prepare(sql).all(...params) as unknown as ResultTurnRow[];
    const toolStepsByAttempt = this.runs.queryAttemptToolStepsMap(rows.map((r) => Number(r.attempt_id)));
    const generalizeTools = options.generalizeTools ?? true;
    const negativeToolsRatio = options.negativeToolsRatio ?? 0;
    if (!Number.isFinite(negativeToolsRatio) || negativeToolsRatio < 0 || negativeToolsRatio > 1) {
      throw new Error("negativeToolsRatio 必须是 [0, 1] 之间的小数");
    }
    const toolRng = createSeededRng((options.seed ?? 42) + 1009);

    const effectiveSplitFilter: DatasetSplit | undefined = targetSplit ?? (allFormal ? "train" : undefined);

    const groupedByResult = new Map<number, ResultTurnRow[]>();
    for (const row of rows) {
      if (effectiveSplitFilter !== undefined) {
        const matSplit = materialInfo.get(Number(row.material_id))?.split ?? "train";
        if (matSplit !== effectiveSplitFilter) continue;
      }
      const list = groupedByResult.get(row.result_id);
      if (list) list.push(row);
      else groupedByResult.set(row.result_id, [row]);
    }

    const byQuestion = new Map<number, MergedExportRecord[]>();
    for (const turns of groupedByResult.values()) {
      const first = turns[0];
      let sample = this.buildSampleLine(turns, toolStepsByAttempt, {
        systemPrompt,
        generalizeTools,
        toolRng,
      });
      if (!sample.tools && negativeToolsRatio > 0 && toolRng() < negativeToolsRatio) {
        sample = attachNegativeToolDeclaration(sample, toolRng, generalizeTools);
      }
      const record: MergedExportRecord = {
        resultId: Number(first.result_id),
        runId: Number(first.run_id),
        questionId: Number(first.question_id),
        materialId: Number(first.material_id),
        turnCount: Number(first.turn_count),
        sample,
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
        if (dedup === "error") {
          conflicts.push(`q${questionId} (runs: ${list.map((r) => r.runId).join(",")})`);
          continue;
        }
        duplicateQuestionsResolved += list.length - 1;
        selected.push(dedup === "latest" ? list[list.length - 1] : list[0]);
      } else {
        selected.push(list[0]);
      }
    }

    if (conflicts.length > 0) {
      throw new Error(`发现同题多版本冲突（--dedup error）：${conflicts.join("; ")}`);
    }

    const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
    const allMaterials = [...new Set(selected.map((r) => r.materialId))].sort((a, b) => a - b);
    const videoKeyOfMaterial = (matId: number): string => materialInfo.get(matId)?.videoKey ?? String(matId);
    const allVideoKeys = [...new Set(allMaterials.map(videoKeyOfMaterial))].sort();

    let train: MergedExportRecord[];
    let val: MergedExportRecord[];

    if (options.valRatio !== undefined) {
      if (allVideoKeys.length < 2) {
        throw new Error("按视频切分验证集至少需要 2 个不同视频（material）");
      }
      const shuffledVideoKeys = shuffleInPlace([...allVideoKeys], rng);
      const valVideoCount = Math.min(allVideoKeys.length - 1, Math.max(1, Math.round(allVideoKeys.length * options.valRatio)));
      const valVideoKeySet = new Set(shuffledVideoKeys.slice(0, valVideoCount));
      train = selected.filter((r) => !valVideoKeySet.has(videoKeyOfMaterial(r.materialId)));
      val = selected.filter((r) => valVideoKeySet.has(videoKeyOfMaterial(r.materialId)));
    } else {
      train = [...selected];
      val = [];
    }

    if (options.shuffle) {
      shuffleInPlace(train, rng);
      if (val.length > 0) shuffleInPlace(val, rng);
    }

    const countsByRunId: Record<number, number> = {};
    const turnCountDistribution: Record<number, number> = {};
    for (const rec of selected) {
      countsByRunId[rec.runId] = (countsByRunId[rec.runId] ?? 0) + 1;
      turnCountDistribution[rec.turnCount] = (turnCountDistribution[rec.turnCount] ?? 0) + 1;
    }

    return {
      train,
      val,
      includedRunIds: Object.keys(countsByRunId).map(Number).sort((a, b) => a - b),
      countsByRunId,
      turnCountDistribution,
      duplicateQuestionsResolved,
      materialCount: allMaterials.length,
      trainMaterialCount: new Set(train.map((r) => r.materialId)).size,
      valMaterialCount: new Set(val.map((r) => r.materialId)).size,
    };
  }
}
