import type { DatabaseSync } from "node:sqlite";
import { nonEmpty, validateMaxAttempts, validateMaxTurns, validateSplit } from "../../shared/schema.js";
import type { DatasetSplit, Review, ToolStep } from "../../shared/types.js";
import { nowIso } from "../../shared/utils.js";
import type { CorpusRepository } from "./corpus-repo.js";
import {
  assertArrayJson,
  assertObjectJson,
  type CallRole,
  type CreateRunInput,
  type InterruptedCounts,
  type ResultTurnRow,
  type RunRecord,
  type RunStatus,
  type TargetQuestionRow,
} from "./schema-sql.js";

export class RunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(fn: () => T) => T,
    private readonly hasTable: (name: string) => boolean,
    private readonly corpus: CorpusRepository,
  ) {}

  markInterruptedRuns(timestamp = nowIso()): InterruptedCounts {
    return this.transaction(() => {
      const modelCalls = Number(this.db.prepare(
        "UPDATE model_calls SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
      ).run(timestamp).changes);
      const attempts = Number(this.db.prepare(
        "UPDATE attempts SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
      ).run(timestamp).changes);
      const turns = Number(this.db.prepare(
        "UPDATE turns SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
      ).run(timestamp).changes);
      const runItems = Number(this.db.prepare(
        "UPDATE run_items SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
      ).run(timestamp).changes);
      const runs = Number(this.db.prepare(
        "UPDATE runs SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
      ).run(timestamp).changes);

      return { runs, runItems, turns, attempts, modelCalls };
    });
  }

  findRunByImportKey(importKey: string): RunRecord | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE import_key = ?").get(importKey) as unknown as RunRecord | undefined;
  }

  createRun(input: CreateRunInput): number {
    const maxAttempts = validateMaxAttempts(input.maxAttempts);
    const maxTurns = validateMaxTurns(input.maxTurns ?? 1);
    const info = this.db.prepare(`
      INSERT INTO runs (
        kind, status, started_at, finished_at, max_attempts, max_turns,
        config_json, prompts_json, skills_json, export_policy_json, import_key, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.kind,
      input.status ?? "running",
      input.startedAt ?? nowIso(),
      input.finishedAt ?? null,
      maxAttempts,
      maxTurns,
      assertObjectJson(input.config, "config"),
      assertObjectJson(input.prompts, "prompts"),
      assertArrayJson(input.skills, "skills"),
      assertObjectJson(input.exportPolicy, "exportPolicy"),
      input.importKey ?? null,
      input.error ?? null,
    );
    return Number(info.lastInsertRowid);
  }

  finishRun(runId: number, status: Exclude<RunStatus, "running">, options: { finishedAt?: string; error?: string | null } = {}): void {
    this.db.prepare(`
      UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?
    `).run(status, options.finishedAt ?? nowIso(), options.error ?? null, runId);
  }

  createRunItems(runId: number, questionIds: number[]): Map<number, number> {
    return this.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO run_items (run_id, question_id, status) VALUES (?, ?, 'pending')
      `);
      const map = new Map<number, number>();
      for (const questionId of questionIds) {
        const info = stmt.run(runId, questionId);
        map.set(questionId, Number(info.lastInsertRowid));
      }
      return map;
    });
  }

  startRunItem(runItemId: number, startedAt = nowIso()): void {
    this.db.prepare(`
      UPDATE run_items SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?
    `).run(startedAt, runItemId);
  }

  finishRunItemNonPass(
    runItemId: number,
    status: "drop" | "exhausted" | "error" | "interrupted",
    options: { finishedAt?: string; error?: string | null } = {},
  ): void {
    this.db.prepare(`
      UPDATE run_items SET status = ?, finished_at = ?, error = ? WHERE id = ?
    `).run(status, options.finishedAt ?? nowIso(), options.error ?? null, runItemId);
  }

  createTurn(input: {
    runItemId: number;
    turnNo: number;
    userContent?: string | null;
    startedAt?: string;
  }): number {
    const userContent = input.turnNo === 1
      ? null
      : nonEmpty(input.userContent, "turn user_content");
    if (input.turnNo === 1 && input.userContent !== undefined && input.userContent !== null) {
      throw new Error("turn_no = 1 的 user_content 必须留空，以 questions.question 为唯一事实源");
    }
    const info = this.db.prepare(`
      INSERT INTO turns (run_item_id, turn_no, user_content, status, passed_attempt_id, started_at)
      VALUES (?, ?, ?, 'running', NULL, ?)
    `).run(input.runItemId, input.turnNo, userContent, input.startedAt ?? nowIso());
    return Number(info.lastInsertRowid);
  }

  finishTurnNonPass(
    turnId: number,
    status: "drop" | "exhausted" | "error" | "interrupted",
    options: { finishedAt?: string; error?: string | null } = {},
  ): void {
    this.db.prepare(`
      UPDATE turns SET status = ?, finished_at = ?, error = ? WHERE id = ?
    `).run(status, options.finishedAt ?? nowIso(), options.error ?? null, turnId);
  }

  startAttempt(input: { turnId: number; attemptNo: number; startedAt?: string }): number {
    const info = this.db.prepare(`
      INSERT INTO attempts (turn_id, attempt_no, status, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(input.turnId, input.attemptNo, input.startedAt ?? nowIso());
    return Number(info.lastInsertRowid);
  }

  recordAttemptAnswer(attemptId: number, answer: string): void {
    const trimmed = nonEmpty(answer, "answer");
    this.db.prepare("UPDATE attempts SET answer = ? WHERE id = ?").run(trimmed, attemptId);
  }

  finishAttemptReview(attemptId: number, review: Review, finishedAt = nowIso()): void {
    this.db.prepare(`
      UPDATE attempts
      SET status = 'completed', decision = ?, issues_json = ?, feedback = ?, finished_at = ?
      WHERE id = ?
    `).run(review.decision, JSON.stringify(review.issues), review.feedback, finishedAt, attemptId);
  }

  finishAttemptError(attemptId: number, error: string, finishedAt = nowIso()): void {
    this.db.prepare(`
      UPDATE attempts SET status = 'error', error = ?, finished_at = ? WHERE id = ?
    `).run(error, finishedAt, attemptId);
  }

  startModelCall(input: {
    runId: number;
    role: CallRole;
    turnId?: number | null;
    attemptId?: number | null;
    materialId?: number | null;
    inputRefs: Record<string, unknown>;
    startedAt?: string;
  }): number {
    const info = this.db.prepare(`
      INSERT INTO model_calls (
        run_id, turn_id, attempt_id, material_id, role, status, input_refs_json, started_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      input.runId,
      input.turnId ?? null,
      input.attemptId ?? null,
      input.materialId ?? null,
      input.role,
      assertObjectJson(input.inputRefs, "inputRefs"),
      input.startedAt ?? nowIso(),
    );
    return Number(info.lastInsertRowid);
  }

  getModelCallStatus(callId: number): string | undefined {
    const row = this.db.prepare("SELECT status FROM model_calls WHERE id = ?").get(callId) as
      | { status: string }
      | undefined;
    return row?.status;
  }

  finishModelCall(callId: number, outputText: string, finishedAt = nowIso()): void {
    this.db.prepare(`
      UPDATE model_calls SET status = 'completed', output_text = ?, finished_at = ? WHERE id = ?
    `).run(outputText, finishedAt, callId);
  }

  failModelCall(callId: number, error: string, options: { outputText?: string | null; finishedAt?: string } = {}): void {
    this.db.prepare(`
      UPDATE model_calls
      SET status = 'error', error = ?, output_text = COALESCE(?, output_text), finished_at = ?
      WHERE id = ?
    `).run(error, options.outputText ?? null, options.finishedAt ?? nowIso(), callId);
  }

  commitJudgeOutcome(input: {
    runItemId: number;
    turnId: number;
    turnNo: number;
    attemptId: number;
    judgeCallId: number;
    judgeOutputText: string;
    review: Review;
    isFinalTurn: boolean;
    exhaustedBudget: boolean;
    finishedAt?: string;
  }): { resultId?: number } {
    const finishedAt = input.finishedAt ?? nowIso();
    return this.transaction(() => {
      this.finishModelCall(input.judgeCallId, input.judgeOutputText, finishedAt);
      this.finishAttemptReview(input.attemptId, input.review, finishedAt);

      if (input.review.decision === "pass") {
        this.db.prepare(`
          UPDATE turns SET status = 'pass', passed_attempt_id = ?, finished_at = ? WHERE id = ?
        `).run(input.attemptId, finishedAt, input.turnId);
        if (input.isFinalTurn) {
          this.db.prepare(`
            UPDATE run_items SET status = 'pass', finished_at = ? WHERE id = ?
          `).run(finishedAt, input.runItemId);
          const info = this.db.prepare(`
            INSERT INTO results (run_item_id, turn_count, created_at) VALUES (?, ?, ?)
          `).run(input.runItemId, input.turnNo, finishedAt);
          return { resultId: Number(info.lastInsertRowid) };
        }
        return {};
      }

      if (input.review.decision === "drop") {
        this.finishTurnNonPass(input.turnId, "drop", { finishedAt });
        this.finishRunItemNonPass(input.runItemId, "drop", { finishedAt });
        return {};
      }

      if (input.exhaustedBudget) {
        this.finishTurnNonPass(input.turnId, "exhausted", { finishedAt });
        this.finishRunItemNonPass(input.runItemId, "exhausted", { finishedAt });
      }
      return {};
    });
  }

  finalizePassedRunItem(runItemId: number, turnCount: number, finishedAt = nowIso()): number {
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE run_items SET status = 'pass', finished_at = ? WHERE id = ?
      `).run(finishedAt, runItemId);
      const info = this.db.prepare(`
        INSERT INTO results (run_item_id, turn_count, created_at) VALUES (?, ?, ?)
      `).run(runItemId, turnCount, finishedAt);
      return Number(info.lastInsertRowid);
    });
  }

  queryTargetQuestions(filter: {
    videoId?: string;
    questionIds?: number[];
    onlyUnjudged?: boolean;
    maxTurns?: number;
    split?: DatasetSplit;
    generationProfile?: string;
  }): TargetQuestionRow[] {
    const targetSplit = filter.split !== undefined ? validateSplit(filter.split) : undefined;
    let sql = `
      SELECT q.id, q.material_id, m.video_id, m.content, q.question
      FROM questions q
      JOIN materials m ON m.id = q.material_id
      LEFT JOIN runs gr ON gr.id = q.generation_run_id
    `;
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.videoId !== undefined) {
      clauses.push("m.video_id = ?");
      params.push(filter.videoId);
    }
    if (filter.questionIds !== undefined && filter.questionIds.length > 0) {
      clauses.push(`q.id IN (${filter.questionIds.map(() => "?").join(", ")})`);
      params.push(...filter.questionIds);
    }
    if (filter.generationProfile !== undefined) {
      clauses.push("LOWER(COALESCE(json_extract(gr.config_json, '$.profile'), 'standard')) = ?");
      params.push(filter.generationProfile.trim().toLowerCase());
    }
    if (filter.onlyUnjudged) {
      clauses.push(`NOT EXISTS (
        SELECT 1
        FROM run_items i
        JOIN runs r ON r.id = i.run_id
        WHERE i.question_id = q.id
          AND r.kind = 'answer_judge'
          AND r.max_turns = ?
          AND i.status IN ('pass', 'drop', 'exhausted')
      )`);
      params.push(filter.maxTurns ?? 1);
    }
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }
    sql += " ORDER BY q.material_id, q.id";

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      material_id: number;
      video_id: string;
      content: string;
      question: string;
    }>;

    const materialSplitMap = targetSplit !== undefined ? this.corpus.getMaterialVideoAndSplitMap() : undefined;

    return rows
      .filter((row) => {
        if (targetSplit === undefined || !materialSplitMap) return true;
        const matSplit = materialSplitMap.get(Number(row.material_id))?.split ?? "train";
        return matSplit === targetSplit;
      })
      .map((row) => ({
        id: Number(row.id),
        materialId: Number(row.material_id),
        videoId: row.video_id,
        materialContent: row.content,
        question: row.question,
      }));
  }

  queryResultTurns(runId: number): ResultTurnRow[] {
    return this.db.prepare(`
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
      WHERE i.run_id = ?
      ORDER BY q.id, t.turn_no
    `).all(runId) as unknown as ResultTurnRow[];
  }

  recordAttemptToolSteps(attemptId: number, steps: ToolStep[], createdAt = nowIso()): void {
    if (steps.length === 0) return;
    this.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO attempt_tool_steps (
          attempt_id, step_no, tool_name, arguments_json, tool_output, pre_call_thought, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const stepNo = Number.isInteger(step.stepNo) && step.stepNo >= 1 ? step.stepNo : i + 1;
        insert.run(
          attemptId,
          stepNo,
          nonEmpty(step.toolName, "toolName"),
          assertObjectJson(step.arguments, "toolStep.arguments"),
          step.toolOutput,
          step.preCallThought && step.preCallThought.trim() ? step.preCallThought.trim() : null,
          createdAt,
        );
      }
    });
  }

  queryAttemptToolStepsMap(attemptIds: number[]): Map<number, ToolStep[]> {
    const map = new Map<number, ToolStep[]>();
    if (attemptIds.length === 0 || !this.hasTable("attempt_tool_steps")) return map;
    const uniqueIds = [...new Set(attemptIds)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT attempt_id, step_no, tool_name, arguments_json, tool_output, pre_call_thought
      FROM attempt_tool_steps
      WHERE attempt_id IN (${placeholders})
      ORDER BY attempt_id, step_no
    `).all(...uniqueIds) as Array<{
      attempt_id: number;
      step_no: number;
      tool_name: string;
      arguments_json: string;
      tool_output: string;
      pre_call_thought: string | null;
    }>;

    for (const row of rows) {
      const attemptId = Number(row.attempt_id);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(row.arguments_json) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const step: ToolStep = {
        stepNo: Number(row.step_no),
        toolName: row.tool_name,
        arguments: args,
        toolOutput: row.tool_output,
        ...(row.pre_call_thought ? { preCallThought: row.pre_call_thought } : {}),
      };
      const list = map.get(attemptId);
      if (list) list.push(step);
      else map.set(attemptId, [step]);
    }
    return map;
  }

  queryOutcomeCounts(runId: number): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM run_items
      WHERE run_id = ?
      GROUP BY status
    `).all(runId) as Array<{ status: string; count: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }
}
