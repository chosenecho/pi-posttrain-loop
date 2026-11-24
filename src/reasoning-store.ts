import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractVideoKey, type DedupPolicy } from "./db.js";
import { countContentChars, inferThinkTier, type ThinkTier } from "./reasoning-checks.js";
import { nonEmpty, validateSplit } from "./schema.js";
import type { DatasetSplit } from "./types.js";

export type ReasoningRunStatus = "running" | "completed" | "interrupted" | "error";
export type ReasoningTraceStatus = "running" | "completed" | "error" | "interrupted";
export type ReasoningTraceDecision = "pass" | "drop";

export interface ReasoningRunRecord {
  id: number;
  status: ReasoningRunStatus;
  writer_model: string;
  judge_model: string | null;
  config_json: string;
  prompts_json: string;
  skills_json: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface ReasoningTraceRecord {
  id: number;
  reasoning_run_id: number;
  attempt_id: number;
  result_id: number;
  turn_no: number;
  length_tier: ThinkTier;
  status: ReasoningTraceStatus;
  decision: ReasoningTraceDecision | null;
  rewrite_count: number;
  reasoning: string | null;
  checks_json: string | null;
  raw_output: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface HistoryTurnMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CandidateTurn {
  resultId: number;
  sourceRunId: number;
  questionId: number;
  materialId: number;
  videoId: string;
  videoKey: string;
  turnCount: number;
  turnNo: number;
  attemptId: number;
  question: string;
  answer: string;
  answerCharCount: number;
  lengthTier: ThinkTier;
  history: HistoryTurnMessage[];
}

export interface CandidateTurnQueryOptions {
  allFormal?: boolean;
  runIds?: number[];
  excludeRunIds?: number[];
  split?: DatasetSplit;
  dedup?: DedupPolicy;
  minTurns?: number;
  maxTurns?: number;
  onlyMissing?: boolean;
  missingAgainstRunId?: number;
}

export interface TraceWithContext {
  trace: ReasoningTraceRecord;
  sourceRunId: number;
  questionId: number;
  materialId: number;
  videoId: string;
  videoKey: string;
  turnCount: number;
  question: string;
  answer: string;
  history: HistoryTurnMessage[];
}

export interface ReasoningStatusSummary {
  candidateResults: number;
  candidateTurns: number;
  missingTurns: number;
  byTier: Record<ThinkTier, number>;
  byTurnNo: Record<number, number>;
  reasoningRuns: Array<{
    id: number;
    status: ReasoningRunStatus;
    writerModel: string;
    judgeModel: string | null;
    startedAt: string;
    finishedAt: string | null;
    total: number;
    passed: number;
    dropped: number;
    errored: number;
  }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

const REASONING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reasoning_runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'interrupted', 'error')),
  writer_model TEXT NOT NULL CHECK(length(trim(writer_model)) > 0),
  judge_model TEXT,
  config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json) = 'object'),
  prompts_json TEXT NOT NULL CHECK(json_valid(prompts_json) AND json_type(prompts_json) = 'object'),
  skills_json TEXT NOT NULL CHECK(json_valid(skills_json) AND json_type(skills_json) = 'array'),
  started_at TEXT NOT NULL CHECK(length(trim(started_at)) > 0),
  finished_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS reasoning_traces (
  id INTEGER PRIMARY KEY,
  reasoning_run_id INTEGER NOT NULL REFERENCES reasoning_runs(id),
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  result_id INTEGER NOT NULL REFERENCES results(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  length_tier TEXT NOT NULL CHECK(length_tier IN ('short', 'medium', 'long')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'error', 'interrupted')),
  decision TEXT CHECK(decision IS NULL OR decision IN ('pass', 'drop')),
  rewrite_count INTEGER NOT NULL DEFAULT 0 CHECK(rewrite_count >= 0),
  reasoning TEXT CHECK(reasoning IS NULL OR length(trim(reasoning)) > 0),
  checks_json TEXT CHECK(checks_json IS NULL OR (json_valid(checks_json) AND json_type(checks_json) = 'object')),
  raw_output TEXT,
  error TEXT,
  created_at TEXT NOT NULL CHECK(length(trim(created_at)) > 0),
  finished_at TEXT,
  UNIQUE(reasoning_run_id, attempt_id),
  CHECK(
    decision IS NULL OR
    (decision = 'pass' AND status = 'completed' AND reasoning IS NOT NULL) OR
    (decision = 'drop' AND status = 'completed')
  )
);

