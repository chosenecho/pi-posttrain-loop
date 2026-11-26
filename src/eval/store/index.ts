import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EvalProbeRepository } from "./probe-repo.js";
import { EVAL_SCHEMA_SQL, migrateEvalSchema } from "./schema-sql.js";
import { EvalSourceRepository } from "./source-repo.js";
import { EvalSuiteRepository } from "./suite-eval-repo.js";
import {
  EVAL_SCHEMA_VERSION,
  nowIso,
  type CalibrationTurnRecord,
  type DifficultyLevel,
  type EvalHistoryMode,
  type EvalPredictionRecord,
  type EvalRunRecord,
  type EvalScoreRecord,
  type EvalStoreSummary,
  type EvalSuiteKind,
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
  type SourceMaterialRecord,
  type SuiteItemRecord,
  type SuiteVersionRecord,
} from "./types.js";

export * from "./types.js";

/**
 * Modular SQLite facade for `data/eval.sqlite`, backed by dedicated source, probe, and suite/eval repositories.
 * Production business modules use named methods exclusively; `db` is exposed only for low-level test inspection.
 */
export class EvalStore {
  /** @internal Low-level connection handle (do not write raw SQL from production business modules). */
  readonly db: DatabaseSync;
  private txDepth = 0;
  readonly sources: EvalSourceRepository;
  readonly probes: EvalProbeRepository;
  readonly suites: EvalSuiteRepository;

  constructor(databasePath: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly && databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath, { readOnly: options.readOnly ?? false });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");

    const hasTable = (name: string) => this.hasTable(name);
    const hasColumn = (table: string, column: string) => this.hasColumn(table, column);
    const tx = <T>(fn: () => T) => this.transaction(fn);

