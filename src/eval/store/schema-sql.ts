import type { DatabaseSync } from "node:sqlite";
import { EXPECTED_BEHAVIORS, PROBE_TYPES, type Row } from "./types.js";

const q = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");

export const EVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS eval_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_materials (
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL UNIQUE CHECK(length(trim(video_id)) > 0),
  video_key TEXT NOT NULL CHECK(length(trim(video_key)) > 0),
  main_material_id INTEGER,
  split_snapshot TEXT NOT NULL CHECK(split_snapshot = 'test'),
  part_count INTEGER NOT NULL CHECK(part_count >= 1),
  content TEXT NOT NULL CHECK(length(trim(content)) > 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  source_path TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_materials_video_key ON source_materials(video_key);

CREATE TABLE IF NOT EXISTS probe_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('probe_build','calibrate','mirror')),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  prompts_json TEXT NOT NULL CHECK(json_valid(prompts_json)),
  skills_json TEXT NOT NULL CHECK(json_valid(skills_json)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS probe_specs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES probe_runs(id),
  source_material_id INTEGER NOT NULL REFERENCES source_materials(id),
  slot_index INTEGER NOT NULL CHECK(slot_index >= 1),
  probe_type TEXT NOT NULL CHECK(probe_type IN (${q(PROBE_TYPES)})),
  persona TEXT NOT NULL,
  target_turns INTEGER NOT NULL CHECK(target_turns BETWEEN 1 AND 3),
  UNIQUE(run_id, source_material_id, slot_index)
);

CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY,
  spec_id INTEGER NOT NULL UNIQUE REFERENCES probe_specs(id),
  question TEXT NOT NULL CHECK(length(trim(question)) > 0),
  anchor TEXT NOT NULL,
  trap TEXT NOT NULL,
  expected_behavior TEXT NOT NULL CHECK(expected_behavior IN (${q(EXPECTED_BEHAVIORS)})),
  status TEXT NOT NULL CHECK(status IN ('drafted','rejected','answering','dropped','error','accepted')),
  anchor_verified INTEGER NOT NULL DEFAULT 0 CHECK(anchor_verified IN (0,1)),
  revisions INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT,
  difficulty TEXT CHECK(difficulty IS NULL OR difficulty IN ('easy','medium','hard')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_reviews (
  id INTEGER PRIMARY KEY,
  probe_id INTEGER NOT NULL REFERENCES probes(id),
  round_no INTEGER NOT NULL CHECK(round_no >= 1),
  decision TEXT NOT NULL CHECK(decision IN ('accept','revise','reject')),
  issues_json TEXT NOT NULL CHECK(json_valid(issues_json)),
  feedback TEXT NOT NULL DEFAULT '',
  question_snapshot TEXT NOT NULL,
  call_id INTEGER REFERENCES agent_calls(id),
  created_at TEXT NOT NULL,
  UNIQUE(probe_id, round_no)
);

CREATE TABLE IF NOT EXISTS probe_turns (
  id INTEGER PRIMARY KEY,
  probe_id INTEGER NOT NULL REFERENCES probes(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  user_content TEXT NOT NULL,
  tactic TEXT,
  expected_behavior TEXT NOT NULL CHECK(expected_behavior IN (${q(EXPECTED_BEHAVIORS)})),
  passed_attempt_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','pass','dropped','exhausted','error')),
  UNIQUE(probe_id, turn_no)
);

CREATE TABLE IF NOT EXISTS probe_attempts (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES probe_turns(id),
  attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
  answer TEXT,
  decision TEXT CHECK(decision IS NULL OR decision IN ('pass','revise','drop')),
  issues_json TEXT,
  feedback TEXT,
  answer_call_id INTEGER REFERENCES agent_calls(id),
  verify_call_id INTEGER REFERENCES agent_calls(id),
  UNIQUE(turn_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS probe_rubrics (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL UNIQUE REFERENCES probe_turns(id),
  rubric_json TEXT NOT NULL CHECK(json_valid(rubric_json)),
  call_id INTEGER REFERENCES agent_calls(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_calibrations (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES probe_runs(id),
  probe_id INTEGER NOT NULL REFERENCES probes(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  bare_model TEXT NOT NULL,
  grader_model TEXT NOT NULL,
  bare_answer TEXT,
  behavior_ok INTEGER CHECK(behavior_ok IS NULL OR behavior_ok IN (0,1)),
  stance INTEGER CHECK(stance IS NULL OR stance BETWEEN 0 AND 2),
  key_point_coverage REAL CHECK(key_point_coverage IS NULL OR key_point_coverage BETWEEN 0 AND 1),
  forbidden_hits INTEGER,
  hallucination_hits INTEGER,
  failure_signal_hits INTEGER,
  style INTEGER CHECK(style IS NULL OR style BETWEEN 0 AND 2),
  score REAL,
  detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
  bare_call_id INTEGER REFERENCES agent_calls(id),
  grade_call_id INTEGER REFERENCES agent_calls(id),
  created_at TEXT NOT NULL,
  UNIQUE(run_id, probe_id, turn_no)
);
CREATE INDEX IF NOT EXISTS idx_probe_calibrations_probe ON probe_calibrations(probe_id, run_id);

CREATE TABLE IF NOT EXISTS suite_versions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('in_distribution','adversarial')),
  item_count INTEGER NOT NULL CHECK(item_count >= 1),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suite_items (
  id INTEGER PRIMARY KEY,
  suite_id INTEGER NOT NULL REFERENCES suite_versions(id),
  item_key TEXT NOT NULL,
  video_key TEXT NOT NULL,
  probe_type TEXT,
  expected_behavior TEXT,
  difficulty TEXT CHECK(difficulty IS NULL OR difficulty IN ('easy','medium','hard')),
  messages_json TEXT NOT NULL CHECK(json_valid(messages_json)),
  rubrics_json TEXT NOT NULL CHECK(json_valid(rubrics_json)),
  UNIQUE(suite_id, item_key)
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY,
  suite_id INTEGER NOT NULL REFERENCES suite_versions(id),
  candidate TEXT NOT NULL CHECK(length(trim(candidate)) > 0),
  model TEXT NOT NULL CHECK(length(trim(model)) > 0),
  history_mode TEXT NOT NULL CHECK(history_mode IN ('gold','self')),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_suite_candidate ON eval_runs(suite_id, candidate, id);

CREATE TABLE IF NOT EXISTS eval_predictions (
  id INTEGER PRIMARY KEY,
  eval_run_id INTEGER NOT NULL REFERENCES eval_runs(id),
  suite_item_id INTEGER NOT NULL REFERENCES suite_items(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  output_text TEXT,
  error TEXT,
  call_id INTEGER REFERENCES agent_calls(id),
  created_at TEXT NOT NULL,
  UNIQUE(eval_run_id, suite_item_id, turn_no)
);
CREATE INDEX IF NOT EXISTS idx_eval_predictions_run ON eval_predictions(eval_run_id, suite_item_id, turn_no);

CREATE TABLE IF NOT EXISTS eval_scores (
  id INTEGER PRIMARY KEY,
  prediction_id INTEGER NOT NULL UNIQUE REFERENCES eval_predictions(id),
  grader_model TEXT NOT NULL,
  behavior_ok INTEGER NOT NULL CHECK(behavior_ok IN (0,1)),
  stance INTEGER NOT NULL CHECK(stance BETWEEN 0 AND 2),
  key_point_coverage REAL NOT NULL CHECK(key_point_coverage BETWEEN 0 AND 1),
  forbidden_hits INTEGER NOT NULL,
  hallucination_hits INTEGER NOT NULL,
  failure_signal_hits INTEGER NOT NULL,
  style INTEGER NOT NULL CHECK(style BETWEEN 0 AND 2),
  score REAL NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  call_id INTEGER REFERENCES agent_calls(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_calls (
  id INTEGER PRIMARY KEY,
  run_ref TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  input_refs_json TEXT NOT NULL CHECK(json_valid(input_refs_json)),
  output_text TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','completed','error','interrupted')),
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_calls_run_ref ON agent_calls(run_ref);

-- Immutability: snapshots and frozen suites are append-only.
CREATE TRIGGER IF NOT EXISTS trg_source_materials_no_update BEFORE UPDATE ON source_materials
BEGIN SELECT RAISE(ABORT, 'source_materials is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_source_materials_no_delete BEFORE DELETE ON source_materials
BEGIN SELECT RAISE(ABORT, 'source_materials is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_suite_versions_no_update BEFORE UPDATE ON suite_versions
BEGIN SELECT RAISE(ABORT, 'suite_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_suite_versions_no_delete BEFORE DELETE ON suite_versions
BEGIN SELECT RAISE(ABORT, 'suite_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_suite_items_no_update BEFORE UPDATE ON suite_items
BEGIN SELECT RAISE(ABORT, 'suite_items is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_suite_items_no_delete BEFORE DELETE ON suite_items
BEGIN SELECT RAISE(ABORT, 'suite_items is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_probes_accepted_frozen BEFORE UPDATE OF question, anchor, trap, expected_behavior ON probes
WHEN OLD.status = 'accepted'
BEGIN SELECT RAISE(ABORT, 'accepted probe text is frozen'); END;
`;

/**
 * Safely upgrades older eval.sqlite schemas in-place:
 * 1. Adds `suite_items.difficulty` if missing.
 * 2. Upgrades v1 `probe_specs` / `probes` / `probe_turns` CHECK constraints to accept `trap_*` probe types and `refuse`.
 */
export function migrateEvalSchema(
  db: DatabaseSync,
  hasColumn: (table: string, column: string) => boolean,
  transaction: <T>(fn: () => T) => T,
): void {
  if (!hasColumn("suite_items", "difficulty")) {
    db.exec("ALTER TABLE suite_items ADD COLUMN difficulty TEXT CHECK(difficulty IS NULL OR difficulty IN ('easy','medium','hard'));");
  }

  const specsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'probe_specs'")
    .get() as Row | undefined;
  const probesRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'probes'")
    .get() as Row | undefined;
  const turnsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'probe_turns'")
    .get() as Row | undefined;

  const specsSql = String(specsRow?.sql ?? "");
  const probesSql = String(probesRow?.sql ?? "");
  const turnsSql = String(turnsRow?.sql ?? "");
  if (
    specsSql.includes("'trap_misattribution'") &&
    probesSql.includes("'refuse'") &&
    turnsSql.includes("'refuse'")
  ) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    transaction(() => {
      db.exec("DROP TRIGGER IF EXISTS trg_probes_accepted_frozen;");
      db.exec(`
        CREATE TABLE probe_specs__v2 (
          id INTEGER PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES probe_runs(id),
          source_material_id INTEGER NOT NULL REFERENCES source_materials(id),
          slot_index INTEGER NOT NULL CHECK(slot_index >= 1),
          probe_type TEXT NOT NULL CHECK(probe_type IN (${q(PROBE_TYPES)})),
          persona TEXT NOT NULL,
          target_turns INTEGER NOT NULL CHECK(target_turns BETWEEN 1 AND 3),
          UNIQUE(run_id, source_material_id, slot_index)
        );
        INSERT INTO probe_specs__v2 SELECT id, run_id, source_material_id, slot_index, probe_type, persona, target_turns FROM probe_specs;
        DROP TABLE probe_specs;
        ALTER TABLE probe_specs__v2 RENAME TO probe_specs;

        CREATE TABLE probes__v2 (
          id INTEGER PRIMARY KEY,
          spec_id INTEGER NOT NULL UNIQUE REFERENCES probe_specs(id),
          question TEXT NOT NULL CHECK(length(trim(question)) > 0),
          anchor TEXT NOT NULL,
          trap TEXT NOT NULL,
          expected_behavior TEXT NOT NULL CHECK(expected_behavior IN (${q(EXPECTED_BEHAVIORS)})),
          status TEXT NOT NULL CHECK(status IN ('drafted','rejected','answering','dropped','error','accepted')),
          anchor_verified INTEGER NOT NULL DEFAULT 0 CHECK(anchor_verified IN (0,1)),
          revisions INTEGER NOT NULL DEFAULT 0,
          reject_reason TEXT,
          difficulty TEXT CHECK(difficulty IS NULL OR difficulty IN ('easy','medium','hard')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO probes__v2 SELECT id, spec_id, question, anchor, trap, expected_behavior, status, anchor_verified, revisions, reject_reason, difficulty, created_at, updated_at FROM probes;
        DROP TABLE probes;
        ALTER TABLE probes__v2 RENAME TO probes;

        CREATE TABLE probe_turns__v2 (
          id INTEGER PRIMARY KEY,
          probe_id INTEGER NOT NULL REFERENCES probes(id),
          turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
          user_content TEXT NOT NULL,
          tactic TEXT,
          expected_behavior TEXT NOT NULL CHECK(expected_behavior IN (${q(EXPECTED_BEHAVIORS)})),
          passed_attempt_id INTEGER,
          status TEXT NOT NULL CHECK(status IN ('running','pass','dropped','exhausted','error')),
          UNIQUE(probe_id, turn_no)
        );
        INSERT INTO probe_turns__v2 SELECT id, probe_id, turn_no, user_content, tactic, expected_behavior, passed_attempt_id, status FROM probe_turns;
        DROP TABLE probe_turns;
        ALTER TABLE probe_turns__v2 RENAME TO probe_turns;

        CREATE TRIGGER trg_probes_accepted_frozen BEFORE UPDATE OF question, anchor, trap, expected_behavior ON probes
        WHEN OLD.status = 'accepted'
        BEGIN SELECT RAISE(ABORT, 'accepted probe text is frozen'); END;
      `);
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }

  const fkErrors = db.prepare("PRAGMA foreign_key_check;").all() as Row[];
  if (fkErrors.length > 0) {
    throw new Error(`评测库迁移 schema v2 后外键校验失败：${JSON.stringify(fkErrors[0])}`);
  }
}
