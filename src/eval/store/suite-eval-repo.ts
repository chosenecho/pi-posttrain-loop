import type { DatabaseSync } from "node:sqlite";
import { nonEmpty } from "../../shared/schema.js";
import { nowIso } from "../../shared/utils.js";
import {
  parseJsonArray,
  parseJsonObject,
  type DifficultyLevel,
  type EvalHistoryMode,
  type EvalPredictionRecord,
  type EvalRunRecord,
  type EvalScoreRecord,
  type ProbeType,
  type RunLifecycleStatus,
  type SuiteItemRecord,
  type SuiteRubricEntry,
  type SuiteVersionRecord,
} from "./types.js";

function mapSuiteRow(row: Record<string, unknown>): SuiteVersionRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    itemCount: Number(row.item_count),
    sha256: String(row.sha256),
    manifest: parseJsonObject(String(row.manifest_json)),
    frozenAt: String(row.frozen_at),
  };
}

function mapSuiteItemRow(row: Record<string, unknown>): SuiteItemRecord {
  return {
    id: Number(row.id),
    suiteId: Number(row.suite_id),
    itemKey: String(row.item_key),
    videoKey: String(row.video_key),
    probeType: String(row.probe_type) as ProbeType,
    difficulty: row.difficulty === null ? null : (String(row.difficulty) as DifficultyLevel),
    messages: parseJsonArray<{ role: "system" | "user" | "assistant"; content: string }>(String(row.messages_json)),
    rubrics: parseJsonArray<SuiteRubricEntry>(String(row.rubrics_json)),
  };
}

function mapEvalRunRow(row: Record<string, unknown>): EvalRunRecord {
  return {
    id: Number(row.id),
    suiteId: Number(row.suite_id),
    suiteName: String(row.suite_name),
    candidate: String(row.candidate),
    model: String(row.model),
    historyMode: String(row.history_mode) as EvalHistoryMode,
    systemPrompt: row.system_prompt === null ? null : String(row.system_prompt),
    config: parseJsonObject(String(row.config_json)),
    status: String(row.status) as RunLifecycleStatus,
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    error: row.error === null ? null : String(row.error),
  };
}

function mapPredictionRow(row: Record<string, unknown>): EvalPredictionRecord {
  return {
    id: Number(row.id),
    evalRunId: Number(row.eval_run_id),
    suiteItemId: Number(row.suite_item_id),
    turnNo: Number(row.turn_no),
    input: parseJsonObject(String(row.input_json)),
    outputText: row.output_text === null ? null : String(row.output_text),
    error: row.error === null ? null : String(row.error),
    callId: row.call_id === null ? null : Number(row.call_id),
    createdAt: String(row.created_at),
  };
}

function mapScoreRow(row: Record<string, unknown>): EvalScoreRecord {
  return {
    id: Number(row.id),
    predictionId: Number(row.prediction_id),
    graderModel: String(row.grader_model),
    behaviorOk: Number(row.behavior_ok) === 1,
    stance: Number(row.stance) as 0 | 1 | 2,
    keyPointCoverage: Number(row.key_point_coverage),
    forbiddenHits: Number(row.forbidden_hits),
    hallucinationHits: Number(row.hallucination_hits),
    failureSignalHits: Number(row.failure_signal_hits),
    style: Number(row.style) as 0 | 1 | 2,
    score: Number(row.score),
    detail: parseJsonObject(String(row.detail_json)),
    callId: row.call_id === null ? null : Number(row.call_id),
    createdAt: String(row.created_at),
  };
}