    if (!options.readOnly) {
      if (databasePath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(EVAL_SCHEMA_SQL);
      migrateEvalSchema(this.db, hasColumn, tx);
      this.setMeta("schema_version", EVAL_SCHEMA_VERSION);
      this.db.prepare("INSERT OR IGNORE INTO eval_meta (key, value) VALUES ('created_at', ?)").run(nowIso());
    }

    this.sources = new EvalSourceRepository(this.db);
    this.probes = new EvalProbeRepository(this.db, hasTable);
    this.suites = new EvalSuiteRepository(this.db, tx, hasTable, hasColumn);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    const depth = this.txDepth++;
    const savepoint = `eval_sp_${depth}`;
    if (depth === 0) {
      this.db.exec("BEGIN IMMEDIATE");
    } else {
      this.db.exec(`SAVEPOINT ${savepoint}`);
    }
    try {
      const result = fn();
      if (depth === 0) {
        this.db.exec("COMMIT");
      } else {
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return result;
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

  hasTable(name: string): boolean {
    const row = this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as Row | undefined;
    return row !== undefined;
  }

  hasColumn(table: string, column: string): boolean {
    if (!this.hasTable(table)) return false;
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return rows.some((r) => String(r.name) === column);
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO eval_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM eval_meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  getSummary(): EvalStoreSummary {
    const src = this.sources.countSummary();
    const probe = this.probes.getCountsSummary();
    return {
      schemaVersion: this.getMeta("schema_version"),
      mainDbPath: this.getMeta("main_db_path"),
      sourceMaterials: src.sourceMaterials,
      unbuiltSourceMaterials: src.unbuiltSourceMaterials,
      sourceVideoKeys: src.sourceVideoKeys,
      probeRuns: probe.probeRuns,
      probesByStatus: probe.probesByStatus,
      acceptedByType: probe.acceptedByType,
      acceptedByDifficulty: probe.acceptedByDifficulty,
      suites: this.suites.listSuites(),
      evalRuns: this.suites.listEvalRunSummaries(),
      agentCalls: probe.agentCalls,
    };
  }

  // ---------- source materials ----------

  insertSourceMaterial(input: Parameters<EvalSourceRepository["insertSourceMaterial"]>[0]): { record: SourceMaterialRecord; created: boolean } {
    return this.sources.insertSourceMaterial(input);
  }

  getSourceMaterialByVideoId(videoId: string): SourceMaterialRecord | undefined {
    return this.sources.getSourceMaterialByVideoId(videoId);
  }

  getSourceMaterial(id: number): SourceMaterialRecord | undefined {
    return this.sources.getSourceMaterial(id);
  }

  listSourceMaterials(): SourceMaterialRecord[] {
    return this.sources.listSourceMaterials();
  }

  listUnbuiltSourceMaterials(probeTypes?: readonly ProbeType[]): SourceMaterialRecord[] {
    return this.sources.listUnbuiltSourceMaterials(probeTypes);
  }

  listSourceMaterialsByVideoKeys(videoKeys: string[]): SourceMaterialRecord[] {
    return this.sources.listSourceMaterialsByVideoKeys(videoKeys);
  }

  listExistingQuestionsForVideoKey(videoKey: string): string[] {
    return this.sources.listExistingQuestionsForVideoKey(videoKey);
  }

  listEvalVideoKeys(): Set<string> {
    return this.sources.listEvalVideoKeys();
  }

  // ---------- probe runs, calls, specs, probes, turns, calibrations ----------

  createRun(input: { kind: ProbeRunKind; config: Record<string, unknown>; prompts: Record<string, unknown>; skills: unknown[] }): number {
    return this.probes.createRun(input);
  }

  finishRun(runId: number, status: ProbeRunStatus, error?: string): void {
    this.probes.finishRun(runId, status, error);
  }

  markInterruptedRuns(): number {
    return this.probes.markInterruptedRuns();
  }

  latestRunId(kind = "probe_build"): number | undefined {
    return this.probes.latestRunId(kind);
  }

  listActiveRuns(kinds?: readonly ProbeRunKind[]): Array<{ id: number; kind: string; startedAt: string }> {
    return this.probes.listActiveRuns(kinds);
  }

  countAcceptedProbesByType(): Record<ProbeType, number> {
    return this.probes.countAcceptedProbesByType();
  }

  getRun(runId: number): ProbeRunRecord | undefined {
    return this.probes.getRun(runId);
  }

  listReviews(probeId: number): ProbeReviewRecord[] {
    return this.probes.listReviews(probeId);
  }

  listAttemptsForProbe(probeId: number): ProbeAttemptRecord[] {
    return this.probes.listAttemptsForProbe(probeId);
  }

  startCall(input: { runRef: string; role: string; model: string; inputRefs: unknown }): number {
    return this.probes.startCall(input);
  }

  finishCall(callId: number, outcome: { output?: string; error?: string }): void {
    this.probes.finishCall(callId, outcome);
  }

  countAgentCalls(runRef: string, role?: string): number {
    return this.probes.countAgentCalls(runRef, role);
  }

  createSpec(input: Parameters<EvalProbeRepository["createSpec"]>[0]): number {
    return this.probes.createSpec(input);
  }

  createProbe(input: Parameters<EvalProbeRepository["createProbe"]>[0]): number {
    return this.probes.createProbe(input);
  }

  updateSpec(specId: number, input: Parameters<EvalProbeRepository["updateSpec"]>[1]): void {
    this.probes.updateSpec(specId, input);
  }

  reviseProbe(probeId: number, input: Parameters<EvalProbeRepository["reviseProbe"]>[1]): void {
    this.probes.reviseProbe(probeId, input);
  }

  setProbeStatus(probeId: number, status: ProbeStatus, rejectReason?: string): void {
    this.probes.setProbeStatus(probeId, status, rejectReason);
  }

  setProbeDifficulty(probeId: number, difficulty: DifficultyLevel): void {
    this.probes.setProbeDifficulty(probeId, difficulty);
  }

  getProbe(probeId: number): ProbeRecord | undefined {
    return this.probes.getProbe(probeId);
  }

  listProbes(filter: Parameters<EvalProbeRepository["listProbes"]>[0] = {}): ProbeRecord[] {
    return this.probes.listProbes(filter);
  }

  saveCalibration(input: Parameters<EvalProbeRepository["saveCalibration"]>[0]): void {
    this.probes.saveCalibration(input);
  }

  listCalibrationsForProbe(probeId: number, runId?: number): CalibrationTurnRecord[] {
    return this.probes.listCalibrationsForProbe(probeId, runId);
  }

  listCompleteCalibrationsForProbe(probeId: number, expectedTurns: number, runId?: number): CalibrationTurnRecord[] {
    return this.probes.listCompleteCalibrationsForProbe(probeId, expectedTurns, runId);
  }

  listCalibrationsForRun(runId: number): CalibrationTurnRecord[] {
    return this.probes.listCalibrationsForRun(runId);
  }

  addReview(input: Parameters<EvalProbeRepository["addReview"]>[0]): void {
    this.probes.addReview(input);
  }

  createTurn(input: { probeId: number; turnNo: number; userContent: string; expectedBehavior: ExpectedBehavior; tactic?: string }): number {
    return this.probes.createTurn(input);
  }

  finishTurn(turnId: number, status: "pass" | "dropped" | "exhausted" | "error", passedAttemptId?: number): void {
    this.probes.finishTurn(turnId, status, passedAttemptId);
  }

  addAttempt(input: Parameters<EvalProbeRepository["addAttempt"]>[0]): number {
    return this.probes.addAttempt(input);
  }

  reviewAttempt(attemptId: number, input: Parameters<EvalProbeRepository["reviewAttempt"]>[1]): void {
    this.probes.reviewAttempt(attemptId, input);
  }

  saveRubric(input: Parameters<EvalProbeRepository["saveRubric"]>[0]): void {
    this.probes.saveRubric(input);
  }

  getProbeDialogue(probeId: number): ProbeDialogueTurn[] {
    return this.probes.getProbeDialogue(probeId);
  }

  // ---------- suites & candidate eval runs ----------

  getSuite(name: string): SuiteVersionRecord | undefined {
    return this.suites.getSuite(name);
  }

  getSuiteById(id: number): SuiteVersionRecord | undefined {
    return this.suites.getSuiteById(id);
  }

  listSuites(): Array<{ name: string; kind: string; itemCount: number; sha256: string; createdAt: string }> {
    return this.suites.listSuites();
  }

  freezeSuite(input: Parameters<EvalSuiteRepository["freezeSuite"]>[0]): { created: boolean; suite: SuiteVersionRecord } {
    return this.suites.freezeSuite(input);
  }

  listSuiteItems(name: string): SuiteItemRecord[] {
    return this.suites.listSuiteItems(name);
  }

  listSuiteItemsBySuiteId(suiteId: number): SuiteItemRecord[] {
    return this.suites.listSuiteItemsBySuiteId(suiteId);
  }

  createEvalRun(input: Parameters<EvalSuiteRepository["createEvalRun"]>[0]): number {
    return this.suites.createEvalRun(input);
  }

  reopenEvalRun(evalRunId: number, configPatch?: Record<string, unknown>): void {
    this.suites.reopenEvalRun(evalRunId, configPatch);
  }

  finishEvalRun(evalRunId: number, status: ProbeRunStatus, error?: string): void {
    this.suites.finishEvalRun(evalRunId, status, error);
  }

  getEvalRun(evalRunId: number): EvalRunRecord | undefined {
    return this.suites.getEvalRun(evalRunId);
  }

  listEvalRuns(filter: Parameters<EvalSuiteRepository["listEvalRuns"]>[0] = {}): EvalRunRecord[] {
    return this.suites.listEvalRuns(filter);
  }

  latestEvalRunId(filter: { suiteName?: string; candidate?: string; historyMode?: EvalHistoryMode } = {}): number | undefined {
    return this.suites.latestEvalRunId(filter);
  }

  saveEvalPrediction(input: Parameters<EvalSuiteRepository["saveEvalPrediction"]>[0]): number {
    return this.suites.saveEvalPrediction(input);
  }

  listEvalPredictions(evalRunId: number): EvalPredictionRecord[] {
    return this.suites.listEvalPredictions(evalRunId);
  }

  saveEvalScore(input: Parameters<EvalSuiteRepository["saveEvalScore"]>[0]): void {
    this.suites.saveEvalScore(input);
  }

  listEvalScores(evalRunId: number): EvalScoreRecord[] {
    return this.suites.listEvalScores(evalRunId);
  }
}
