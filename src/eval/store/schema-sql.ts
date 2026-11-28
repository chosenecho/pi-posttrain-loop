import type { DatabaseSync } from "node:sqlite";
import { ensureRunOwnerColumn } from "../../shared/task-store.js";
import { ensureProbeBuildSchema } from "./build-plan-schema.js";
import { EVAL_SCHEMA_VERSION } from "./types.js";

/**
 * Isolated Evaluation Database Schema v3 (12 tables, fresh-only — no v1/v2 migrations).
 *
 * Tables:
 *  1. eval_meta
 *  2. source_materials  (immutable; keeps video_key for synth/eval-guard.ts)
 *  3. probe_runs
 *  4. probes            (absorbs probe_specs + critic reviews + difficulty)
 *  5. probe_turns       (absorbs reference_answer + rubric_json + attempts)
 *  6. probe_calibrations
 *  7. suite_versions    (immutable frozen suites)
 *  8. suite_items       (immutable; keeps video_key for synth/eval-guard.ts)
 *  9. eval_runs
 * 10. eval_predictions
 * 11. eval_scores
 * 12. agent_calls
 */
export const EVAL_SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS eval_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  video_key TEXT NOT NULL,
  main_material_id INTEGER,
  part_count INTEGER NOT NULL DEFAULT 1 CHECK(part_count >= 1),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  source_path TEXT,
  split_snapshot TEXT NOT NULL CHECK(split_snapshot = 'test'),
  imported_at TEXT NOT NULL,
  UNIQUE(video_id, content_sha256)
);
CREATE INDEX IF NOT EXISTS idx_eval_sources_video_key ON source_materials(video_key);

CREATE TRIGGER IF NOT EXISTS trg_eval_sources_immutable_update
BEFORE UPDATE ON source_materials
BEGIN
  SELECT RAISE(ABORT, 'source_materials snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_eval_sources_immutable_delete
BEFORE DELETE ON source_materials
BEGIN
  SELECT RAISE(ABORT, 'source_materials snapshots cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS probe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('probe_build', 'calibrate')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'interrupted')),
  config_json TEXT NOT NULL,
  prompts_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES probe_runs(id),
  source_material_id INTEGER NOT NULL REFERENCES source_materials(id),
  slot_index INTEGER NOT NULL CHECK(slot_index >= 1),
  probe_type TEXT NOT NULL CHECK(probe_type IN (
    'answer', 'correct_premise', 'acknowledge_gap', 'refuse', 'hold_position'
  )),
  persona TEXT NOT NULL,
  target_turns INTEGER NOT NULL DEFAULT 1 CHECK(target_turns BETWEEN 1 AND 3),
  question TEXT NOT NULL,
  anchor TEXT NOT NULL,
  trap TEXT NOT NULL,
  anchor_verified INTEGER NOT NULL DEFAULT 0 CHECK(anchor_verified IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('draft', 'accepted', 'rejected', 'dropped')),
  revisions INTEGER NOT NULL DEFAULT 0 CHECK(revisions >= 0),
  reviews_json TEXT NOT NULL DEFAULT '[]',
  reject_reason TEXT,
  difficulty TEXT CHECK(difficulty IS NULL OR difficulty IN ('easy', 'medium', 'hard')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, source_material_id, slot_index)
);
CREATE INDEX IF NOT EXISTS idx_probes_run_status ON probes(run_id, status);
CREATE INDEX IF NOT EXISTS idx_probes_source ON probes(source_material_id);
CREATE INDEX IF NOT EXISTS idx_probes_type ON probes(probe_type);
CREATE INDEX IF NOT EXISTS idx_probes_difficulty ON probes(difficulty);

CREATE TRIGGER IF NOT EXISTS trg_probes_lock_question_after_accept
BEFORE UPDATE ON probes
WHEN OLD.status = 'accepted' AND NEW.question != OLD.question
BEGIN
  SELECT RAISE(ABORT, 'accepted probe question is immutable');
END;

CREATE TABLE IF NOT EXISTS probe_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  probe_id INTEGER NOT NULL REFERENCES probes(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  expected_behavior TEXT NOT NULL CHECK(expected_behavior IN (
    'answer', 'correct_premise', 'acknowledge_gap', 'refuse', 'hold_position'
  )),
  tactic TEXT CHECK(tactic IS NULL OR tactic IN (
    'pushback', 'label', 'force_binary', 'flatter_flip', 'emotional'
  )),
  user_content TEXT NOT NULL,
  reference_answer TEXT NOT NULL,
  rubric_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts >= 1),
  created_at TEXT NOT NULL,
  UNIQUE(probe_id, turn_no)
);
CREATE INDEX IF NOT EXISTS idx_probe_turns_probe ON probe_turns(probe_id, turn_no);

CREATE TABLE IF NOT EXISTS probe_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  probe_id INTEGER NOT NULL REFERENCES probes(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  bare_model TEXT NOT NULL,
  grader_model TEXT NOT NULL,
  bare_answer TEXT NOT NULL,
  behavior_ok INTEGER NOT NULL CHECK(behavior_ok IN (0, 1)),
  score REAL NOT NULL CHECK(score >= 0 AND score <= 100),
  detail_json TEXT NOT NULL,
  bare_call_id INTEGER,
  grader_call_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(probe_id, turn_no, bare_model, grader_model)
);
CREATE INDEX IF NOT EXISTS idx_probe_calibrations_probe ON probe_calibrations(probe_id, turn_no);

