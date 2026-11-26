import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../shared/utils.js";
import {
  expectedBehaviorForTurn,
  parseJsonArray,
  parseJsonObject,
  type AdversaryTactic,
  type CreateProbeInput,
  type DifficultyLevel,
  type ExpectedBehavior,
  type ProbeCalibrationRecord,
  type ProbeRecord,
  type ProbeReviewEntry,
  type ProbeRubric,
  type ProbeStatus,
  type ProbeTurnRecord,
  type ProbeType,
  type SaveProbeTurnInput,
} from "./types.js";

function mapProbeRow(row: Record<string, unknown>): ProbeRecord {
  const probeType = String(row.probe_type) as ProbeType;
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    sourceMaterialId: Number(row.source_material_id),
    slotIndex: Number(row.slot_index),
    probeType,
    expectedBehavior: expectedBehaviorForTurn(probeType, 1),
    persona: String(row.persona),
    targetTurns: Number(row.target_turns),
    question: String(row.question),
    anchor: String(row.anchor),
    trap: String(row.trap),
    anchorVerified: Number(row.anchor_verified) === 1,
    status: String(row.status) as ProbeStatus,
    revisions: Number(row.revisions),
    reviews: parseJsonArray<ProbeReviewEntry>(String(row.reviews_json ?? "[]")),
    rejectReason: row.reject_reason === null ? null : String(row.reject_reason),
    difficulty: row.difficulty === null ? null : (String(row.difficulty) as DifficultyLevel),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTurnRow(row: Record<string, unknown>): ProbeTurnRecord {
  return {
    id: Number(row.id),
    probeId: Number(row.probe_id),
    turnNo: Number(row.turn_no),
    expectedBehavior: String(row.expected_behavior) as ExpectedBehavior,
    tactic: row.tactic === null ? null : (String(row.tactic) as AdversaryTactic),
    userContent: String(row.user_content),
    referenceAnswer: String(row.reference_answer),
    rubric: parseJsonObject(String(row.rubric_json)) as unknown as ProbeRubric,
    attempts: Number(row.attempts),
    createdAt: String(row.created_at),
  };
}

function mapCalibrationRow(row: Record<string, unknown>): ProbeCalibrationRecord {
  return {
    id: Number(row.id),
    probeId: Number(row.probe_id),
    turnNo: Number(row.turn_no),
    bareModel: String(row.bare_model),
    graderModel: String(row.grader_model),
    bareAnswer: String(row.bare_answer),
    behaviorOk: Number(row.behavior_ok) === 1,
    score: Number(row.score),
    detail: parseJsonObject(String(row.detail_json)),
    bareCallId: row.bare_call_id === null ? null : Number(row.bare_call_id),
    graderCallId: row.grader_call_id === null ? null : Number(row.grader_call_id),
    createdAt: String(row.created_at),
  };
}

export class EvalProbeRepo {
  constructor(private readonly db: DatabaseSync) {}

  createProbe(input: CreateProbeInput): number {
    const now = nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO probes
         (run_id, source_material_id, slot_index, probe_type, persona, target_turns,
          question, anchor, trap, anchor_verified, status, revisions, reviews_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, '[]', ?, ?)`,
      )
      .run(
        input.runId,
        input.sourceMaterialId,
        input.slotIndex,
        input.probeType,
        input.persona,
        input.targetTurns,
        input.question,
        input.anchor,
        input.trap,
        input.anchorVerified ? 1 : 0,
        now,
        now,
      );
    return Number(res.lastInsertRowid);
  }

  reviseProbe(
    probeId: number,
    update: {
      probeType?: ProbeType;
      persona?: string;
      targetTurns?: number;
      question: string;
      anchor: string;
      trap: string;
      anchorVerified: boolean;
    },
  ): void {
    const current = this.getProbe(probeId);
    if (!current) throw new Error(`未找到 probe #${probeId}`);
    this.db
      .prepare(
        `UPDATE probes
         SET probe_type = ?, persona = ?, target_turns = ?,
             question = ?, anchor = ?, trap = ?, anchor_verified = ?,
             revisions = revisions + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        update.probeType ?? current.probeType,
        update.persona ?? current.persona,
        update.targetTurns ?? current.targetTurns,
        update.question,
        update.anchor,
        update.trap,
        update.anchorVerified ? 1 : 0,
        nowIso(),
        probeId,
      );
  }

  appendReview(probeId: number, review: Omit<ProbeReviewEntry, "createdAt">): void {
    const current = this.getProbe(probeId);
    if (!current) throw new Error(`未找到 probe #${probeId}`);
    const next: ProbeReviewEntry[] = [...current.reviews, { ...review, createdAt: nowIso() }];
    this.db
      .prepare("UPDATE probes SET reviews_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), nowIso(), probeId);
  }

  setProbeStatus(probeId: number, status: ProbeStatus, rejectReason?: string | null): void {
    this.db
      .prepare("UPDATE probes SET status = ?, reject_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, rejectReason ?? null, nowIso(), probeId);
  }

  setProbeDifficulty(probeId: number, difficulty: DifficultyLevel): void {
    this.db
      .prepare("UPDATE probes SET difficulty = ?, updated_at = ? WHERE id = ?")
      .run(difficulty, nowIso(), probeId);
  }

  getProbe(probeId: number): ProbeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM probes WHERE id = ?").get(probeId) as Record<string, unknown> | undefined;
    return row ? mapProbeRow(row) : undefined;
  }

  listProbes(
    filter: {
      runId?: number;
      status?: ProbeStatus;
      probeType?: ProbeType;
      probeTypes?: readonly ProbeType[];
      difficulty?: DifficultyLevel | "uncalibrated";
      sourceMaterialId?: number;
    } = {},
  ): ProbeRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.probeType !== undefined) {
      clauses.push("probe_type = ?");
      params.push(filter.probeType);
    }
    if (filter.probeTypes && filter.probeTypes.length > 0) {
      clauses.push(`probe_type IN (${filter.probeTypes.map(() => "?").join(", ")})`);
      params.push(...filter.probeTypes);
    }
    if (filter.difficulty === "uncalibrated") {
      clauses.push("difficulty IS NULL");
    } else if (filter.difficulty !== undefined) {
      clauses.push("difficulty = ?");
      params.push(filter.difficulty);
    }
    if (filter.sourceMaterialId !== undefined) {
      clauses.push("source_material_id = ?");
      params.push(filter.sourceMaterialId);
    }

    let sql = "SELECT * FROM probes";
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY id ASC";
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapProbeRow);
  }

  listExistingQuestionsForSource(sourceMaterialId: number, excludeProbeId?: number): string[] {
    const sql = excludeProbeId !== undefined
      ? "SELECT question FROM probes WHERE source_material_id = ? AND status IN ('draft', 'accepted') AND id != ? ORDER BY id ASC"
      : "SELECT question FROM probes WHERE source_material_id = ? AND status IN ('draft', 'accepted') ORDER BY id ASC";
    const rows = (
      excludeProbeId !== undefined
        ? this.db.prepare(sql).all(sourceMaterialId, excludeProbeId)
        : this.db.prepare(sql).all(sourceMaterialId)
    ) as Array<{ question: string }>;
    return rows.map((r) => r.question);
  }

  countProbesByType(statuses: readonly ProbeStatus[] = ["accepted"]): Record<string, number> {
    if (statuses.length === 0) return {};
    const rows = this.db
      .prepare(
        `SELECT probe_type, count(*) AS c FROM probes
         WHERE status IN (${statuses.map(() => "?").join(", ")})
         GROUP BY probe_type`,
      )
      .all(...statuses) as Array<{ probe_type: string; c: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.probe_type] = Number(row.c);
    return out;
  }

  saveProbeTurn(input: SaveProbeTurnInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO probe_turns
         (probe_id, turn_no, expected_behavior, tactic, user_content, reference_answer, rubric_json, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(probe_id, turn_no) DO UPDATE SET
           expected_behavior = excluded.expected_behavior,
           tactic = excluded.tactic,
           user_content = excluded.user_content,
           reference_answer = excluded.reference_answer,
           rubric_json = excluded.rubric_json,
           attempts = excluded.attempts,
           created_at = excluded.created_at`,
      )
      .run(
        input.probeId,
        input.turnNo,
        input.expectedBehavior,
        input.tactic ?? null,
        input.userContent,
        input.referenceAnswer,
        JSON.stringify(input.rubric),
        input.attempts ?? 1,
        nowIso(),
      );
    return Number(res.lastInsertRowid);
  }

  listProbeTurns(probeId: number): ProbeTurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM probe_turns WHERE probe_id = ? ORDER BY turn_no ASC")
      .all(probeId) as Array<Record<string, unknown>>;
    return rows.map(mapTurnRow);
  }

  saveCalibration(input: {
    probeId: number;
    turnNo: number;
    bareModel: string;
    graderModel: string;
    bareAnswer: string;
    behaviorOk: boolean;
    score: number;
    detail: Record<string, unknown>;
    bareCallId?: number | null;
    graderCallId?: number | null;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO probe_calibrations
         (probe_id, turn_no, bare_model, grader_model, bare_answer, behavior_ok, score, detail_json, bare_call_id, grader_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(probe_id, turn_no, bare_model, grader_model) DO UPDATE SET
           bare_answer = excluded.bare_answer,
           behavior_ok = excluded.behavior_ok,
           score = excluded.score,
           detail_json = excluded.detail_json,
           bare_call_id = excluded.bare_call_id,
           grader_call_id = excluded.grader_call_id,
           created_at = excluded.created_at`,
      )
      .run(
        input.probeId,
        input.turnNo,
        input.bareModel,
        input.graderModel,
        input.bareAnswer,
        input.behaviorOk ? 1 : 0,
        input.score,
        JSON.stringify(input.detail),
        input.bareCallId ?? null,
        input.graderCallId ?? null,
        nowIso(),
      );
    return Number(res.lastInsertRowid);
  }

  listCalibrationsForProbe(
    probeId: number,
    filter?: { bareModel?: string; graderModel?: string },
  ): ProbeCalibrationRecord[] {
    const clauses = ["probe_id = ?"];
    const params: Array<string | number> = [probeId];
    if (filter?.bareModel !== undefined) {
      clauses.push("bare_model = ?");
      params.push(filter.bareModel);
    }
    if (filter?.graderModel !== undefined) {
      clauses.push("grader_model = ?");
      params.push(filter.graderModel);
    }
    const rows = this.db
      .prepare(`SELECT * FROM probe_calibrations WHERE ${clauses.join(" AND ")} ORDER BY turn_no ASC, id DESC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapCalibrationRow);
  }

  /** Returns the latest complete model-pair calibration set for a probe (ordered by turn_no). */
  listCompleteCalibrationsForProbe(probeId: number, expectedTurns: number): ProbeCalibrationRecord[] {
    const all = this.listCalibrationsForProbe(probeId);
    if (all.length === 0) return [];
    const byPair = new Map<string, ProbeCalibrationRecord[]>();
    for (const cal of all) {
      const key = `${cal.bareModel}\0${cal.graderModel}`;
      const list = byPair.get(key);
      if (list) list.push(cal);
      else byPair.set(key, [cal]);
    }
    let best: ProbeCalibrationRecord[] = [];
    let bestMaxId = -1;
    for (const list of byPair.values()) {
      const uniqueTurns = new Map<number, ProbeCalibrationRecord>();
      for (const cal of list) {
        if (!uniqueTurns.has(cal.turnNo)) uniqueTurns.set(cal.turnNo, cal);
      }
      if (uniqueTurns.size < expectedTurns) continue;
      const ordered = [...uniqueTurns.values()].sort((a, b) => a.turnNo - b.turnNo);
      const maxId = Math.max(...ordered.map((c) => c.id));
      if (maxId > bestMaxId) {
        bestMaxId = maxId;
        best = ordered;
      }
    }
    return best;
  }
}
