import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateMaxTurns } from "../../shared/schema.js";
import type { DatasetSplit, Review, SplitAssignMethod, ToolStep } from "../../shared/types.js";
import { createSeededRng, extractVideoKey, normalizeText, nowIso, sha256Hex } from "../../shared/utils.js";
import { CorpusRepository } from "./corpus-repo.js";
import { ExportRepository } from "./export-repo.js";
import { RunRepository } from "./run-repo.js";
import {
  LEGACY_DROP_SQL,
  SCHEMA_SQL,
  formatSamplesJsonl,
  type AttemptStatus,
  type CallRole,
  type CallStatus,
  type CreateRunInput,
  type DedupPolicy,
  type ExportOptions,
  type IntegrityReport,
  type InterruptedCounts,
  type MaterialRecord,
  type MergedExportOptions,
  type MergedExportRecord,
  type MergedExportResult,
  type QuestionRecord,
  type ResultTurnRow,
  type RunItemStatus,
  type RunKind,
  type RunRecord,
  type RunStatus,
  type TargetQuestionRow,
  type TrainingMessage,
  type TrainingSampleLine,
  type TurnStatus,
  type VideoSplitRecord,
} from "./schema-sql.js";

export {
  createSeededRng,
  extractVideoKey,
  formatSamplesJsonl,
  normalizeText,
  sha256Hex,
  validateMaxTurns,
  type AttemptStatus,
  type CallRole,
  type CallStatus,
  type CreateRunInput,
  type DedupPolicy,
  type ExportOptions,
  type IntegrityReport,
  type InterruptedCounts,
  type MaterialRecord,
  type MergedExportOptions,
  type MergedExportRecord,
  type MergedExportResult,
  type QuestionRecord,
  type ResultTurnRow,
  type RunItemStatus,
  type RunKind,
  type RunRecord,
  type RunStatus,
  type TargetQuestionRow,
  type TrainingMessage,
  type TrainingSampleLine,
  type TurnStatus,
  type VideoSplitRecord,
};

/**
 * Unified SQLite store facade backed by modular corpus, run, and export repositories.
 * Production code uses named methods exclusively; `db` is exposed only for low-level test inspection.
 */
export class DataMakerStore {
  /** @internal Low-level connection handle (do not write raw SQL from production business modules). */
  readonly db: DatabaseSync;
  private txDepth = 0;
  readonly corpus: CorpusRepository;
  readonly runs: RunRepository;
  readonly exports: ExportRepository;