CREATE TABLE IF NOT EXISTS suite_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  item_count INTEGER NOT NULL CHECK(item_count >= 0),
  sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_suite_versions_immutable_update
BEFORE UPDATE ON suite_versions
BEGIN
  SELECT RAISE(ABORT, 'suite_versions are immutable once frozen');
END;

CREATE TRIGGER IF NOT EXISTS trg_suite_versions_immutable_delete
BEFORE DELETE ON suite_versions
BEGIN
  SELECT RAISE(ABORT, 'suite_versions cannot be deleted once frozen');
END;

CREATE TABLE IF NOT EXISTS suite_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER NOT NULL REFERENCES suite_versions(id),
  item_key TEXT NOT NULL,
  video_key TEXT NOT NULL,
  probe_type TEXT NOT NULL CHECK(probe_type IN (
    'answer', 'correct_premise', 'acknowledge_gap', 'refuse', 'hold_position'
  )),
  difficulty TEXT CHECK(difficulty IS NULL OR difficulty IN ('easy', 'medium', 'hard')),
  messages_json TEXT NOT NULL,
  rubrics_json TEXT NOT NULL,
  UNIQUE(suite_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_suite_items_suite ON suite_items(suite_id);
CREATE INDEX IF NOT EXISTS idx_suite_items_video ON suite_items(video_key);

CREATE TRIGGER IF NOT EXISTS trg_suite_items_immutable_update
BEFORE UPDATE ON suite_items
BEGIN
  SELECT RAISE(ABORT, 'suite_items are immutable once frozen');
END;

CREATE TRIGGER IF NOT EXISTS trg_suite_items_immutable_delete
BEFORE DELETE ON suite_items
BEGIN
  SELECT RAISE(ABORT, 'suite_items cannot be deleted once frozen');
END;

CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER NOT NULL REFERENCES suite_versions(id),
  candidate TEXT NOT NULL,
  model TEXT NOT NULL,
  history_mode TEXT NOT NULL CHECK(history_mode IN ('gold', 'self')),
  system_prompt TEXT,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_suite_cand ON eval_runs(suite_id, candidate);

CREATE TABLE IF NOT EXISTS eval_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eval_run_id INTEGER NOT NULL REFERENCES eval_runs(id),
  suite_item_id INTEGER NOT NULL REFERENCES suite_items(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  input_json TEXT NOT NULL,
  output_text TEXT,
  error TEXT,
  call_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(eval_run_id, suite_item_id, turn_no)
);
CREATE INDEX IF NOT EXISTS idx_eval_predictions_run ON eval_predictions(eval_run_id);

CREATE TABLE IF NOT EXISTS eval_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id INTEGER NOT NULL UNIQUE REFERENCES eval_predictions(id),
  grader_model TEXT NOT NULL,
  behavior_ok INTEGER NOT NULL CHECK(behavior_ok IN (0, 1)),
  stance INTEGER NOT NULL CHECK(stance BETWEEN 0 AND 2),
  key_point_coverage REAL NOT NULL CHECK(key_point_coverage >= 0 AND key_point_coverage <= 1),
  forbidden_hits INTEGER NOT NULL DEFAULT 0 CHECK(forbidden_hits >= 0),
  hallucination_hits INTEGER NOT NULL DEFAULT 0 CHECK(hallucination_hits >= 0),
  failure_signal_hits INTEGER NOT NULL DEFAULT 0 CHECK(failure_signal_hits >= 0),
  style INTEGER NOT NULL CHECK(style BETWEEN 0 AND 2),
  score REAL NOT NULL CHECK(score >= 0 AND score <= 100),
  detail_json TEXT NOT NULL,
  call_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ref TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  output_text TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_calls_run_role ON agent_calls(run_ref, role);
`;

/** Read-only reports support v3; existing databases are upgraded only by the explicit migrator. */
export function ensureEvalSchema(db: DatabaseSync, readOnly: boolean): void {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name).filter((name) => name !== "runtime_task_lock");

  if (tables.length > 0) {
    const row = tables.includes("eval_meta")
      ? db.prepare("SELECT value FROM eval_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      : undefined;
    const foundVersion = row?.value ?? null;
    if (foundVersion === EVAL_SCHEMA_VERSION || (readOnly && foundVersion === "3")) return;
    if (foundVersion === "3") {
      throw new Error("评测库 v3 保留只读访问；写入前请运行 npm run dm -- eval migrate 显式迁移至 v4，原有业务数据将保留。[eval_migration_required]");
    }
    const label = foundVersion ? `v${foundVersion}` : "旧版";
    throw new Error(`评测库 schema 版本不兼容（当前 ${label}，需要 v${EVAL_SCHEMA_VERSION}）。请保留原库；v1/v2 暂无跨版本迁移，请使用对应版本工具读取历史数据。`);
  }

  if (readOnly) {
    throw new Error("只读模式下评测库尚未初始化，请先运行 npm run dm -- eval make。");
  }

  db.exec(EVAL_SCHEMA_V3_SQL);
  ensureProbeBuildSchema(db);
  ensureRunOwnerColumn(db, "probe_runs");
  ensureRunOwnerColumn(db, "eval_runs");
  db.prepare("INSERT INTO eval_meta (key, value) VALUES ('schema_version', ?)").run(EVAL_SCHEMA_VERSION);
}

/** Compatibility export for callers migrating to the version-independent initializer name. */
export const ensureEvalSchemaV3 = ensureEvalSchema;
