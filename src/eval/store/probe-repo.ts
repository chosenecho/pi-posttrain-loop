import type { DatabaseSync } from "node:sqlite";
import {
  nowIso,
  PROBE_TYPES,
  type CalibrationTurnRecord,
  type DifficultyLevel,
  type ExpectedBehavior,
  type ProbeAttemptRecord,
  type ProbeDialogueTurn,
  type ProbeRecord,
  type ProbeReviewRecord,
  type ProbeRunKind,
  type ProbeRunRecord,
  type ProbeRunStatus,
  type ProbeStatus,
  type ProbeType,
  type Row,
} from "./types.js";

const PROBE_SELECT = `
  SELECT p.*, s.run_id, s.source_material_id, s.slot_index, s.probe_type, s.persona, s.target_turns
  FROM probes p JOIN probe_specs s ON s.id = p.spec_id`;

function mapProbe(row: Row): ProbeRecord {
  return {
    id: Number(row.id),
    specId: Number(row.spec_id),
    runId: Number(row.run_id),
    sourceMaterialId: Number(row.source_material_id),
    slotIndex: Number(row.slot_index),
    probeType: row.probe_type as ProbeType,
    persona: String(row.persona),
    targetTurns: Number(row.target_turns),
    question: String(row.question),
    anchor: String(row.anchor),
    trap: String(row.trap),
    expectedBehavior: row.expected_behavior as ExpectedBehavior,
    status: row.status as ProbeStatus,
    anchorVerified: Number(row.anchor_verified) === 1,
    revisions: Number(row.revisions),
    rejectReason: row.reject_reason === null ? null : String(row.reject_reason),
    difficulty: row.difficulty === null ? null : (row.difficulty as DifficultyLevel),
  };
}

function mapCalibration(row: Row): CalibrationTurnRecord {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    probeId: Number(row.probe_id),
    turnNo: Number(row.turn_no),
    bareModel: String(row.bare_model),
    graderModel: String(row.grader_model),
    bareAnswer: row.bare_answer === null ? null : String(row.bare_answer),
    behaviorOk: Number(row.behavior_ok) === 1,
    stance: Number(row.stance),
    keyPointCoverage: Number(row.key_point_coverage),
    forbiddenHits: Number(row.forbidden_hits),
    hallucinationHits: Number(row.hallucination_hits),
    failureSignalHits: Number(row.failure_signal_hits),
    style: Number(row.style),
    score: Number(row.score),
    detail: row.detail_json === null ? null : (JSON.parse(String(row.detail_json)) as Record<string, unknown>),
    createdAt: String(row.created_at),
  };
}

