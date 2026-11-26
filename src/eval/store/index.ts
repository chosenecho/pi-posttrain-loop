import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../shared/utils.js";
import { EvalProbeRepo } from "./probe-repo.js";
import { ensureEvalSchemaV3 } from "./schema-sql.js";
import { EvalSourceRepo } from "./source-repo.js";
import { EvalSuiteAndRunRepo } from "./suite-eval-repo.js";
import {
  EVAL_SCHEMA_VERSION,
  type CreateProbeInput,
  type DifficultyLevel,
  type EvalHistoryMode,
  type EvalPredictionRecord,
  type EvalRunRecord,
  type EvalScoreRecord,
  type EvalStoreSummary,
  type InsertSourceMaterialInput,
  type ProbeCalibrationRecord,
  type ProbeRecord,
  type ProbeReviewEntry,
  type ProbeRunKind,
  type ProbeRunRecord,
  type ProbeStatus,
  type ProbeTurnRecord,
  type ProbeType,
  type RunLifecycleStatus,
  type SaveProbeTurnInput,
  type SourceMaterialRecord,
  type StartAgentCallInput,
  type SuiteItemRecord,
  type SuiteRubricEntry,
  type SuiteVersionRecord,
} from "./types.js";

export * from "./types.js";

export class EvalStore {
  readonly db: DatabaseSync;
  readonly path: string;
  private readonly sources: EvalSourceRepo;
  private readonly probesRepo: EvalProbeRepo;
  private readonly suitesRepo: EvalSuiteAndRunRepo;

  constructor(dbPath: string, options: { readOnly?: boolean } = {}) {
    this.path = dbPath;
    if (dbPath !== ":memory:" && !options.readOnly) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = options.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
    try {
      if (!options.readOnly) {
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      }
      ensureEvalSchemaV3(this.db, Boolean(options.readOnly));
    } catch (error) {
      this.db.close();
      throw error;
    }

    this.sources = new EvalSourceRepo(this.db);
    this.probesRepo = new EvalProbeRepo(this.db);
    this.suitesRepo = new EvalSuiteAndRunRepo(this.db, (fn) => this.transaction(fn));
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM eval_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO eval_meta (key, value) VALUES (?, ?)").run(key, value);
  }

