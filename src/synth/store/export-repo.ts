import type { DatabaseSync } from "node:sqlite";
import { createMergedExportPolicy, projectRunSamples, type ExportRunCandidate } from "../export-policy.js";
import type { CorpusRepository } from "./corpus-repo.js";
import type { RunRepository } from "./run-repo.js";
import { formatSamplesJsonl, type ExportOptions, type MergedExportOptions, type MergedExportResult, type ResultTurnRow } from "./schema-sql.js";

/** Database candidate loading only; training decisions and projections live in export-policy. */
export class ExportRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hasTable: (name: string) => boolean,
    private readonly corpus: CorpusRepository,
    private readonly runs: RunRepository,
  ) {}

  exportRunSamples(runId: number, options: ExportOptions = {}) {
    const rows = this.runs.queryResultTurns(runId);
    const toolStepsByAttempt = this.runs.queryAttemptToolStepsMap(rows.map((row) => Number(row.attempt_id)));
    return projectRunSamples(rows, toolStepsByAttempt, options);
  }

  exportRunJsonl(runId: number, options: ExportOptions = {}): string {
    return formatSamplesJsonl(this.exportRunSamples(runId, options));
  }

  private queryCandidateRuns(options: MergedExportOptions): ExportRunCandidate[] {
    type RunRow = { id: number; kind: string; export_policy_json: string };
    const rows = options.allFormal
      ? this.db.prepare("SELECT id, kind, export_policy_json FROM runs WHERE kind = 'answer_judge' ORDER BY id").all() as RunRow[]
      : [...new Set(options.runIds ?? [])].flatMap((id) => {
          if (!Number.isSafeInteger(id) || id < 1) throw new Error(`无效的 run_id：${id}`);
          const row = this.db.prepare("SELECT id, kind, export_policy_json FROM runs WHERE id = ?").get(id) as RunRow | undefined;
          return row ? [row] : [];
        });
    return rows.map((row) => ({ id: Number(row.id), kind: row.kind, exportPolicy: JSON.parse(row.export_policy_json) as Record<string, unknown> }));
  }

  private queryCandidateTurns(runIds: number[], options: MergedExportOptions): ResultTurnRow[] {
    const placeholders = runIds.map(() => "?").join(", ");
    const params: number[] = [...runIds];
    let sql = `
      SELECT r.id AS result_id,
             i.run_id,
             json_extract(ru.config_json, '$.profile') AS run_profile,
             q.id AS question_id,
             q.question_mode,
             q.material_id,
             r.turn_count,
             t.turn_no,
             a.id AS attempt_id,
             COALESCE(t.user_content, q.question) AS user_content,
             a.answer AS assistant_content,
             a.attempt_no
      FROM results r
      JOIN run_items i ON i.id = r.run_item_id
      JOIN runs ru ON ru.id = i.run_id
      JOIN questions q ON q.id = i.question_id
      JOIN turns t ON t.run_item_id = i.id
      JOIN attempts a ON a.id = t.passed_attempt_id
      WHERE i.run_id IN (${placeholders})
    `;
    if (options.minTurns !== undefined) { sql += " AND r.turn_count >= ?"; params.push(options.minTurns); }
    if (options.maxTurns !== undefined) { sql += " AND r.turn_count <= ?"; params.push(options.maxTurns); }
    sql += " ORDER BY i.run_id, q.id, t.turn_no";
    return this.db.prepare(sql).all(...params) as unknown as ResultTurnRow[];
  }

  exportMergedDataset(options: MergedExportOptions): MergedExportResult {
    const policy = createMergedExportPolicy(options);
    const candidateRunIds = policy.selectRunIds(this.queryCandidateRuns(options));
    if (candidateRunIds.length === 0) return {
      train: [], val: [], includedRunIds: [], countsByRunId: {}, turnCountDistribution: {},
      duplicateQuestionsResolved: 0, materialCount: 0, trainMaterialCount: 0, valMaterialCount: 0,
    };
    const rows = this.queryCandidateTurns(candidateRunIds, options);
    return policy.project({
      rows,
      toolStepsByAttempt: this.runs.queryAttemptToolStepsMap(rows.map((row) => Number(row.attempt_id))),
      materialInfo: this.corpus.getMaterialVideoAndSplitMap(),
    });
  }
}