export class EvalProbeRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hasTable: (name: string) => boolean,
  ) {}

  // ---------- runs & calls ----------

  createRun(input: {
    kind: ProbeRunKind;
    config: Record<string, unknown>;
    prompts: Record<string, unknown>;
    skills: unknown[];
  }): number {
    const result = this.db.prepare(`
      INSERT INTO probe_runs (kind, status, config_json, prompts_json, skills_json, started_at)
      VALUES (?, 'running', ?, ?, ?, ?)
    `).run(input.kind, JSON.stringify(input.config), JSON.stringify(input.prompts), JSON.stringify(input.skills), nowIso());
    return Number(result.lastInsertRowid);
  }

  finishRun(runId: number, status: ProbeRunStatus, error?: string): void {
    this.db.prepare("UPDATE probe_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(status, nowIso(), error ?? null, runId);
  }

  markInterruptedRuns(): number {
    const now = nowIso();
    this.db.prepare("UPDATE agent_calls SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now);
    const probeRes = this.db.prepare("UPDATE probe_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now);
    const evalRes = this.hasTable("eval_runs")
      ? this.db.prepare("UPDATE eval_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now)
      : { changes: 0 };
    return Number(probeRes.changes) + Number(evalRes.changes);
  }

  latestRunId(kind = "probe_build"): number | undefined {
    const row = this.db.prepare("SELECT id FROM probe_runs WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind) as Row | undefined;
    return row ? Number(row.id) : undefined;
  }

  listActiveRuns(kinds?: readonly ProbeRunKind[]): Array<{ id: number; kind: string; startedAt: string }> {
    const rows = kinds && kinds.length > 0
      ? (this.db.prepare(
          `SELECT id, kind, started_at FROM probe_runs WHERE status = 'running' AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id`,
        ).all(...kinds) as Row[])
      : (this.db.prepare("SELECT id, kind, started_at FROM probe_runs WHERE status = 'running' ORDER BY id").all() as Row[]);
    return rows.map((row) => ({
      id: Number(row.id),
      kind: String(row.kind),
      startedAt: String(row.started_at),
    }));
  }

  getRun(runId: number): ProbeRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM probe_runs WHERE id = ?").get(runId) as Row | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      kind: String(row.kind),
      status: row.status as ProbeRunStatus,
      config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
      skills: JSON.parse(String(row.skills_json)) as unknown[],
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      error: row.error === null ? null : String(row.error),
    };
  }

  startCall(input: { runRef: string; role: string; model: string; inputRefs: unknown }): number {
    const result = this.db.prepare(`
      INSERT INTO agent_calls (run_ref, role, model, input_refs_json, status, started_at)
      VALUES (?, ?, ?, ?, 'running', ?)
    `).run(input.runRef, input.role, input.model, JSON.stringify(input.inputRefs ?? {}), nowIso());
    return Number(result.lastInsertRowid);
  }

  finishCall(callId: number, outcome: { output?: string; error?: string }): void {
    this.db.prepare("UPDATE agent_calls SET status = ?, output_text = ?, error = ?, finished_at = ? WHERE id = ?").run(
      outcome.error !== undefined ? "error" : "completed",
      outcome.output ?? null,
      outcome.error ?? null,
      nowIso(),
      callId,
    );
  }

  countAgentCalls(runRef: string, role?: string): number {
    const row = role !== undefined
      ? (this.db.prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ? AND role = ?").get(runRef, role) as Row)
      : (this.db.prepare("SELECT count(*) AS c FROM agent_calls WHERE run_ref = ?").get(runRef) as Row);
    return Number(row.c);
  }

  // ---------- specs & probes ----------

  countAcceptedProbesByType(): Record<ProbeType, number> {
    const counts = Object.fromEntries(PROBE_TYPES.map((t) => [t, 0])) as Record<ProbeType, number>;
    const rows = this.db.prepare(`
      SELECT s.probe_type, count(*) AS c
      FROM probes p JOIN probe_specs s ON s.id = p.spec_id
      WHERE p.status = 'accepted'
      GROUP BY s.probe_type
    `).all() as Row[];
    for (const row of rows) {
      const pt = String(row.probe_type) as ProbeType;
      if (pt in counts) counts[pt] = Number(row.c);
    }
    return counts;
  }

  createSpec(input: {
    runId: number;
    sourceMaterialId: number;
    slotIndex: number;
    probeType: ProbeType;
    persona: string;
    targetTurns: number;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO probe_specs (run_id, source_material_id, slot_index, probe_type, persona, target_turns)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.runId, input.sourceMaterialId, input.slotIndex, input.probeType, input.persona, input.targetTurns);
    return Number(result.lastInsertRowid);
  }

  createProbe(input: {
    specId: number;
    question: string;
    anchor: string;
    trap: string;
    expectedBehavior: ExpectedBehavior;
    anchorVerified: boolean;
  }): number {
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO probes (spec_id, question, anchor, trap, expected_behavior, status, anchor_verified, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'drafted', ?, ?, ?)
    `).run(input.specId, input.question, input.anchor, input.trap, input.expectedBehavior, input.anchorVerified ? 1 : 0, now, now);
    return Number(result.lastInsertRowid);
  }

  updateSpec(
    specId: number,
    input: {
      probeType: ProbeType;
      persona: string;
      targetTurns: number;
    },
  ): void {
    this.db.prepare(`
      UPDATE probe_specs SET probe_type = ?, persona = ?, target_turns = ?
      WHERE id = ?
    `).run(input.probeType, input.persona, input.targetTurns, specId);
  }

  reviseProbe(
    probeId: number,
    input: {
      question: string;
      anchor: string;
      trap: string;
      anchorVerified: boolean;
      expectedBehavior?: ExpectedBehavior;
    },
  ): void {
    if (input.expectedBehavior !== undefined) {
      this.db.prepare(`
        UPDATE probes SET question = ?, anchor = ?, trap = ?, expected_behavior = ?, anchor_verified = ?, revisions = revisions + 1, status = 'drafted', updated_at = ?
        WHERE id = ?
      `).run(input.question, input.anchor, input.trap, input.expectedBehavior, input.anchorVerified ? 1 : 0, nowIso(), probeId);
      return;
    }
    this.db.prepare(`
      UPDATE probes SET question = ?, anchor = ?, trap = ?, anchor_verified = ?, revisions = revisions + 1, status = 'drafted', updated_at = ?
      WHERE id = ?
    `).run(input.question, input.anchor, input.trap, input.anchorVerified ? 1 : 0, nowIso(), probeId);
  }

  setProbeStatus(probeId: number, status: ProbeStatus, rejectReason?: string): void {
    this.db.prepare("UPDATE probes SET status = ?, reject_reason = COALESCE(?, reject_reason), updated_at = ? WHERE id = ?")
      .run(status, rejectReason ?? null, nowIso(), probeId);
  }

  setProbeDifficulty(probeId: number, difficulty: DifficultyLevel): void {
    this.db.prepare("UPDATE probes SET difficulty = ?, updated_at = ? WHERE id = ?")
      .run(difficulty, nowIso(), probeId);
  }

  getProbe(probeId: number): ProbeRecord | undefined {
    const row = this.db.prepare(`${PROBE_SELECT} WHERE p.id = ?`).get(probeId) as Row | undefined;
    return row ? mapProbe(row) : undefined;
  }

  listProbes(filter: {
    runId?: number;
    status?: ProbeStatus;
    probeType?: ProbeType;
    probeTypes?: readonly ProbeType[];
    onlyUncalibrated?: boolean;
  } = {}): ProbeRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.runId !== undefined) { where.push("s.run_id = ?"); params.push(filter.runId); }
    if (filter.status !== undefined) { where.push("p.status = ?"); params.push(filter.status); }
    if (filter.probeType !== undefined) { where.push("s.probe_type = ?"); params.push(filter.probeType); }
    if (filter.probeTypes !== undefined && filter.probeTypes.length > 0) {
      where.push(`s.probe_type IN (${filter.probeTypes.map(() => "?").join(", ")})`);
      params.push(...filter.probeTypes);
    }
    if (filter.onlyUncalibrated) { where.push("p.difficulty IS NULL"); }
    const sql = `${PROBE_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY s.run_id, s.source_material_id, s.slot_index`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapProbe);
  }

  // ---------- reviews, turns, attempts, rubrics ----------

  addReview(input: {
    probeId: number;
    roundNo: number;
    decision: "accept" | "revise" | "reject";
    issues: string[];
    feedback: string;
    questionSnapshot: string;
    callId: number | null;
  }): void {
    this.db.prepare(`
      INSERT INTO probe_reviews (probe_id, round_no, decision, issues_json, feedback, question_snapshot, call_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.probeId, input.roundNo, input.decision, JSON.stringify(input.issues), input.feedback, input.questionSnapshot, input.callId, nowIso());
  }

  listReviews(probeId: number): ProbeReviewRecord[] {
    return (this.db.prepare("SELECT * FROM probe_reviews WHERE probe_id = ? ORDER BY round_no").all(probeId) as Row[]).map((row) => ({
      id: Number(row.id),
      roundNo: Number(row.round_no),
      decision: row.decision as "accept" | "revise" | "reject",
      issues: JSON.parse(String(row.issues_json)) as string[],
      feedback: String(row.feedback),
      questionSnapshot: String(row.question_snapshot),
      callId: row.call_id === null ? null : Number(row.call_id),
      createdAt: String(row.created_at),
    }));
  }

  createTurn(input: { probeId: number; turnNo: number; userContent: string; expectedBehavior: ExpectedBehavior; tactic?: string }): number {
    const result = this.db.prepare(`
      INSERT INTO probe_turns (probe_id, turn_no, user_content, tactic, expected_behavior, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).run(input.probeId, input.turnNo, input.userContent, input.tactic ?? null, input.expectedBehavior);
    return Number(result.lastInsertRowid);
  }

  finishTurn(turnId: number, status: "pass" | "dropped" | "exhausted" | "error", passedAttemptId?: number): void {
    this.db.prepare("UPDATE probe_turns SET status = ?, passed_attempt_id = ? WHERE id = ?").run(status, passedAttemptId ?? null, turnId);
  }

  addAttempt(input: { turnId: number; attemptNo: number; answer: string; answerCallId: number | null }): number {
    const result = this.db.prepare(`
      INSERT INTO probe_attempts (turn_id, attempt_no, answer, answer_call_id) VALUES (?, ?, ?, ?)
    `).run(input.turnId, input.attemptNo, input.answer, input.answerCallId);
    return Number(result.lastInsertRowid);
  }

  reviewAttempt(attemptId: number, input: { decision: "pass" | "revise" | "drop"; issues: string[]; feedback: string; verifyCallId: number | null }): void {
    this.db.prepare("UPDATE probe_attempts SET decision = ?, issues_json = ?, feedback = ?, verify_call_id = ? WHERE id = ?")
      .run(input.decision, JSON.stringify(input.issues), input.feedback, input.verifyCallId, attemptId);
  }

  listAttemptsForProbe(probeId: number): ProbeAttemptRecord[] {
    const rows = this.db.prepare(`
      SELECT t.turn_no, a.attempt_no, a.answer, a.decision, a.issues_json, a.feedback
      FROM probe_turns t
      JOIN probe_attempts a ON a.turn_id = t.id
      WHERE t.probe_id = ?
      ORDER BY t.turn_no, a.attempt_no
    `).all(probeId) as Row[];
    return rows.map((row) => ({
      turnNo: Number(row.turn_no),
      attemptNo: Number(row.attempt_no),
      answer: row.answer === null ? null : String(row.answer),
      decision: row.decision === null ? null : (row.decision as "pass" | "revise" | "drop"),
      issues: row.issues_json === null ? [] : (JSON.parse(String(row.issues_json)) as string[]),
      feedback: row.feedback === null ? null : String(row.feedback),
    }));
  }

  saveRubric(input: { turnId: number; rubric: unknown; callId: number | null }): void {
    this.db.prepare(`
      INSERT INTO probe_rubrics (turn_id, rubric_json, call_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET rubric_json = excluded.rubric_json, call_id = excluded.call_id, created_at = excluded.created_at
    `).run(input.turnId, JSON.stringify(input.rubric), input.callId, nowIso());
  }

  getProbeDialogue(probeId: number): ProbeDialogueTurn[] {
    const rows = this.db.prepare(`
      SELECT t.turn_no, t.user_content, t.expected_behavior, t.tactic, a.answer, r.rubric_json
      FROM probe_turns t
      JOIN probe_attempts a ON a.id = t.passed_attempt_id
      LEFT JOIN probe_rubrics r ON r.turn_id = t.id
      WHERE t.probe_id = ? AND t.status = 'pass'
      ORDER BY t.turn_no
    `).all(probeId) as Row[];
    return rows.map((row) => ({
      turnNo: Number(row.turn_no),
      user: String(row.user_content),
      answer: String(row.answer),
      expectedBehavior: row.expected_behavior as ExpectedBehavior,
      tactic: row.tactic === null ? null : String(row.tactic),
      rubric: row.rubric_json === null ? null : JSON.parse(String(row.rubric_json)),
    }));
  }

  // ---------- calibrations ----------

  saveCalibration(input: {
    runId: number;
    probeId: number;
    turnNo: number;
    bareModel: string;
    graderModel: string;
    bareAnswer: string;
    behaviorOk: boolean;
    stance: number;
    keyPointCoverage: number;
    forbiddenHits: number;
    hallucinationHits: number;
    failureSignalHits: number;
    style: number;
    score: number;
    detail: Record<string, unknown>;
    bareCallId: number | null;
    gradeCallId: number | null;
  }): void {
    this.db.prepare(`
      INSERT INTO probe_calibrations (
        run_id, probe_id, turn_no, bare_model, grader_model, bare_answer,
        behavior_ok, stance, key_point_coverage, forbidden_hits, hallucination_hits,
        failure_signal_hits, style, score, detail_json, bare_call_id, grade_call_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, probe_id, turn_no) DO UPDATE SET
        bare_answer = excluded.bare_answer,
        behavior_ok = excluded.behavior_ok,
        stance = excluded.stance,
        key_point_coverage = excluded.key_point_coverage,
        forbidden_hits = excluded.forbidden_hits,
        hallucination_hits = excluded.hallucination_hits,
        failure_signal_hits = excluded.failure_signal_hits,
        style = excluded.style,
        score = excluded.score,
        detail_json = excluded.detail_json,
        bare_call_id = excluded.bare_call_id,
        grade_call_id = excluded.grade_call_id,
        created_at = excluded.created_at
    `).run(
      input.runId,
      input.probeId,
      input.turnNo,
      input.bareModel,
      input.graderModel,
      input.bareAnswer,
      input.behaviorOk ? 1 : 0,
      input.stance,
      input.keyPointCoverage,
      input.forbiddenHits,
      input.hallucinationHits,
      input.failureSignalHits,
      input.style,
      input.score,
      JSON.stringify(input.detail),
      input.bareCallId,
      input.gradeCallId,
      nowIso(),
    );
  }

  listCalibrationsForProbe(probeId: number, runId?: number): CalibrationTurnRecord[] {
    if (!this.hasTable("probe_calibrations")) return [];
    const effectiveRunId = runId ?? (() => {
      const row = this.db.prepare(
        "SELECT run_id FROM probe_calibrations WHERE probe_id = ? ORDER BY run_id DESC LIMIT 1",
      ).get(probeId) as Row | undefined;
      return row ? Number(row.run_id) : undefined;
    })();
    if (effectiveRunId === undefined) return [];
    return (this.db.prepare(
      "SELECT * FROM probe_calibrations WHERE probe_id = ? AND run_id = ? ORDER BY turn_no",
    ).all(probeId, effectiveRunId) as Row[]).map(mapCalibration);
  }

  listCompleteCalibrationsForProbe(probeId: number, expectedTurns: number, runId?: number): CalibrationTurnRecord[] {
    if (!this.hasTable("probe_calibrations")) return [];
    if (runId !== undefined) {
      return this.listCalibrationsForProbe(probeId, runId);
    }
    const row = this.db.prepare(`
      SELECT run_id
      FROM probe_calibrations
      WHERE probe_id = ?
      GROUP BY run_id
      HAVING count(*) >= ?
      ORDER BY run_id DESC
      LIMIT 1
    `).get(probeId, expectedTurns) as Row | undefined;
    if (!row) return this.listCalibrationsForProbe(probeId);
    return this.listCalibrationsForProbe(probeId, Number(row.run_id));
  }

  listCalibrationsForRun(runId: number): CalibrationTurnRecord[] {
    if (!this.hasTable("probe_calibrations")) return [];
    return (this.db.prepare(
      "SELECT * FROM probe_calibrations WHERE run_id = ? ORDER BY probe_id, turn_no",
    ).all(runId) as Row[]).map(mapCalibration);
  }

  // ---------- summary ----------

  getCountsSummary(): {
    probeRuns: number;
    agentCalls: number;
    probesByStatus: Record<string, number>;
    acceptedByType: Record<string, number>;
    acceptedByDifficulty: Record<string, number>;
  } {
    const probeRuns = Number((this.db.prepare("SELECT count(*) AS c FROM probe_runs").get() as Row).c);
    const agentCalls = Number((this.db.prepare("SELECT count(*) AS c FROM agent_calls").get() as Row).c);
    const probesByStatus: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT status, count(*) AS c FROM probes GROUP BY status ORDER BY status").all() as Row[]) {
      probesByStatus[String(row.status)] = Number(row.c);
    }
    const acceptedByType: Record<string, number> = {};
    for (const row of this.db.prepare(`
      SELECT s.probe_type, count(*) AS c
      FROM probes p JOIN probe_specs s ON s.id = p.spec_id
      WHERE p.status = 'accepted'
      GROUP BY s.probe_type ORDER BY s.probe_type
    `).all() as Row[]) {
      acceptedByType[String(row.probe_type)] = Number(row.c);
    }
    const acceptedByDifficulty: Record<string, number> = {};
    for (const row of this.db.prepare(`
      SELECT COALESCE(difficulty, 'uncalibrated') AS d, count(*) AS c
      FROM probes
      WHERE status = 'accepted'
      GROUP BY COALESCE(difficulty, 'uncalibrated')
      ORDER BY d
    `).all() as Row[]) {
      acceptedByDifficulty[String(row.d)] = Number(row.c);
    }
    return { probeRuns, agentCalls, probesByStatus, acceptedByType, acceptedByDifficulty };
  }
}
