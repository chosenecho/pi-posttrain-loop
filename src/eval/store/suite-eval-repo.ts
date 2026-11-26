import type { DatabaseSync } from "node:sqlite";
import {
  nowIso,
  type DifficultyLevel,
  type EvalHistoryMode,
  type EvalPredictionRecord,
  type EvalRunRecord,
  type EvalRunSummaryRow,
  type EvalScoreRecord,
  type EvalSuiteKind,
  type ProbeRunStatus,
  type Row,
  type SuiteItemRecord,
  type SuiteVersionRecord,
} from "./types.js";

function mapSuite(row: Row): SuiteVersionRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    kind: row.kind as EvalSuiteKind,
    itemCount: Number(row.item_count),
    sha256: String(row.sha256),
    manifest: JSON.parse(String(row.manifest_json)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}

function mapEvalRun(row: Row): EvalRunRecord {
  return {
    id: Number(row.id),
    suiteId: Number(row.suite_id),
    suiteName: String(row.suite_name),
    suiteKind: row.suite_kind as EvalSuiteKind,
    candidate: String(row.candidate),
    model: String(row.model),
    historyMode: row.history_mode as EvalHistoryMode,
    config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
    status: row.status as ProbeRunStatus,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    error: row.error === null ? null : String(row.error),
  };
}