  markInterruptedRuns(): number {
    const now = nowIso();
    const r1 = this.db
      .prepare("UPDATE probe_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
      .run(now);
    const r2 = this.db
      .prepare("UPDATE eval_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
      .run(now);
    return Number(r1.changes) + Number(r2.changes);
  }

  // ---- Sources, runs & agent calls ----

  insertSourceMaterial(input: InsertSourceMaterialInput): { created: boolean; record: SourceMaterialRecord } {
    return this.sources.insertSourceMaterial(input);
  }

  getSourceMaterial(id: number): SourceMaterialRecord | undefined {
    return this.sources.getSourceMaterial(id);
  }

  listSourceMaterials(filter: { videoKeys?: string[]; limit?: number } = {}): SourceMaterialRecord[] {
    return this.sources.listSourceMaterials(filter);
  }

  listUnbuiltSourceMaterials(filter: { videoKeys?: string[]; limit?: number } = {}): SourceMaterialRecord[] {
    return this.sources.listUnbuiltSourceMaterials(filter);
  }

  listEvalVideoKeys(): Set<string> {
    return this.sources.listEvalVideoKeys();
  }

  createRun(input: {
    kind: ProbeRunKind;
    config: Record<string, unknown>;
    prompts: Record<string, unknown>;
    skills: unknown[];
  }): number {
    return this.sources.createRun(input);
  }

  finishRun(runId: number, status: Exclude<RunLifecycleStatus, "running">, error?: string): void {
    this.sources.finishRun(runId, status, error);
  }

  getRun(runId: number): ProbeRunRecord | undefined {
    return this.sources.getRun(runId);
  }

  getLatestRun(kind: ProbeRunKind): ProbeRunRecord | undefined {
    return this.sources.getLatestRun(kind);
  }

  listActiveRuns(kinds?: readonly ProbeRunKind[]): ProbeRunRecord[] {
    return this.sources.listActiveRuns(kinds);
  }

  startCall(input: StartAgentCallInput): number {
    return this.sources.startCall(input);
  }

  finishCall(callId: number, outcome: { output?: string; error?: string }): void {
    this.sources.finishCall(callId, outcome);
  }

  countAgentCalls(runRef: string, role?: string): number {
    return this.sources.countAgentCalls(runRef, role);
  }

  // ---- Probes, turns & calibrations ----

  createProbe(input: CreateProbeInput): number {
    return this.probesRepo.createProbe(input);
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
    this.probesRepo.reviseProbe(probeId, update);
  }

  appendReview(probeId: number, review: Omit<ProbeReviewEntry, "createdAt">): void {
    this.probesRepo.appendReview(probeId, review);
  }

  setProbeStatus(probeId: number, status: ProbeStatus, rejectReason?: string | null): void {
    this.probesRepo.setProbeStatus(probeId, status, rejectReason);
  }

  setProbeDifficulty(probeId: number, difficulty: DifficultyLevel): void {
    this.probesRepo.setProbeDifficulty(probeId, difficulty);
  }

  getProbe(probeId: number): ProbeRecord | undefined {
    return this.probesRepo.getProbe(probeId);
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
    return this.probesRepo.listProbes(filter);
  }

  listExistingQuestionsForSource(sourceMaterialId: number, excludeProbeId?: number): string[] {
    return this.probesRepo.listExistingQuestionsForSource(sourceMaterialId, excludeProbeId);
  }

  countProbesByType(statuses?: readonly ProbeStatus[]): Record<string, number> {
    return this.probesRepo.countProbesByType(statuses);
  }

  saveProbeTurn(input: SaveProbeTurnInput): number {
    return this.probesRepo.saveProbeTurn(input);
  }

  listProbeTurns(probeId: number): ProbeTurnRecord[] {
    return this.probesRepo.listProbeTurns(probeId);
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
    return this.probesRepo.saveCalibration(input);
  }

  listCalibrationsForProbe(
    probeId: number,
    filter?: { bareModel?: string; graderModel?: string },
  ): ProbeCalibrationRecord[] {
    return this.probesRepo.listCalibrationsForProbe(probeId, filter);
  }

  listCompleteCalibrationsForProbe(probeId: number, expectedTurns: number): ProbeCalibrationRecord[] {
    return this.probesRepo.listCompleteCalibrationsForProbe(probeId, expectedTurns);
  }

  // ---- Suites, eval runs, predictions & scores ----

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
    return this.suitesRepo.freezeSuite(input);
  }

  getSuite(name: string): SuiteVersionRecord | undefined {
    return this.suitesRepo.getSuite(name);
  }

  listSuites(): SuiteVersionRecord[] {
    return this.suitesRepo.listSuites();
  }

  listSuiteItems(suiteId: number): SuiteItemRecord[] {
    return this.suitesRepo.listSuiteItems(suiteId);
  }

  createEvalRun(input: {
    suiteId: number;
    candidate: string;
    model: string;
    historyMode: EvalHistoryMode;
    systemPrompt?: string | null;
    config?: Record<string, unknown>;
  }): number {
    return this.suitesRepo.createEvalRun(input);
  }

  reopenEvalRun(evalRunId: number): void {
    this.suitesRepo.reopenEvalRun(evalRunId);
  }

  finishEvalRun(evalRunId: number, status: Exclude<RunLifecycleStatus, "running">, error?: string): void {
    this.suitesRepo.finishEvalRun(evalRunId, status, error);
  }

  getEvalRun(evalRunId: number): EvalRunRecord | undefined {
    return this.suitesRepo.getEvalRun(evalRunId);
  }

  getLatestEvalRun(filter?: { suiteName?: string; candidate?: string }): EvalRunRecord | undefined {
    return this.suitesRepo.getLatestEvalRun(filter);
  }

  listEvalRuns(filter?: {
    suiteNames?: string[];
    candidates?: string[];
    runIds?: number[];
    historyMode?: EvalHistoryMode;
  }): EvalRunRecord[] {
    return this.suitesRepo.listEvalRuns(filter);
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
    return this.suitesRepo.saveEvalPrediction(input);
  }

  listEvalPredictions(evalRunId: number): EvalPredictionRecord[] {
    return this.suitesRepo.listEvalPredictions(evalRunId);
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
    return this.suitesRepo.saveEvalScore(input);
  }

  listEvalScores(evalRunId: number): EvalScoreRecord[] {
    return this.suitesRepo.listEvalScores(evalRunId);
  }

  getSummary(): EvalStoreSummary {
    const count = (sql: string): number => Number((this.db.prepare(sql).get() as { c: number }).c);
    const groupCounts = (sql: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const row of this.db.prepare(sql).all() as Array<{ k: string | null; c: number }>) {
        out[row.k ?? "uncalibrated"] = Number(row.c);
      }
      return out;
    };

    return {
      schemaVersion: this.getMeta("schema_version") ?? EVAL_SCHEMA_VERSION,
      sourceMaterials: count("SELECT count(*) AS c FROM source_materials"),
      sourceVideos: count("SELECT count(DISTINCT video_key) AS c FROM source_materials"),
      probeRuns: groupCounts("SELECT kind || ':' || status AS k, count(*) AS c FROM probe_runs GROUP BY kind, status"),
      probesByStatus: groupCounts("SELECT status AS k, count(*) AS c FROM probes GROUP BY status"),
      probesByType: groupCounts("SELECT probe_type AS k, count(*) AS c FROM probes WHERE status = 'accepted' GROUP BY probe_type"),
      probesByDifficulty: groupCounts("SELECT difficulty AS k, count(*) AS c FROM probes WHERE status = 'accepted' GROUP BY difficulty"),
      probeTurns: count("SELECT count(*) AS c FROM probe_turns"),
      probeCalibrations: count("SELECT count(*) AS c FROM probe_calibrations"),
      suites: this.listSuites().map((s) => ({
        name: s.name,
        itemCount: s.itemCount,
        sha256: s.sha256,
        frozenAt: s.frozenAt,
      })),
      evalRuns: count("SELECT count(*) AS c FROM eval_runs"),
      evalPredictions: count("SELECT count(*) AS c FROM eval_predictions"),
      evalScores: count("SELECT count(*) AS c FROM eval_scores"),
      agentCalls: count("SELECT count(*) AS c FROM agent_calls"),
    };
  }
}
