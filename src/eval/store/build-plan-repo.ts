import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../shared/utils.js";
import type { BuildPlanFilter, ProbeBuildCheckpoint, ProbeBuildDraft, ProbeBuildExecutionRecord, ProbeBuildPlanRecord, ProbeBuildSlotRecord, ProbeBuildSlotStatus, ProbeBuildSpec } from "./types.js";

function mapPlan(row: Record<string, unknown>): ProbeBuildPlanRecord {
  return {
    id: Number(row.id), sourceMaterialId: Number(row.source_material_id), generation: Number(row.generation),
    originRunId: Number(row.origin_run_id), lastExecutionRunId: Number(row.last_execution_run_id),
    sourceSha256: String(row.source_sha256), spec: row.spec_json === null ? null : JSON.parse(String(row.spec_json)),
    specHash: String(row.spec_hash), writerCallId: row.writer_call_id === null ? null : Number(row.writer_call_id),
    status: row.status as ProbeBuildPlanRecord["status"], plannedCount: Number(row.planned_count),
    planComplete: row.plan_complete === 1, skipReason: row.skip_reason === null ? null : String(row.skip_reason),
    errorCode: row.error_code === null ? null : String(row.error_code), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
function mapSlot(row: Record<string, unknown>): ProbeBuildSlotRecord {
  let checkpoint: ProbeBuildCheckpoint;
  try {
    checkpoint = JSON.parse(String(row.checkpoint_json));
    if (row.checkpoint_version !== 1 || checkpoint.version !== 1 || checkpoint.stage !== row.stage) throw new Error();
  } catch { throw new Error(`checkpoint_invalid: slot #${row.id}`); }
  return {
    id: Number(row.id), planId: Number(row.plan_id), slotIndex: Number(row.slot_index),
    probeId: row.probe_id === null ? null : Number(row.probe_id), draft: JSON.parse(String(row.draft_json)),
    status: row.status as ProbeBuildSlotStatus, stage: row.stage as ProbeBuildSlotRecord["stage"], checkpoint,
    lastExecutionRunId: Number(row.last_execution_run_id), errorCode: row.error_code === null ? null : String(row.error_code),
  };
}

/** Internal persistence adapter. All compound writes are transaction-scoped by EvalStore. */
export class EvalBuildPlanRepo {
  constructor(private readonly db: DatabaseSync) {}

  getBuildPlan(id: number): ProbeBuildPlanRecord | undefined {
    const row = this.db.prepare("SELECT * FROM probe_build_plans WHERE id = ?").get(id);
    return row ? mapPlan(row) : undefined;
  }

  listBuildPlans(filter: BuildPlanFilter = {}): ProbeBuildPlanRecord[] {
    const clauses: string[] = [];
    const values: number[] = [];
    if (filter.sourceMaterialId !== undefined) { clauses.push("p.source_material_id = ?"); values.push(filter.sourceMaterialId); }
    if (filter.originRunId !== undefined) { clauses.push("p.origin_run_id = ?"); values.push(filter.originRunId); }
    if (filter.executionRunId !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM probe_build_executions e WHERE e.plan_id = p.id AND e.execution_run_id = ?)");
      values.push(filter.executionRunId);
    }
    if (filter.latestOnly) clauses.push("p.generation = (SELECT max(n.generation) FROM probe_build_plans n WHERE n.source_material_id = p.source_material_id)");
    return this.db.prepare(`SELECT p.* FROM probe_build_plans p ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY p.id`).all(...values).map(mapPlan);
  }

  createBuildPlan(input: { sourceMaterialId: number; executionRunId: number; sourceSha256: string; spec: ProbeBuildSpec; specHash: string }): number {
    const generation = Number((this.db.prepare("SELECT COALESCE(max(generation), 0) + 1 AS n FROM probe_build_plans WHERE source_material_id = ?").get(input.sourceMaterialId) as { n: number }).n);
    const now = nowIso();
    const row = this.db.prepare(`INSERT INTO probe_build_plans
      (source_material_id,generation,origin_run_id,last_execution_run_id,source_sha256,spec_json,spec_hash,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',?,?)`).run(input.sourceMaterialId, generation, input.executionRunId, input.executionRunId, input.sourceSha256, JSON.stringify(input.spec), input.specHash, now, now);
    return Number(row.lastInsertRowid);
  }

  linkBuildExecution(executionRunId: number, planId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO probe_build_executions (execution_run_id,plan_id,started_at) VALUES (?,?,?)").run(executionRunId, planId, nowIso());
    this.db.prepare("UPDATE probe_build_plans SET last_execution_run_id = ?, updated_at = ? WHERE id = ?").run(executionRunId, nowIso(), planId);
  }

  startBuildPlanning(planId: number, callId: number): void {
    this.db.prepare("UPDATE probe_build_plans SET status = 'planning', writer_call_id = ?, error_code = NULL, updated_at = ? WHERE id = ? AND plan_complete = 0").run(callId, nowIso(), planId);
  }

  insertBuildSlot(input: { planId: number; slotIndex: number; probeId: number | null; draft: ProbeBuildDraft; executionRunId: number; checkpoint: ProbeBuildCheckpoint; status?: ProbeBuildSlotStatus }): number {
    const now = nowIso();
    const row = this.db.prepare(`INSERT INTO probe_build_slots
      (plan_id,slot_index,probe_id,draft_json,status,stage,checkpoint_json,last_execution_run_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.planId, input.slotIndex, input.probeId, JSON.stringify(input.draft), input.status ?? "pending", input.checkpoint.stage, JSON.stringify(input.checkpoint), input.executionRunId, now, now);
    return Number(row.lastInsertRowid);
  }

  bindBuildSlotProbe(slotId: number, probeId: number): void {
    this.db.prepare("UPDATE probe_build_slots SET probe_id = ?, updated_at = ? WHERE id = ? AND probe_id IS NULL").run(probeId, nowIso(), slotId);
  }

  markBuildBatchReady(planId: number, count: number, skipReason?: string): void {
    this.db.prepare("UPDATE probe_build_plans SET status = ?, planned_count = ?, plan_complete = 1, skip_reason = ?, error_code = NULL, updated_at = ? WHERE id = ? AND plan_complete = 0").run(count ? "ready" : "skipped", count, count ? null : skipReason ?? "无合适考题", nowIso(), planId);
  }

  listBuildSlots(planId: number): ProbeBuildSlotRecord[] {
    return this.db.prepare("SELECT * FROM probe_build_slots WHERE plan_id = ? ORDER BY slot_index").all(planId).map(mapSlot);
  }

  updateBuildCheckpoint(slotId: number, executionRunId: number, checkpoint: ProbeBuildCheckpoint, status: ProbeBuildSlotStatus = "running", errorCode?: string): void {
    const row = this.db.prepare("SELECT status FROM probe_build_slots WHERE id = ?").get(slotId) as { status: string } | undefined;
    if (!row) throw new Error(`checkpoint_invalid: missing slot #${slotId}`);
    if (["accepted", "rejected", "dropped"].includes(row.status)) throw new Error(`checkpoint_invalid: terminal slot #${slotId}`);
    this.db.prepare("UPDATE probe_build_slots SET checkpoint_json = ?, checkpoint_version = 1, stage = ?, status = ?, last_execution_run_id = ?, error_code = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(checkpoint), checkpoint.stage, status, executionRunId, errorCode ?? null, nowIso(), slotId);
  }

  failBuildPlan(planId: number, errorCode: string): void {
    this.db.prepare("UPDATE probe_build_plans SET status = 'retryable', error_code = ?, updated_at = ? WHERE id = ?").run(errorCode, nowIso(), planId);
  }

  finishBuildExecution(executionRunId: number, planId: number, stats: Record<string, number>): void {
    const plan = this.getBuildPlan(planId)!;
    const slots = this.listBuildSlots(planId);
    const remaining = slots.some(s => !["accepted", "rejected", "dropped"].includes(s.status));
    if (plan.planComplete && !remaining && plan.status !== "skipped") this.db.prepare("UPDATE probe_build_plans SET status = 'done', error_code = NULL, updated_at = ? WHERE id = ?").run(nowIso(), planId);
    else if (remaining) this.failBuildPlan(planId, plan.errorCode === "legacy_plan_incomplete" || plan.errorCode === "checkpoint_invalid" ? plan.errorCode : slots.find(s => s.errorCode)?.errorCode ?? plan.errorCode ?? "build_incomplete");
    const executionStats = {
      newProbes: slots.filter(s => s.probeId && (this.db.prepare("SELECT run_id FROM probes WHERE id = ?").get(s.probeId) as { run_id: number }).run_id === executionRunId).length,
      resumedSlots: slots.filter(s => s.lastExecutionRunId === executionRunId && plan.originRunId !== executionRunId).length,
      newlyCompleted: slots.filter(s => s.lastExecutionRunId === executionRunId && ["accepted", "rejected", "dropped"].includes(s.status)).length,
      reusedTerminal: slots.filter(s => s.lastExecutionRunId !== executionRunId && ["accepted", "rejected", "dropped"].includes(s.status)).length,
      pendingSlots: slots.filter(s => !["accepted", "rejected", "dropped"].includes(s.status)).length,
      errorSlots: slots.filter(s => s.status === "retryable").length,
      ...stats,
    };
    this.db.prepare("UPDATE probe_build_executions SET stats_json = ?, ended_at = ? WHERE execution_run_id = ? AND plan_id = ?").run(JSON.stringify(executionStats), nowIso(), executionRunId, planId);
  }

  listBuildExecutions(executionRunId: number): ProbeBuildExecutionRecord[] {
    return this.db.prepare("SELECT * FROM probe_build_executions WHERE execution_run_id = ? ORDER BY plan_id").all(executionRunId).map(row => ({ executionRunId: Number(row.execution_run_id), planId: Number(row.plan_id), stats: JSON.parse(String(row.stats_json)), startedAt: String(row.started_at), endedAt: row.ended_at === null ? null : String(row.ended_at) }));
  }

  recoverBuildWork(executionRunIds: readonly number[]): number {
    if (!executionRunIds.length) return 0;
    const placeholders = executionRunIds.map(() => "?").join(",");
    const slots = this.db.prepare(`UPDATE probe_build_slots SET status = 'retryable', error_code = 'operation_interrupted', updated_at = ? WHERE status = 'running' AND last_execution_run_id IN (${placeholders})`).run(nowIso(), ...executionRunIds);
    const plans = this.db.prepare(`UPDATE probe_build_plans SET status = 'retryable', error_code = 'operation_interrupted', updated_at = ? WHERE status IN ('planning','ready') AND last_execution_run_id IN (${placeholders})`).run(nowIso(), ...executionRunIds);
    return Number(slots.changes) + Number(plans.changes);
  }
}
