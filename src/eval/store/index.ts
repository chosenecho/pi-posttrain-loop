import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../shared/utils.js";
import { EvaluationSpecError, readEvaluationSpec, type ResolvedEvaluationSpec } from "../evaluation-spec.js";
import { TaskSession, ensureRunOwnerColumn } from "../../shared/task-store.js";
import { EvalProbeRepo } from "./probe-repo.js";
import { EvalBuildPlanRepo } from "./build-plan-repo.js";
import { ensureProbeBuildSchema } from "./build-plan-schema.js";
import { migrateLegacyProbeBuildPlans } from "./legacy-build-plans.js";
import type { BuildPlanFilter, ProbeBuildCheckpoint, ProbeBuildDraft, ProbeBuildSlotStatus, ProbeBuildSpec } from "./types.js";
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
  private readonly db: DatabaseSync;
  readonly path: string;
  private readonly task?: TaskSession;
  private recovered = false;
  private readonly sources: EvalSourceRepo;
  private readonly buildPlans: EvalBuildPlanRepo;
  private readonly probesRepo: EvalProbeRepo;
  private readonly suitesRepo: EvalSuiteAndRunRepo;

  constructor(dbPath: string, options: { readOnly?: boolean } = {}) {
    this.path = dbPath;
    if (dbPath !== ":memory:" && !options.readOnly) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = options.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      if (!options.readOnly) {
        this.task = new TaskSession(this.db, "eval");
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
        this.task.mutate(() => {
          ensureEvalSchemaV3(this.db, false);
          ensureProbeBuildSchema(this.db);
          ensureRunOwnerColumn(this.db, "probe_runs");
          ensureRunOwnerColumn(this.db, "eval_runs");
        });
      } else {
        ensureEvalSchemaV3(this.db, true);
      }
    } catch (error) {
      try { this.task?.release(); } finally { this.db.close(); }
      throw error;
    }

    this.sources = new EvalSourceRepo(this.db);
    this.buildPlans = new EvalBuildPlanRepo(this.db);
    this.probesRepo = new EvalProbeRepo(this.db);
    this.suitesRepo = new EvalSuiteAndRunRepo(this.db, (fn) => this.transaction(fn));
  }

  get signal(): AbortSignal | undefined { return this.task?.signal; }

  abort(reason?: unknown): void { this.task?.abort(reason); }

  close(): void {
    try { this.task?.release(); } finally { this.db.close(); }
  }

  transaction<T>(fn: () => T): T {
    if (!this.task) throw new Error("只读 Store 不执行写事务");
    return this.task.mutate(fn);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM eval_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.transaction(() => this.db.prepare("INSERT OR REPLACE INTO eval_meta (key, value) VALUES (?, ?)").run(key, value));
  }

  /** Deferred until configuration validation; one recovery pass per owning session. */
  ensureRecovered(): number {
    if (this.recovered) return 0;
    const count = this.markInterruptedRuns();
    this.recovered = true;
    return count;
  }

  markInterruptedRuns(): number {
    return this.transaction(() => {
      const now = nowIso();
      const owner = this.task!.ownerToken;
      const orphanBuilds = this.db.prepare("SELECT id FROM probe_runs WHERE owner_token IS NULL OR owner_token != ?").all(owner) as Array<{ id: number }>;
      this.buildPlans.recoverBuildWork(orphanBuilds.map((row) => row.id));
      const r1 = this.db.prepare("UPDATE probe_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running' AND (owner_token IS NULL OR owner_token != ?)").run(now, owner);
      // Invalid or incomplete historical specifications remain untouched, including their status.
      const candidates = this.db.prepare("SELECT id FROM eval_runs WHERE status = 'running' AND (owner_token IS NULL OR owner_token != ?)").all(owner) as Array<{ id: number }>;
      let interruptedEvaluations = 0;
      for (const row of candidates) {
        try { this.assertWritableEvaluation(row.id); } catch { continue; }
        interruptedEvaluations += Number(this.db.prepare("UPDATE eval_runs SET status = 'interrupted', ended_at = ? WHERE id = ?").run(now, row.id).changes);
      }
      return Number(r1.changes) + interruptedEvaluations;
    });
  }

  recordEvaluationExecution(evalRunId: number, operational: { timeoutMs: number; concurrency: number; callMaxAttempts: number; callRetryDelayMs: number }): void {
    this.transaction(() => {
      this.assertWritableEvaluation(evalRunId);
      const run = this.getEvalRun(evalRunId)!;
      const executions = Array.isArray(run.config.operationalExecutions) ? run.config.operationalExecutions : [];
      const config = { ...run.config, operationalExecutions: [...executions, { ...operational, startedAt: nowIso() }] };
      this.db.prepare("UPDATE eval_runs SET config_json = ? WHERE id = ?").run(JSON.stringify(config), evalRunId);
    });
  }

  private assertWritableEvaluation(evalRunId: number): ResolvedEvaluationSpec {
    const run = this.getEvalRun(evalRunId);
    const spec = run && readEvaluationSpec(run);
    if (!run || !spec) throw new EvaluationSpecError("legacy_spec_incomplete", "历史评测规格缺失，保持只读");
    const suite = this.db.prepare("SELECT sha256 FROM suite_versions WHERE id = ?").get(run.suiteId) as { sha256: string } | undefined;
    if (run.suiteId !== spec.suiteId || run.candidate !== spec.candidate || run.model !== spec.modelId
      || run.historyMode !== spec.historyMode || run.systemPrompt !== spec.systemPrompt || suite?.sha256 !== spec.suiteSha256) {
      throw new EvaluationSpecError("evaluation_spec_invalid", "运行或套卷与保存的评测规格身份不一致");
    }
    const suiteItemIds = new Set((this.db.prepare("SELECT id FROM suite_items WHERE suite_id = ?").all(run.suiteId) as Array<{ id: number }>).map(row => row.id));
    if (spec.itemIds.some(id => !suiteItemIds.has(id))) throw new EvaluationSpecError("evaluation_spec_invalid", "固定评测条目缺失或不属于目标套卷");
    return spec;
  }

  // ---- Sources, runs & agent calls ----

  insertSourceMaterial(input: InsertSourceMaterialInput): { created: boolean; record: SourceMaterialRecord } {
    return this.transaction(() => this.sources.insertSourceMaterial(input));
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
    return this.transaction(() => {
      const id = this.sources.createRun(input);
      this.db.prepare("UPDATE probe_runs SET owner_token = ? WHERE id = ?").run(this.task!.ownerToken, id);
      return id;
    });
  }

  finishRun(runId: number, status: Exclude<RunLifecycleStatus, "running">, error?: string): void {
    return this.transaction(() => this.sources.finishRun(runId, status, error));
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
    return this.transaction(() => this.sources.startCall(input));
  }

  finishCall(callId: number, outcome: { output?: string; error?: string }): void {
    return this.transaction(() => this.sources.finishCall(callId, outcome));
  }

  countAgentCalls(runRef: string, role?: string): number {
    return this.sources.countAgentCalls(runRef, role);
  }

  // ---- Persistent build plans and atomic build progress ----

  listBuildPlans(filter: BuildPlanFilter = {}) { return this.buildPlans.listBuildPlans(filter); }
  getBuildPlan(id: number) { return this.buildPlans.getBuildPlan(id); }
  listBuildSlots(planId: number) { return this.buildPlans.listBuildSlots(planId); }
  listBuildExecutions(executionRunId: number) { return this.buildPlans.listBuildExecutions(executionRunId); }
  getAgentCall(callId: number) { return this.sources.getAgentCall(callId); }

  migrateLegacyBuildPlans() { return this.transaction(() => migrateLegacyProbeBuildPlans(this.db)); }

  materializeBuildSlots(planId: number, executionRunId: number): number {
    return this.transaction(() => {
      const plan = this.buildPlans.getBuildPlan(planId)!;
      const source = this.sources.getSourceMaterial(plan.sourceMaterialId)!;
      let created = 0;
      for (const slot of this.buildPlans.listBuildSlots(planId)) {
        if (slot.probeId !== null) continue;
        const probeId = this.probesRepo.createProbe({ ...slot.draft, runId: executionRunId, sourceMaterialId: source.id, slotIndex: slot.slotIndex, anchorVerified: slot.draft.anchor.length >= 4 && source.content.includes(slot.draft.anchor) });
        this.buildPlans.bindBuildSlotProbe(slot.id, probeId);
        created++;
      }
      return created;
    });
  }

  createBuildPlan(input: { sourceMaterialId: number; executionRunId: number; sourceSha256: string; spec: ProbeBuildSpec; specHash: string }): number {
    return this.transaction(() => {
      const id = this.buildPlans.createBuildPlan(input);
      this.buildPlans.linkBuildExecution(input.executionRunId, id);
      return id;
    });
  }

  linkBuildExecution(executionRunId: number, planId: number): void {
    this.transaction(() => this.buildPlans.linkBuildExecution(executionRunId, planId));
  }

  startBuildPlanning(planId: number, input: StartAgentCallInput): number {
    return this.transaction(() => {
      const callId = this.sources.startCall(input);
      this.buildPlans.startBuildPlanning(planId, callId);
      return callId;
    });
  }

  /** The complete validated writer batch and all initial probes become visible together. */
  commitBuildBatch(input: { planId: number; executionRunId: number; callId: number; raw: string; drafts: ProbeBuildDraft[]; skipReason?: string; anchorVerified: boolean[] }): void {
    this.transaction(() => {
      const plan = this.buildPlans.getBuildPlan(input.planId)!;
      if (plan.planComplete) return;
      this.sources.finishCall(input.callId, { output: input.raw });
      input.drafts.forEach((draft, i) => {
        const probeId = this.probesRepo.createProbe({ ...draft, runId: input.executionRunId, sourceMaterialId: plan.sourceMaterialId, slotIndex: i + 1, anchorVerified: input.anchorVerified[i] ?? false });
        this.buildPlans.insertBuildSlot({ planId: plan.id, executionRunId: input.executionRunId, slotIndex: i + 1, probeId, draft, checkpoint: { version: 1, stage: "critic", roundNo: 1, turnNo: 1, attempt: 1 } });
      });
      this.buildPlans.markBuildBatchReady(plan.id, input.drafts.length, input.skipReason);
    });
  }

  startBuildSlotCall(slotId: number, executionRunId: number, checkpoint: ProbeBuildCheckpoint, input: StartAgentCallInput): number {
    return this.transaction(() => {
      const callId = this.sources.startCall(input);
      this.buildPlans.updateBuildCheckpoint(slotId, executionRunId, { ...checkpoint, pendingCallId: callId });
      return callId;
    });
  }

  /** Commit a stage result, its next checkpoint, and any probe/turn mutations atomically. */
  commitBuildCheckpoint(input: { slotId: number; executionRunId: number; checkpoint: ProbeBuildCheckpoint; status?: ProbeBuildSlotStatus; errorCode?: string }, mutate?: () => void): void {
    this.transaction(() => {
      mutate?.();
      this.buildPlans.updateBuildCheckpoint(input.slotId, input.executionRunId, input.checkpoint, input.status, input.errorCode);
    });
  }

  failBuildPlan(planId: number, errorCode: string): void { this.transaction(() => this.buildPlans.failBuildPlan(planId, errorCode)); }
  finishBuildExecution(executionRunId: number, planId: number, stats: Record<string, number> = {}): void {
    this.transaction(() => this.buildPlans.finishBuildExecution(executionRunId, planId, stats));
  }
  recoverBuildWork(executionRunIds: readonly number[]): number {
    return this.transaction(() => this.buildPlans.recoverBuildWork(executionRunIds));
  }

  // ---- Probes, turns & calibrations ----

  createProbe(input: CreateProbeInput): number {
    return this.transaction(() => this.probesRepo.createProbe(input));
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
    return this.transaction(() => this.probesRepo.reviseProbe(probeId, update));
  }

  appendReview(probeId: number, review: Omit<ProbeReviewEntry, "createdAt">): void {
    return this.transaction(() => this.probesRepo.appendReview(probeId, review));
  }

  setProbeStatus(probeId: number, status: ProbeStatus, rejectReason?: string | null): void {
    return this.transaction(() => this.probesRepo.setProbeStatus(probeId, status, rejectReason));
  }

  setProbeDifficulty(probeId: number, difficulty: DifficultyLevel): void {
    return this.transaction(() => this.probesRepo.setProbeDifficulty(probeId, difficulty));
  }

  getProbe(probeId: number): ProbeRecord | undefined {
    return this.probesRepo.getProbe(probeId);
  }

  listProbes(
    filter: {
      runId?: number;
      executionRunId?: number;
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
    return this.transaction(() => this.probesRepo.saveProbeTurn(input));
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
    return this.transaction(() => this.probesRepo.saveCalibration(input));
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
    return this.transaction(() => this.suitesRepo.freezeSuite(input));
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
    parentRunId?: number;
  }): number {
    return this.transaction(() => {
      const id = this.suitesRepo.createEvalRun({ ...input, config: { ...input.config, ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }) } });
      this.db.prepare("UPDATE eval_runs SET owner_token = ? WHERE id = ?").run(this.task!.ownerToken, id);
      return id;
    });
  }

  reopenEvalRun(evalRunId: number): void {
    this.transaction(() => {
      this.assertWritableEvaluation(evalRunId);
      this.suitesRepo.reopenEvalRun(evalRunId);
      this.db.prepare("UPDATE eval_runs SET owner_token = ? WHERE id = ?").run(this.task!.ownerToken, evalRunId);
    });
  }

  finishEvalRun(evalRunId: number, status: Exclude<RunLifecycleStatus, "running">, error?: string): void {
    this.transaction(() => {
      this.assertWritableEvaluation(evalRunId);
      this.suitesRepo.finishEvalRun(evalRunId, status, error);
    });
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
    return this.transaction(() => {
      const spec = this.assertWritableEvaluation(input.evalRunId);
      if (!spec.itemIds.includes(input.suiteItemId)) throw new EvaluationSpecError("evaluation_spec_invalid", "预测条目未包含在固定评测规格中");
      return this.suitesRepo.saveEvalPrediction(input);
    });
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
    return this.transaction(() => {
      const prediction = this.db.prepare("SELECT eval_run_id, suite_item_id FROM eval_predictions WHERE id = ?").get(input.predictionId) as { eval_run_id: number; suite_item_id: number } | undefined;
      const spec = this.assertWritableEvaluation(prediction?.eval_run_id ?? -1);
      if (!prediction || !spec.itemIds.includes(prediction.suite_item_id)) throw new EvaluationSpecError("evaluation_spec_invalid", "评分条目未包含在固定评测规格中");
      return this.suitesRepo.saveEvalScore(input);
    });
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