CREATE INDEX IF NOT EXISTS idx_reasoning_traces_run_id ON reasoning_traces(reasoning_run_id);
CREATE INDEX IF NOT EXISTS idx_reasoning_traces_attempt_id ON reasoning_traces(attempt_id);
CREATE INDEX IF NOT EXISTS idx_reasoning_traces_result_turn ON reasoning_traces(result_id, turn_no);
`;

interface RawResultTurnRow {
  result_id: number;
  run_id: number;
  question_id: number;
  material_id: number;
  video_id: string;
  turn_count: number;
  turn_no: number;
  attempt_id: number;
  user_content: string;
  assistant_content: string;
}

export class ReasoningStore {
  readonly db: DatabaseSync;
  readonly readOnly: boolean;

  constructor(databasePath: string, options: { readOnly?: boolean; busyTimeoutMs?: number } = {}) {
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly && databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath, { readOnly: this.readOnly });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
    if (!this.readOnly) {
      if (databasePath !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL;");
      }
      this.db.exec(REASONING_SCHEMA_SQL);
    }
  }

  close(): void {
    this.db.close();
  }

  hasTable(name: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { found: number } | undefined;
    return row !== undefined;
  }

  recoverInterruptedRuns(finishedAt = nowIso()): { runs: number; traces: number } {
    if (this.readOnly || !this.hasTable("reasoning_runs")) {
      return { runs: 0, traces: 0 };
    }
    const runs = Number(
      this.db
        .prepare(
          `UPDATE reasoning_runs
           SET status = 'interrupted',
               finished_at = COALESCE(finished_at, ?),
               error = COALESCE(error, '进程中断，启动恢复标记为 interrupted')
           WHERE status = 'running'`,
        )
        .run(finishedAt).changes,
    );
    const traces = Number(
      this.db
        .prepare(
          `UPDATE reasoning_traces
           SET status = 'interrupted',
               finished_at = COALESCE(finished_at, ?),
               error = COALESCE(error, '进程中断，启动恢复标记为 interrupted')
           WHERE status = 'running'`,
        )
        .run(finishedAt).changes,
    );
    return { runs, traces };
  }

  createReasoningRun(input: {
    writerModel: string;
    judgeModel: string | null;
    config: Record<string, unknown>;
    prompts: Record<string, unknown>;
    skills: unknown[];
    startedAt?: string;
  }): number {
    const startedAt = input.startedAt ?? nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO reasoning_runs
           (status, writer_model, judge_model, config_json, prompts_json, skills_json, started_at)
         VALUES ('running', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nonEmpty(input.writerModel, "writerModel"),
        input.judgeModel ? nonEmpty(input.judgeModel, "judgeModel") : null,
        JSON.stringify(input.config),
        JSON.stringify(input.prompts),
        JSON.stringify(input.skills),
        startedAt,
      );
    return Number(res.lastInsertRowid);
  }

  finishReasoningRun(runId: number, status: Exclude<ReasoningRunStatus, "running">, error?: string | null): void {
    this.db
      .prepare(
        `UPDATE reasoning_runs
         SET status = ?, finished_at = ?, error = ?
         WHERE id = ?`,
      )
      .run(status, nowIso(), error ?? null, runId);
  }

  startTrace(input: {
    reasoningRunId: number;
    attemptId: number;
    resultId: number;
    turnNo: number;
    lengthTier: ThinkTier;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO reasoning_traces
           (reasoning_run_id, attempt_id, result_id, turn_no, length_tier, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(input.reasoningRunId, input.attemptId, input.resultId, input.turnNo, input.lengthTier, nowIso());
    return Number(res.lastInsertRowid);
  }

  completeTrace(
    traceId: number,
    input: {
      status: "completed" | "error";
      decision: ReasoningTraceDecision | null;
      rewriteCount: number;
      reasoning: string | null;
      checks: Record<string, unknown> | null;
      rawOutput: string | null;
      error?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE reasoning_traces
         SET status = ?,
             decision = ?,
             rewrite_count = ?,
             reasoning = ?,
             checks_json = ?,
             raw_output = ?,
             error = ?,
             finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.decision,
        input.rewriteCount,
        input.reasoning && input.reasoning.trim() ? input.reasoning.trim() : null,
        input.checks ? JSON.stringify(input.checks) : null,
        input.rawOutput,
        input.error ?? null,
        nowIso(),
        traceId,
      );
  }

  getReasoningRun(runId: number): ReasoningRunRecord | undefined {
    if (!this.hasTable("reasoning_runs")) return undefined;
    return this.db
      .prepare(
        `SELECT id, status, writer_model, judge_model, config_json, prompts_json, skills_json, started_at, finished_at, error
         FROM reasoning_runs WHERE id = ?`,
      )
      .get(runId) as unknown as ReasoningRunRecord | undefined;
  }

  listReasoningRuns(): ReasoningRunRecord[] {
    if (!this.hasTable("reasoning_runs")) return [];
    return this.db
      .prepare(
        `SELECT id, status, writer_model, judge_model, config_json, prompts_json, skills_json, started_at, finished_at, error
         FROM reasoning_runs ORDER BY id`,
      )
      .all() as unknown as ReasoningRunRecord[];
  }

  getLatestReasoningRunId(): number | undefined {
    if (!this.hasTable("reasoning_runs")) return undefined;
    const row = this.db
      .prepare("SELECT id FROM reasoning_runs ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    return row ? Number(row.id) : undefined;
  }

  /** Returns a map from attempt_id -> passed reasoning string for a specific reasoning run (or latest passed across all runs). */
  getPassedReasoningMap(reasoningRunId?: number): Map<number, { reasoning: string; reasoningRunId: number; traceId: number; lengthTier: ThinkTier }> {
    const map = new Map<number, { reasoning: string; reasoningRunId: number; traceId: number; lengthTier: ThinkTier }>();
    if (!this.hasTable("reasoning_traces")) return map;

    const rows = reasoningRunId !== undefined
      ? (this.db
          .prepare(
            `SELECT id, reasoning_run_id, attempt_id, length_tier, reasoning
             FROM reasoning_traces
             WHERE reasoning_run_id = ? AND status = 'completed' AND decision = 'pass' AND reasoning IS NOT NULL`,
          )
          .all(reasoningRunId) as Array<{
            id: number;
            reasoning_run_id: number;
            attempt_id: number;
            length_tier: ThinkTier;
            reasoning: string;
          }>)
      : (this.db
          .prepare(
            `SELECT id, reasoning_run_id, attempt_id, length_tier, reasoning
             FROM reasoning_traces
             WHERE status = 'completed' AND decision = 'pass' AND reasoning IS NOT NULL
             ORDER BY reasoning_run_id ASC, id ASC`,
          )
          .all() as Array<{
            id: number;
            reasoning_run_id: number;
            attempt_id: number;
            length_tier: ThinkTier;
            reasoning: string;
          }>);

    for (const row of rows) {
      map.set(Number(row.attempt_id), {
        reasoning: row.reasoning,
        reasoningRunId: Number(row.reasoning_run_id),
        traceId: Number(row.id),
        lengthTier: row.length_tier,
      });
    }
    return map;
  }

  private getVideoSplitMap(): Map<string, DatasetSplit> {
    const map = new Map<string, DatasetSplit>();
    if (!this.hasTable("video_splits")) return map;
    const rows = this.db
      .prepare("SELECT video_key, split FROM video_splits")
      .all() as Array<{ video_key: string; split: DatasetSplit }>;
    for (const row of rows) {
      map.set(row.video_key, row.split);
    }
    return map;
  }

  /**
   * Queries formal passed turns from the unified SQLite DB, applying run selection,
   * split filtering (when video_splits is populated), per-question dedup, and optional
   * --only-missing filtering against existing passed reasoning_traces.
   */
  queryCandidateTurns(options: CandidateTurnQueryOptions = {}): CandidateTurn[] {
    if (!this.hasTable("results") || !this.hasTable("runs")) {
      return [];
    }
    const allFormal = options.allFormal ?? (options.runIds === undefined || options.runIds.length === 0);
    const targetSplit = options.split !== undefined ? validateSplit(options.split) : undefined;
    const dedup: DedupPolicy = options.dedup ?? "latest";
    const excludeSet = new Set(options.excludeRunIds ?? []);

    let candidateRunIds: number[];
    if (allFormal) {
      const effectiveSplit = targetSplit ?? "train";
      const runRows = effectiveSplit === "train"
        ? (this.db
            .prepare(
              `SELECT id FROM runs
               WHERE kind = 'answer_judge'
                 AND json_extract(export_policy_json, '$.training_enabled') = 1
                 AND COALESCE(json_extract(export_policy_json, '$.split'), 'train') = 'train'
               ORDER BY id`,
            )
            .all() as Array<{ id: number }>)
        : (this.db
            .prepare(
              `SELECT id FROM runs
               WHERE kind = 'answer_judge'
                 AND (
                   json_extract(export_policy_json, '$.eval_enabled') = 1
                   OR json_extract(export_policy_json, '$.training_enabled') = 1
                   OR json_extract(export_policy_json, '$.split') = ?
                 )
               ORDER BY id`,
            )
            .all(effectiveSplit) as Array<{ id: number }>);
      candidateRunIds = runRows.map((r) => Number(r.id)).filter((id) => !excludeSet.has(id));
    } else {
      const requested = [...new Set(options.runIds ?? [])];
      for (const id of requested) {
        if (!Number.isSafeInteger(id) || id < 1) throw new Error(`无效的 run_id：${id}`);
        const exists = this.db.prepare("SELECT id, kind FROM runs WHERE id = ?").get(id) as
          | { id: number; kind: string }
          | undefined;
        if (!exists) throw new Error(`未找到 run_id=${id}`);
        if (exists.kind !== "answer_judge") throw new Error(`run_id=${id} 不是 answer_judge 运行（kind=${exists.kind}）`);
      }
      candidateRunIds = requested.filter((id) => !excludeSet.has(id));
    }

    if (candidateRunIds.length === 0) return [];

    const placeholders = candidateRunIds.map(() => "?").join(", ");
    const params: number[] = [...candidateRunIds];
    let sql = `
      SELECT r.id AS result_id,
             i.run_id,
             q.id AS question_id,
             q.material_id,
             m.video_id,
             r.turn_count,
             t.turn_no,
             a.id AS attempt_id,
             COALESCE(t.user_content, q.question) AS user_content,
             a.answer AS assistant_content
      FROM results r
      JOIN run_items i ON i.id = r.run_item_id
      JOIN questions q ON q.id = i.question_id
      JOIN materials m ON m.id = q.material_id
      JOIN turns t ON t.run_item_id = i.id AND t.status = 'pass'
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

    const rawRows = this.db.prepare(sql).all(...params) as unknown as RawResultTurnRow[];
    const videoSplits = this.getVideoSplitMap();
    const effectiveSplitFilter: DatasetSplit | undefined = targetSplit ?? (allFormal && videoSplits.size > 0 ? "train" : undefined);

    const groupedByResult = new Map<number, RawResultTurnRow[]>();
    for (const row of rawRows) {
      const videoKey = extractVideoKey(row.video_id);
      if (effectiveSplitFilter !== undefined) {
        const assignedSplit = videoSplits.get(videoKey) ?? "train";
        if (assignedSplit !== effectiveSplitFilter) continue;
      }
      const list = groupedByResult.get(Number(row.result_id));
      if (list) list.push(row);
      else groupedByResult.set(Number(row.result_id), [row]);
    }

    // Deduplicate per question_id using the same policy as exportMergedDataset
    const byQuestion = new Map<number, Array<{ runId: number; turns: RawResultTurnRow[] }>>();
    for (const turns of groupedByResult.values()) {
      const first = turns[0];
      const qid = Number(first.question_id);
      const entry = { runId: Number(first.run_id), turns };
      const list = byQuestion.get(qid);
      if (list) list.push(entry);
      else byQuestion.set(qid, [entry]);
    }

    const selectedDialogues: RawResultTurnRow[][] = [];
    const conflicts: string[] = [];
    for (const [qid, list] of [...byQuestion.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a.runId - b.runId);
      if (list.length > 1) {
        if (dedup === "error") {
          conflicts.push(`q${qid} (runs: ${list.map((e) => e.runId).join(",")})`);
          continue;
        }
        selectedDialogues.push(dedup === "latest" ? list[list.length - 1].turns : list[0].turns);
      } else {
        selectedDialogues.push(list[0].turns);
      }
    }
    if (conflicts.length > 0) {
      throw new Error(`发现同题多版本冲突（--dedup error）：${conflicts.join("; ")}`);
    }

    const passedMap = options.onlyMissing ? this.getPassedReasoningMap(options.missingAgainstRunId) : undefined;
    const candidates: CandidateTurn[] = [];

    for (const turns of selectedDialogues) {
      turns.sort((a, b) => Number(a.turn_no) - Number(b.turn_no));
      const history: HistoryTurnMessage[] = [];
      for (const row of turns) {
        const attemptId = Number(row.attempt_id);
        const answerCharCount = countContentChars(row.assistant_content);
        if (!passedMap || !passedMap.has(attemptId)) {
          candidates.push({
            resultId: Number(row.result_id),
            sourceRunId: Number(row.run_id),
            questionId: Number(row.question_id),
            materialId: Number(row.material_id),
            videoId: row.video_id,
            videoKey: extractVideoKey(row.video_id),
            turnCount: Number(row.turn_count),
            turnNo: Number(row.turn_no),
            attemptId,
            question: row.user_content,
            answer: row.assistant_content,
            answerCharCount,
            lengthTier: inferThinkTier(answerCharCount),
            history: history.map((m) => ({ ...m })),
          });
        }
        history.push({ role: "user", content: row.user_content });
        history.push({ role: "assistant", content: row.assistant_content });
      }
    }

    return candidates;
  }

  /** Fetches all traces of a reasoning run enriched with original dialogue history, question, and golden answer. */
  queryRunTracesWithContext(reasoningRunId: number): TraceWithContext[] {
    if (!this.hasTable("reasoning_traces")) return [];
    const traces = this.db
      .prepare(
        `SELECT id, reasoning_run_id, attempt_id, result_id, turn_no, length_tier, status, decision,
                rewrite_count, reasoning, checks_json, raw_output, error, created_at, finished_at
         FROM reasoning_traces
         WHERE reasoning_run_id = ?
         ORDER BY id`,
      )
      .all(reasoningRunId) as unknown as ReasoningTraceRecord[];

    if (traces.length === 0) return [];

    const resultIds = [...new Set(traces.map((t) => Number(t.result_id)))];
    const placeholders = resultIds.map(() => "?").join(", ");
    const turnRows = this.db
      .prepare(
        `SELECT r.id AS result_id,
                i.run_id,
                q.id AS question_id,
                q.material_id,
                m.video_id,
                r.turn_count,
                t.turn_no,
                a.id AS attempt_id,
                COALESCE(t.user_content, q.question) AS user_content,
                a.answer AS assistant_content
         FROM results r
         JOIN run_items i ON i.id = r.run_item_id
         JOIN questions q ON q.id = i.question_id
         JOIN materials m ON m.id = q.material_id
         JOIN turns t ON t.run_item_id = i.id AND t.status = 'pass'
         JOIN attempts a ON a.id = t.passed_attempt_id
         WHERE r.id IN (${placeholders})
         ORDER BY r.id, t.turn_no`,
      )
      .all(...resultIds) as unknown as RawResultTurnRow[];

    const turnsByResult = new Map<number, RawResultTurnRow[]>();
    for (const row of turnRows) {
      const rid = Number(row.result_id);
      const list = turnsByResult.get(rid);
      if (list) list.push(row);
      else turnsByResult.set(rid, [row]);
    }

    const output: TraceWithContext[] = [];
    for (const trace of traces) {
      const dialogue = turnsByResult.get(Number(trace.result_id)) ?? [];
      const history: HistoryTurnMessage[] = [];
      let currentRow: RawResultTurnRow | undefined;
      for (const row of dialogue) {
        if (Number(row.turn_no) < Number(trace.turn_no)) {
          history.push({ role: "user", content: row.user_content });
          history.push({ role: "assistant", content: row.assistant_content });
        } else if (Number(row.turn_no) === Number(trace.turn_no)) {
          currentRow = row;
          break;
        }
      }
      if (!currentRow) continue;
      output.push({
        trace,
        sourceRunId: Number(currentRow.run_id),
        questionId: Number(currentRow.question_id),
        materialId: Number(currentRow.material_id),
        videoId: currentRow.video_id,
        videoKey: extractVideoKey(currentRow.video_id),
        turnCount: Number(currentRow.turn_count),
        question: currentRow.user_content,
        answer: currentRow.assistant_content,
        history,
      });
    }

    return output;
  }

  getStatusSummary(options: CandidateTurnQueryOptions = {}): ReasoningStatusSummary {
    const allCandidates = this.queryCandidateTurns({ ...options, onlyMissing: false });
    const passedMap = this.getPassedReasoningMap();
    const byTier: Record<ThinkTier, number> = { short: 0, medium: 0, long: 0 };
    const byTurnNo: Record<number, number> = {};
    const resultIds = new Set<number>();
    let missingTurns = 0;

    for (const c of allCandidates) {
      resultIds.add(c.resultId);
      byTier[c.lengthTier]++;
      byTurnNo[c.turnNo] = (byTurnNo[c.turnNo] ?? 0) + 1;
      if (!passedMap.has(c.attemptId)) missingTurns++;
    }

    const runs = this.listReasoningRuns();
    const reasoningRuns = runs.map((run) => {
      const counts = this.db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'completed' AND decision = 'pass' THEN 1 ELSE 0 END) AS passed,
             SUM(CASE WHEN status = 'completed' AND decision = 'drop' THEN 1 ELSE 0 END) AS dropped,
             SUM(CASE WHEN status IN ('error', 'interrupted') THEN 1 ELSE 0 END) AS errored
           FROM reasoning_traces
           WHERE reasoning_run_id = ?`,
        )
        .get(run.id) as { total: number; passed: number | null; dropped: number | null; errored: number | null };
      return {
        id: Number(run.id),
        status: run.status,
        writerModel: run.writer_model,
        judgeModel: run.judge_model,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        total: Number(counts.total ?? 0),
        passed: Number(counts.passed ?? 0),
        dropped: Number(counts.dropped ?? 0),
        errored: Number(counts.errored ?? 0),
      };
    });

    return {
      candidateResults: resultIds.size,
      candidateTurns: allCandidates.length,
      missingTurns,
      byTier,
      byTurnNo,
      reasoningRuns,
    };
  }
}