export class EvalSuiteRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tx: <T>(fn: () => T) => T,
    private readonly hasTable: (name: string) => boolean,
    private readonly hasColumn: (table: string, column: string) => boolean,
  ) {}

  // ---------- suites ----------

  getSuite(name: string): SuiteVersionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM suite_versions WHERE name = ?").get(name) as Row | undefined;
    return row ? mapSuite(row) : undefined;
  }

  getSuiteById(id: number): SuiteVersionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM suite_versions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapSuite(row) : undefined;
  }

  listSuites(): Array<{ name: string; kind: string; itemCount: number; sha256: string; createdAt: string }> {
    return (this.db.prepare("SELECT name, kind, item_count, sha256, created_at FROM suite_versions ORDER BY id").all() as Row[]).map((row) => ({
      name: String(row.name),
      kind: String(row.kind),
      itemCount: Number(row.item_count),
      sha256: String(row.sha256),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * Freezes a suite atomically. Idempotent when name + sha256 match; refuses to overwrite different content.
   */
  freezeSuite(input: {
    name: string;
    kind: EvalSuiteKind;
    sha256: string;
    manifest: Record<string, unknown>;
    items: Array<{
      itemKey: string;
      videoKey: string;
      probeType: string | null;
      expectedBehavior: string | null;
      difficulty?: DifficultyLevel | null;
      messages: unknown[];
      rubrics: unknown[];
    }>;
  }): { created: boolean; suite: SuiteVersionRecord } {
    if (input.items.length === 0) throw new Error(`套卷 ${input.name} 没有任何条目，无法冻结`);
    const existing = this.getSuite(input.name);
    if (existing) {
      if (existing.sha256 === input.sha256) return { created: false, suite: existing };
      throw new Error(`套卷 ${input.name} 已冻结（sha256=${existing.sha256.slice(0, 12)}），禁止覆盖为不同内容`);
    }
    this.tx(() => {
      const result = this.db.prepare(`
        INSERT INTO suite_versions (name, kind, item_count, manifest_json, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.name, input.kind, input.items.length, JSON.stringify(input.manifest), input.sha256, nowIso());
      const suiteId = Number(result.lastInsertRowid);
      const stmt = this.db.prepare(`
        INSERT INTO suite_items (suite_id, item_key, video_key, probe_type, expected_behavior, difficulty, messages_json, rubrics_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of input.items) {
        stmt.run(
          suiteId,
          item.itemKey,
          item.videoKey,
          item.probeType,
          item.expectedBehavior,
          item.difficulty ?? null,
          JSON.stringify(item.messages),
          JSON.stringify(item.rubrics),
        );
      }
    });
    const suite = this.getSuite(input.name);
    if (!suite) throw new Error(`无法读取冻结套卷：${input.name}`);
    return { created: true, suite };
  }

  listSuiteItems(name: string): SuiteItemRecord[] {
    const suite = this.getSuite(name);
    if (!suite) throw new Error(`未找到套卷：${name}`);
    return this.listSuiteItemsBySuiteId(suite.id);
  }

  listSuiteItemsBySuiteId(suiteId: number): SuiteItemRecord[] {
    const hasDifficulty = this.hasColumn("suite_items", "difficulty");
    return (this.db.prepare("SELECT * FROM suite_items WHERE suite_id = ? ORDER BY id").all(suiteId) as Row[]).map((row) => ({
      id: Number(row.id),
      suiteId: Number(row.suite_id),
      itemKey: String(row.item_key),
      videoKey: String(row.video_key),
      probeType: row.probe_type === null ? null : String(row.probe_type),
      expectedBehavior: row.expected_behavior === null ? null : String(row.expected_behavior),
      difficulty: !hasDifficulty || row.difficulty === null || row.difficulty === undefined
        ? null
        : (row.difficulty as DifficultyLevel),
      messages: JSON.parse(String(row.messages_json)) as Array<{ role: "user" | "assistant" | "system"; content: string }>,
      rubrics: JSON.parse(String(row.rubrics_json)) as unknown[],
    }));
  }

  // ---------- candidate eval runs, predictions & scores ----------

  createEvalRun(input: {
    suiteId: number;
    candidate: string;
    model: string;
    historyMode: EvalHistoryMode;
    config: Record<string, unknown>;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO eval_runs (suite_id, candidate, model, history_mode, config_json, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `).run(input.suiteId, input.candidate, input.model, input.historyMode, JSON.stringify(input.config), nowIso());
    return Number(result.lastInsertRowid);
  }

  reopenEvalRun(evalRunId: number, configPatch?: Record<string, unknown>): void {
    const existing = this.getEvalRun(evalRunId);
    if (!existing) throw new Error(`未找到评测运行：eval_run #${evalRunId}`);
    const mergedConfig = configPatch ? { ...existing.config, ...configPatch } : existing.config;
    this.db.prepare("UPDATE eval_runs SET status = 'running', finished_at = NULL, error = NULL, config_json = ? WHERE id = ?")
      .run(JSON.stringify(mergedConfig), evalRunId);
  }

  finishEvalRun(evalRunId: number, status: ProbeRunStatus, error?: string): void {
    this.db.prepare("UPDATE eval_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(status, nowIso(), error ?? null, evalRunId);
  }

  getEvalRun(evalRunId: number): EvalRunRecord | undefined {
    if (!this.hasTable("eval_runs")) return undefined;
    const row = this.db.prepare(`
      SELECT er.*, sv.name AS suite_name, sv.kind AS suite_kind
      FROM eval_runs er
      JOIN suite_versions sv ON sv.id = er.suite_id
      WHERE er.id = ?
    `).get(evalRunId) as Row | undefined;
    return row ? mapEvalRun(row) : undefined;
  }

  listEvalRuns(filter: {
    suiteName?: string;
    candidate?: string;
    historyMode?: EvalHistoryMode;
    status?: ProbeRunStatus;
  } = {}): EvalRunRecord[] {
    if (!this.hasTable("eval_runs")) return [];
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.suiteName !== undefined) { where.push("sv.name = ?"); params.push(filter.suiteName); }
    if (filter.candidate !== undefined) { where.push("er.candidate = ?"); params.push(filter.candidate); }
    if (filter.historyMode !== undefined) { where.push("er.history_mode = ?"); params.push(filter.historyMode); }
    if (filter.status !== undefined) { where.push("er.status = ?"); params.push(filter.status); }
    const sql = `
      SELECT er.*, sv.name AS suite_name, sv.kind AS suite_kind
      FROM eval_runs er
      JOIN suite_versions sv ON sv.id = er.suite_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY er.id
    `;
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapEvalRun);
  }

  latestEvalRunId(filter: { suiteName?: string; candidate?: string; historyMode?: EvalHistoryMode } = {}): number | undefined {
    const runs = this.listEvalRuns(filter);
    return runs.length > 0 ? runs[runs.length - 1]!.id : undefined;
  }

  saveEvalPrediction(input: {
    evalRunId: number;
    suiteItemId: number;
    turnNo: number;
    input: Record<string, unknown>;
    outputText: string | null;
    error: string | null;
    callId: number | null;
  }): number {
    this.db.prepare(`
      INSERT INTO eval_predictions (eval_run_id, suite_item_id, turn_no, input_json, output_text, error, call_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(eval_run_id, suite_item_id, turn_no) DO UPDATE SET
        input_json = excluded.input_json,
        output_text = excluded.output_text,
        error = excluded.error,
        call_id = excluded.call_id,
        created_at = excluded.created_at
    `).run(
      input.evalRunId,
      input.suiteItemId,
      input.turnNo,
      JSON.stringify(input.input),
      input.outputText,
      input.error,
      input.callId,
      nowIso(),
    );
    const row = this.db.prepare(
      "SELECT id FROM eval_predictions WHERE eval_run_id = ? AND suite_item_id = ? AND turn_no = ?",
    ).get(input.evalRunId, input.suiteItemId, input.turnNo) as Row;
    return Number(row.id);
  }

  listEvalPredictions(evalRunId: number): EvalPredictionRecord[] {
    if (!this.hasTable("eval_predictions")) return [];
    return (this.db.prepare(
      "SELECT * FROM eval_predictions WHERE eval_run_id = ? ORDER BY suite_item_id, turn_no",
    ).all(evalRunId) as Row[]).map((row) => ({
      id: Number(row.id),
      evalRunId: Number(row.eval_run_id),
      suiteItemId: Number(row.suite_item_id),
      turnNo: Number(row.turn_no),
      input: JSON.parse(String(row.input_json)) as Record<string, unknown>,
      outputText: row.output_text === null ? null : String(row.output_text),
      error: row.error === null ? null : String(row.error),
      callId: row.call_id === null ? null : Number(row.call_id),
      createdAt: String(row.created_at),
    }));
  }

  saveEvalScore(input: {
    predictionId: number;
    graderModel: string;
    behaviorOk: boolean;
    stance: number;
    keyPointCoverage: number;
    forbiddenHits: number;
    hallucinationHits: number;
    failureSignalHits: number;
    style: number;
    score: number;
    detail: Record<string, unknown>;
    callId: number | null;
  }): void {
    this.db.prepare(`
      INSERT INTO eval_scores (
        prediction_id, grader_model, behavior_ok, stance, key_point_coverage,
        forbidden_hits, hallucination_hits, failure_signal_hits, style, score, detail_json, call_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prediction_id) DO UPDATE SET
        grader_model = excluded.grader_model,
        behavior_ok = excluded.behavior_ok,
        stance = excluded.stance,
        key_point_coverage = excluded.key_point_coverage,
        forbidden_hits = excluded.forbidden_hits,
        hallucination_hits = excluded.hallucination_hits,
        failure_signal_hits = excluded.failure_signal_hits,
        style = excluded.style,
        score = excluded.score,
        detail_json = excluded.detail_json,
        call_id = excluded.call_id,
        created_at = excluded.created_at
    `).run(
      input.predictionId,
      input.graderModel,
      input.behaviorOk ? 1 : 0,
      input.stance,
      input.keyPointCoverage,
      input.forbiddenHits,
      input.hallucinationHits,
      input.failureSignalHits,
      input.style,
      input.score,
      JSON.stringify(input.detail),
      input.callId,
      nowIso(),
    );
  }

  listEvalScores(evalRunId: number): EvalScoreRecord[] {
    if (!this.hasTable("eval_scores")) return [];
    const hasDifficulty = this.hasColumn("suite_items", "difficulty");
    const difficultyCol = hasDifficulty ? "si.difficulty" : "NULL AS difficulty";
    return (this.db.prepare(`
      SELECT
        es.*,
        ep.eval_run_id,
        ep.suite_item_id,
        ep.turn_no,
        si.item_key,
        si.video_key,
        si.probe_type,
        si.expected_behavior AS item_expected_behavior,
        ${difficultyCol}
      FROM eval_scores es
      JOIN eval_predictions ep ON ep.id = es.prediction_id
      JOIN suite_items si ON si.id = ep.suite_item_id
      WHERE ep.eval_run_id = ?
      ORDER BY ep.suite_item_id, ep.turn_no
    `).all(evalRunId) as Row[]).map((row) => ({
      id: Number(row.id),
      predictionId: Number(row.prediction_id),
      evalRunId: Number(row.eval_run_id),
      suiteItemId: Number(row.suite_item_id),
      itemKey: String(row.item_key),
      videoKey: String(row.video_key),
      probeType: row.probe_type === null ? null : String(row.probe_type),
      itemExpectedBehavior: row.item_expected_behavior === null ? null : String(row.item_expected_behavior),
      difficulty: row.difficulty === null || row.difficulty === undefined ? null : (row.difficulty as DifficultyLevel),
      turnNo: Number(row.turn_no),
      graderModel: String(row.grader_model),
      behaviorOk: Number(row.behavior_ok) === 1,
      stance: Number(row.stance),
      keyPointCoverage: Number(row.key_point_coverage),
      forbiddenHits: Number(row.forbidden_hits),
      hallucinationHits: Number(row.hallucination_hits),
      failureSignalHits: Number(row.failure_signal_hits),
      style: Number(row.style),
      score: Number(row.score),
      detail: JSON.parse(String(row.detail_json)) as Record<string, unknown>,
      callId: row.call_id === null ? null : Number(row.call_id),
      createdAt: String(row.created_at),
    }));
  }

  listEvalRunSummaries(): EvalRunSummaryRow[] {
    if (!this.hasTable("eval_runs")) return [];
    return (this.db.prepare(`
      SELECT
        er.id,
        sv.name AS suite_name,
        er.candidate,
        er.model,
        er.history_mode,
        er.status,
        er.started_at,
        (SELECT count(*) FROM eval_predictions ep WHERE ep.eval_run_id = er.id AND ep.output_text IS NOT NULL AND ep.error IS NULL) AS predictions,
        (SELECT count(*) FROM eval_scores es JOIN eval_predictions ep ON ep.id = es.prediction_id WHERE ep.eval_run_id = er.id) AS scores
      FROM eval_runs er
      JOIN suite_versions sv ON sv.id = er.suite_id
      ORDER BY er.id
    `).all() as Row[]).map((row) => ({
      id: Number(row.id),
      suiteName: String(row.suite_name),
      candidate: String(row.candidate),
      model: String(row.model),
      historyMode: row.history_mode as EvalHistoryMode,
      status: row.status as ProbeRunStatus,
      predictions: Number(row.predictions),
      scores: Number(row.scores),
      startedAt: String(row.started_at),
    }));
  }
}
