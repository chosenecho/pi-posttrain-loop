import type { DatabaseSync } from "node:sqlite";

/** Additive v4 schema; the caller owns the migration transaction and schema_version update. */
export const EVAL_BUILD_PLAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS probe_build_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_material_id INTEGER NOT NULL REFERENCES source_materials(id),
  generation INTEGER NOT NULL CHECK(generation >= 1),
  origin_run_id INTEGER NOT NULL REFERENCES probe_runs(id),
  last_execution_run_id INTEGER NOT NULL REFERENCES probe_runs(id),
  source_sha256 TEXT NOT NULL,
  spec_json TEXT,
  spec_hash TEXT NOT NULL,
  writer_call_id INTEGER REFERENCES agent_calls(id),
  status TEXT NOT NULL CHECK(status IN ('pending','planning','ready','retryable','done','skipped')),
  planned_count INTEGER NOT NULL DEFAULT 0 CHECK(planned_count >= 0),
  plan_complete INTEGER NOT NULL DEFAULT 0 CHECK(plan_complete IN (0,1)),
  skip_reason TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_material_id, generation)
);
CREATE TABLE IF NOT EXISTS probe_build_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES probe_build_plans(id),
  slot_index INTEGER NOT NULL CHECK(slot_index >= 1),
  probe_id INTEGER UNIQUE REFERENCES probes(id),
  draft_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','retryable','accepted','rejected','dropped')),
  stage TEXT NOT NULL CHECK(stage IN ('critic','revision','adversary','reference','verifier','done')),
  checkpoint_version INTEGER NOT NULL DEFAULT 1,
  checkpoint_json TEXT NOT NULL,
  last_execution_run_id INTEGER NOT NULL REFERENCES probe_runs(id),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_id, slot_index)
);
CREATE TABLE IF NOT EXISTS probe_build_executions (
  execution_run_id INTEGER NOT NULL REFERENCES probe_runs(id),
  plan_id INTEGER NOT NULL REFERENCES probe_build_plans(id),
  stats_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY(execution_run_id, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_build_plan_source ON probe_build_plans(source_material_id, generation DESC);
CREATE INDEX IF NOT EXISTS idx_build_slots_status ON probe_build_slots(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_build_execution_plan ON probe_build_executions(plan_id);
CREATE TRIGGER IF NOT EXISTS trg_build_plan_immutable_batch
BEFORE UPDATE OF source_material_id, source_sha256, spec_json, spec_hash, planned_count, plan_complete ON probe_build_plans
WHEN OLD.plan_complete = 1 AND (
  NEW.source_material_id != OLD.source_material_id OR NEW.source_sha256 != OLD.source_sha256 OR
  NEW.spec_json IS NOT OLD.spec_json OR NEW.spec_hash != OLD.spec_hash OR
  NEW.planned_count != OLD.planned_count OR NEW.plan_complete != OLD.plan_complete
)
BEGIN SELECT RAISE(ABORT, 'ready build plan is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_build_slot_immutable_draft
BEFORE UPDATE OF draft_json, plan_id, slot_index, probe_id ON probe_build_slots
WHEN NEW.draft_json != OLD.draft_json OR NEW.plan_id != OLD.plan_id OR
     NEW.slot_index != OLD.slot_index OR (OLD.probe_id IS NOT NULL AND NEW.probe_id IS NOT OLD.probe_id)
BEGIN SELECT RAISE(ABORT, 'build slot identity is immutable'); END;
`;

export function ensureProbeBuildSchema(db: DatabaseSync): void {
  db.exec(EVAL_BUILD_PLAN_SCHEMA_SQL);
}