export class EvalSuiteAndRunRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(fn: () => T) => T,
  ) {}

  freezeSuite(input: {
    name: string;
    sha256: string;
    manifest: Record<string, unknown>;
    items: Array<{
      itemKey: string;
      videoKey: string;
      probeType: ProbeType;
      difficulty?: DifficultyLevel | null;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      rubrics: SuiteRubricEntry[];
    }>;
  }): { created: boolean; suite: SuiteVersionRecord } {
    const name = nonEmpty(input.name, "suite name");
    const existing = this.getSuite(name);
    if (existing) {
      if (existing.sha256 === input.sha256 && existing.itemCount === input.items.length) {
        return { created: false, suite: existing };
      }
      throw new Error(
        `冻结套卷 "${name}" 已存在且内容不同（已有 sha256=${existing.sha256.slice(0, 12)}，本次=${input.sha256.slice(0, 12)}）；禁止覆盖已冻结版本，请使用新版本号`,
      );
    }

    const suiteId = this.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT INTO suite_versions (name, item_count, sha256, manifest_json, frozen_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(name, input.items.length, input.sha256, JSON.stringify(input.manifest), nowIso());
      const id = Number(res.lastInsertRowid);
      const stmt = this.db.prepare(
        `INSERT INTO suite_items
         (suite_id, item_key, video_key, probe_type, difficulty, messages_json, rubrics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of input.items) {
        stmt.run(
          id,
          item.itemKey,
          item.videoKey,
          item.probeType,
          item.difficulty ?? null,
          JSON.stringify(item.messages),
          JSON.stringify(item.rubrics),
        );
      }
      return id;
    });

    const row = this.db.prepare("SELECT * FROM suite_versions WHERE id = ?").get(suiteId) as Record<string, unknown>;
    return { created: true, suite: mapSuiteRow(row) };
  }

  getSuite(name: string): SuiteVersionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM suite_versions WHERE name = ?").get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? mapSuiteRow(row) : undefined;
  }

  listSuites(): SuiteVersionRecord[] {
    const rows = this.db.prepare("SELECT * FROM suite_versions ORDER BY id ASC").all() as Array<Record<string, unknown>>;
    return rows.map(mapSuiteRow);
  }

  listSuiteItems(suiteId: number): SuiteItemRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM suite_items WHERE suite_id = ? ORDER BY id ASC")
      .all(suiteId) as Array<Record<string, unknown>>;
    return rows.map(mapSuiteItemRow);
  }

  createEvalRun(input: {
    suiteId: number;
    candidate: string;
    model: string;
    historyMode: EvalHistoryMode;
    systemPrompt?: string | null;
    config?: Record<string, unknown>;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO eval_runs
         (suite_id, candidate, model, history_mode, system_prompt, config_json, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        input.suiteId,
        nonEmpty(input.candidate, "candidate"),
        nonEmpty(input.model, "model"),
        input.historyMode,
        input.systemPrompt ?? null,
        JSON.stringify(input.config ?? {}),
        nowIso(),
      );
    return Number(res.lastInsertRowid);
  }

  reopenEvalRun(evalRunId: number): void {
    this.db
      .prepare("UPDATE eval_runs SET status = 'running', ended_at = NULL, error = NULL WHERE id = ?")
      .run(evalRunId);
  }

  finishEvalRun(evalRunId: number, status: Exclude<RunLifecycleStatus, "running">, error?: string): void {
    this.db
      .prepare("UPDATE eval_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?")
      .run(status, nowIso(), error ?? null, evalRunId);
  }

  getEvalRun(evalRunId: number): EvalRunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*, s.name AS suite_name
         FROM eval_runs r
         JOIN suite_versions s ON s.id = r.suite_id
         WHERE r.id = ?`,
      )
      .get(evalRunId) as Record<string, unknown> | undefined;
    return row ? mapEvalRunRow(row) : undefined;
  }

  getLatestEvalRun(filter: { suiteName?: string; candidate?: string } = {}): EvalRunRecord | undefined {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.suiteName) {
      clauses.push("s.name = ?");
      params.push(filter.suiteName);
    }
    if (filter.candidate) {
      clauses.push("r.candidate = ?");
      params.push(filter.candidate);
    }
    let sql = `SELECT r.*, s.name AS suite_name FROM eval_runs r JOIN suite_versions s ON s.id = r.suite_id`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY r.id DESC LIMIT 1";
    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return row ? mapEvalRunRow(row) : undefined;
  }

  listEvalRuns(filter: {
    suiteNames?: string[];
    candidates?: string[];
    runIds?: number[];
    historyMode?: EvalHistoryMode;
  } = {}): EvalRunRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.suiteNames && filter.suiteNames.length > 0) {
      clauses.push(`s.name IN (${filter.suiteNames.map(() => "?").join(", ")})`);
      params.push(...filter.suiteNames);
    }
    if (filter.candidates && filter.candidates.length > 0) {
      clauses.push(`r.candidate IN (${filter.candidates.map(() => "?").join(", ")})`);
      params.push(...filter.candidates);
    }
    if (filter.runIds && filter.runIds.length > 0) {
      clauses.push(`r.id IN (${filter.runIds.map(() => "?").join(", ")})`);
      params.push(...filter.runIds);
    }
    if (filter.historyMode !== undefined) {
      clauses.push("r.history_mode = ?");
      params.push(filter.historyMode);
    }
    let sql = `SELECT r.*, s.name AS suite_name FROM eval_runs r JOIN suite_versions s ON s.id = r.suite_id`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY r.id ASC";
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapEvalRunRow);
  }

  saveEvalPrediction(input: {
    evalRunId: number;
    suiteItemId: number;
    turnNo: number;
    input: Record<string, unknown>;
    outputText?: string | null;
    error?: string | null;
    callId?: number | null;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO eval_predictions
         (eval_run_id, suite_item_id, turn_no, input_json, output_text, error, call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(eval_run_id, suite_item_id, turn_no) DO UPDATE SET
           input_json = excluded.input_json,
           output_text = excluded.output_text,
           error = excluded.error,
           call_id = excluded.call_id,
           created_at = excluded.created_at`,
      )
      .run(
        input.evalRunId,
        input.suiteItemId,
        input.turnNo,
        JSON.stringify(input.input),
        input.outputText ?? null,
        input.error ?? null,
        input.callId ?? null,
        nowIso(),
      );
    return Number(res.lastInsertRowid);
  }

  listEvalPredictions(evalRunId: number): EvalPredictionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM eval_predictions WHERE eval_run_id = ? ORDER BY suite_item_id ASC, turn_no ASC")
      .all(evalRunId) as Array<Record<string, unknown>>;
    return rows.map(mapPredictionRow);
  }

  saveEvalScore(input: {
    predictionId: number;
    graderModel: string;
    behaviorOk: boolean;
    stance: 0 | 1 | 2;
    keyPointCoverage: number;
    forbiddenHits: number;
    hallucinationHits: number;
    failureSignalHits: number;
    style: 0 | 1 | 2;
    score: number;
    detail: Record<string, unknown>;
    callId?: number | null;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO eval_scores
         (prediction_id, grader_model, behavior_ok, stance, key_point_coverage,
          forbidden_hits, hallucination_hits, failure_signal_hits, style, score, detail_json, call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           created_at = excluded.created_at`,
      )
      .run(
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
        input.callId ?? null,
        nowIso(),
      );
    return Number(res.lastInsertRowid);
  }

  listEvalScores(evalRunId: number): EvalScoreRecord[] {
    const rows = this.db
      .prepare(
        `SELECT sc.*
         FROM eval_scores sc
         JOIN eval_predictions p ON p.id = sc.prediction_id
         WHERE p.eval_run_id = ?
         ORDER BY p.suite_item_id ASC, p.turn_no ASC`,
      )
      .all(evalRunId) as Array<Record<string, unknown>>;
    return rows.map(mapScoreRow);
  }
}