  constructor(databasePath: string, options: { readOnly?: boolean; busyTimeoutMs?: number } = {}) {
    if (!options.readOnly && databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath, { readOnly: options.readOnly ?? false });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
    if (!options.readOnly) {
      if (databasePath !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL;");
      }
      this.db.exec(SCHEMA_SQL);
      this.db.exec(LEGACY_DROP_SQL);
      this.ensureQuestionsColumns();
    }

    const hasTable = (name: string) => this.hasTable(name);
    const tx = <T>(fn: () => T) => this.transaction(fn);
    this.corpus = new CorpusRepository(this.db, hasTable);
    this.runs = new RunRepository(this.db, tx, hasTable, this.corpus);
    this.exports = new ExportRepository(this.db, hasTable, this.corpus, this.runs);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    const depth = this.txDepth++;
    const savepoint = `sp_${depth}`;
    if (depth === 0) {
      this.db.exec("BEGIN IMMEDIATE");
    } else {
      this.db.exec(`SAVEPOINT ${savepoint}`);
    }
    try {
      const value = fn();
      if (depth === 0) {
        this.db.exec("COMMIT");
      } else {
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return value;
    } catch (error) {
      if (depth === 0) {
        this.db.exec("ROLLBACK");
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.txDepth--;
    }
  }

  checkIntegrity(): IntegrityReport {
    const foreignKeyViolations = this.db.prepare("PRAGMA foreign_key_check").all();
    const integrityRows = this.db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const integrityCheck = integrityRows.map((row) => String(row.integrity_check));
    return {
      foreignKeyViolations,
      integrityCheck,
      ok: foreignKeyViolations.length === 0 && integrityCheck.length === 1 && integrityCheck[0] === "ok",
    };
  }

  hasTable(name: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name);
    return row !== undefined;
  }

  private ensureQuestionsColumns(): void {
    if (!this.hasTable("questions")) return;
    const cols = this.db.prepare("PRAGMA table_info(questions)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("question_mode")) {
      this.db.exec(
        "ALTER TABLE questions ADD COLUMN question_mode TEXT NOT NULL DEFAULT 'direct' CHECK(question_mode IN ('direct', 'todo_plan', 'clarify_question'))",
      );
    }
    if (!names.has("task_spec_json")) {
      this.db.exec(
        "ALTER TABLE questions ADD COLUMN task_spec_json TEXT CHECK(task_spec_json IS NULL OR (json_valid(task_spec_json) AND json_type(task_spec_json) = 'object'))",
      );
    }
  }

  // --- Corpus / Splits / Questions ---

  getVideoSplit(videoIdOrKey: string): VideoSplitRecord | undefined {
    return this.corpus.getVideoSplit(videoIdOrKey);
  }

  listVideoSplits(split?: DatasetSplit): VideoSplitRecord[] {
    return this.corpus.listVideoSplits(split);
  }

  assignVideoSplit(input: {
    videoKey: string;
    split: DatasetSplit;
    method: SplitAssignMethod;
    salt?: string;
    assignedAt?: string;
  }): VideoSplitRecord {
    return this.corpus.assignVideoSplit(input);
  }

  getMaterialVideoAndSplitMap(): Map<number, { videoKey: string; videoId: string; split: DatasetSplit }> {
    return this.corpus.getMaterialVideoAndSplitMap();
  }

  upsertMaterial(input: { videoId: string; content: string; sourcePath?: string | null; createdAt?: string }): MaterialRecord {
    return this.corpus.upsertMaterial(input);
  }

  insertQuestion(input: {
    id?: number;
    materialId: number;
    question: string;
    generationRunId?: number | null;
    questionMode?: import("./schema-sql.js").QuestionMode;
    taskSpec?: import("./schema-sql.js").QuestionTaskSpec | null;
    createdAt?: string;
  }): { record: QuestionRecord; inserted: boolean } {
    return this.corpus.insertQuestion(input);
  }

  listProcessedVideoRows(profile?: string): Array<{ video_id: string; sha256: string }> {
    return this.corpus.listProcessedVideoRows(profile);
  }

  listMaterialIndex(): Array<{ id: number; video_id: string; sha256: string }> {
    return this.corpus.listMaterialIndex();
  }

  listAllMaterials(): Array<{ id: number; video_id: string; content: string; sha256: string; source_path: string | null }> {
    return this.corpus.listAllMaterials();
  }

  getMaterialSha256(materialId: number): string | undefined {
    return this.corpus.getMaterialSha256(materialId);
  }

  listQuestionIdsForMaterialRun(materialId: number, generationRunId: number): number[] {
    return this.corpus.listQuestionIdsForMaterialRun(materialId, generationRunId);
  }

  listAllQuestionsWithVideoId(): Array<{ question: string; video_id: string }> {
    return this.corpus.listAllQuestionsWithVideoId();
  }

  queryQuestionCountsByVideo(): Array<{ video_id: string; q_count: number }> {
    return this.corpus.queryQuestionCountsByVideo();
  }

  queryPassedResultCountsByVideo(): Array<{ video_id: string; pass_count: number }> {
    return this.corpus.queryPassedResultCountsByVideo();
  }

  // --- Runs / Dialogue State ---

  markInterruptedRuns(timestamp = nowIso()): InterruptedCounts {
    return this.runs.markInterruptedRuns(timestamp);
  }

  findRunByImportKey(importKey: string): RunRecord | undefined {
    return this.runs.findRunByImportKey(importKey);
  }

  createRun(input: CreateRunInput): number {
    return this.runs.createRun(input);
  }

  finishRun(runId: number, status: Exclude<RunStatus, "running">, options: { finishedAt?: string; error?: string | null } = {}): void {
    this.runs.finishRun(runId, status, options);
  }

  createRunItems(runId: number, questionIds: number[]): Map<number, number> {
    return this.runs.createRunItems(runId, questionIds);
  }

  startRunItem(runItemId: number, startedAt = nowIso()): void {
    this.runs.startRunItem(runItemId, startedAt);
  }

  finishRunItemNonPass(
    runItemId: number,
    status: "drop" | "exhausted" | "error" | "interrupted",
    options: { finishedAt?: string; error?: string | null } = {},
  ): void {
    this.runs.finishRunItemNonPass(runItemId, status, options);
  }

  createTurn(input: { runItemId: number; turnNo: number; userContent?: string | null; startedAt?: string }): number {
    return this.runs.createTurn(input);
  }

  finishTurnNonPass(
    turnId: number,
    status: "drop" | "exhausted" | "error" | "interrupted",
    options: { finishedAt?: string; error?: string | null } = {},
  ): void {
    this.runs.finishTurnNonPass(turnId, status, options);
  }

  startAttempt(input: { turnId: number; attemptNo: number; startedAt?: string }): number {
    return this.runs.startAttempt(input);
  }

  recordAttemptAnswer(attemptId: number, answer: string): void {
    this.runs.recordAttemptAnswer(attemptId, answer);
  }

  recordAttemptToolSteps(attemptId: number, steps: ToolStep[], createdAt = nowIso()): void {
    this.runs.recordAttemptToolSteps(attemptId, steps, createdAt);
  }

  queryAttemptToolStepsMap(attemptIds: number[]): Map<number, ToolStep[]> {
    return this.runs.queryAttemptToolStepsMap(attemptIds);
  }

  finishAttemptReview(attemptId: number, review: Review, finishedAt = nowIso()): void {
    this.runs.finishAttemptReview(attemptId, review, finishedAt);
  }

  finishAttemptError(attemptId: number, error: string, finishedAt = nowIso()): void {
    this.runs.finishAttemptError(attemptId, error, finishedAt);
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
    return this.runs.startModelCall(input);
  }

  getModelCallStatus(callId: number): string | undefined {
    return this.runs.getModelCallStatus(callId);
  }

  finishModelCall(callId: number, outputText: string, finishedAt = nowIso()): void {
    this.runs.finishModelCall(callId, outputText, finishedAt);
  }

  failModelCall(callId: number, error: string, options: { outputText?: string | null; finishedAt?: string } = {}): void {
    this.runs.failModelCall(callId, error, options);
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
    return this.runs.commitJudgeOutcome(input);
  }

  finalizePassedRunItem(runItemId: number, turnCount: number, finishedAt = nowIso()): number {
    return this.runs.finalizePassedRunItem(runItemId, turnCount, finishedAt);
  }

  queryTargetQuestions(filter: {
    videoId?: string;
    questionIds?: number[];
    onlyUnjudged?: boolean;
    maxTurns?: number;
    split?: DatasetSplit;
    generationProfile?: string;
  }): TargetQuestionRow[] {
    return this.runs.queryTargetQuestions(filter);
  }

  queryResultTurns(runId: number): ResultTurnRow[] {
    return this.runs.queryResultTurns(runId);
  }

  queryOutcomeCounts(runId: number): Record<string, number> {
    return this.runs.queryOutcomeCounts(runId);
  }

  // --- Exports ---

  exportRunSamples(runId: number, options: ExportOptions = {}): TrainingSampleLine[] {
    return this.exports.exportRunSamples(runId, options);
  }

  exportRunJsonl(runId: number, options: ExportOptions = {}): string {
    return this.exports.exportRunJsonl(runId, options);
  }

  exportMergedDataset(options: MergedExportOptions): MergedExportResult {
    return this.exports.exportMergedDataset(options);
  }
}
