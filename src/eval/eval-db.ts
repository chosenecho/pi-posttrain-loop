import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Independent evaluation store (`data/eval.sqlite`).
 * Data only flows main DB -> eval DB; the eval pipeline never writes the main DB.
 */

export const EVAL_SCHEMA_VERSION = "2";

export const ADVERSARIAL_PROBE_TYPES = [
  "wild_short",
  "premise_trap",
  "contrast",
  "transfer",
  "hallucination_bait",
  "pressure",
] as const;

export const TRAP_PROBE_TYPES = [
  "trap_misattribution",
  "trap_unknown_detail",
  "trap_forced_decision",
  "trap_unfounded_judgment",
] as const;

export const PROBE_TYPES = [
  ...ADVERSARIAL_PROBE_TYPES,
  ...TRAP_PROBE_TYPES,
] as const;
export type ProbeType = (typeof PROBE_TYPES)[number];

export type EvalProfile = "adversarial" | "trap";

export function isTrapProbeType(probeType: ProbeType): boolean {
  return (TRAP_PROBE_TYPES as readonly string[]).includes(probeType);
}

export function probeTypesForProfile(profile: EvalProfile): readonly ProbeType[] {
  return profile === "trap" ? TRAP_PROBE_TYPES : ADVERSARIAL_PROBE_TYPES;
}

export const EXPECTED_BEHAVIORS = [
  "answer",
  "correct_premise",
  "acknowledge_gap",
  "hold_position",
  "refuse",
] as const;
export type ExpectedBehavior = (typeof EXPECTED_BEHAVIORS)[number];

export const PRESSURE_ADVERSARY_TACTICS = [
  "pushback",
  "label",
  "force_binary",
  "flatter_flip",
  "emotional",
] as const;

export const TRAP_ADVERSARY_TACTICS = [
  "nudge_estimate",
  "assume_premise",
  "push_decision",
] as const;

export const ADVERSARY_TACTICS = [
  ...PRESSURE_ADVERSARY_TACTICS,
  ...TRAP_ADVERSARY_TACTICS,
] as const;
export type AdversaryTactic = (typeof ADVERSARY_TACTICS)[number];

export const DIFFICULTY_LEVELS = ["easy", "medium", "hard"] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

/** Expected behavior is decided by code from the probe type, never by the writer model. */
export const EXPECTED_BEHAVIOR_BY_TYPE: Record<ProbeType, ExpectedBehavior> = {
  wild_short: "answer",
  premise_trap: "correct_premise",
  contrast: "answer",
  transfer: "answer",
  hallucination_bait: "acknowledge_gap",
  pressure: "answer",
  trap_misattribution: "refuse",
  trap_unknown_detail: "refuse",
  trap_forced_decision: "refuse",
  trap_unfounded_judgment: "refuse",
};

export type ProbeStatus = "drafted" | "rejected" | "answering" | "dropped" | "error" | "accepted";
export type ProbeRunStatus = "running" | "completed" | "failed" | "interrupted";
export type EvalHistoryMode = "gold" | "self";

const q = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");

const SCHEMA_SQL = `
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

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface SourceMaterialRecord {
  id: number;
  videoId: string;
  videoKey: string;
  mainMaterialId: number | null;
  partCount: number;
  content: string;
  contentSha256: string;
  sourcePath: string | null;
  importedAt: string;
}

export interface ProbeRecord {
  id: number;
  specId: number;
  runId: number;
  sourceMaterialId: number;
  slotIndex: number;
  probeType: ProbeType;
  persona: string;
  targetTurns: number;
  question: string;
  anchor: string;
  trap: string;
  expectedBehavior: ExpectedBehavior;
  status: ProbeStatus;
  anchorVerified: boolean;
  revisions: number;
  rejectReason: string | null;
  difficulty: DifficultyLevel | null;
}

export interface CalibrationTurnRecord {
  id: number;
  runId: number;
  probeId: number;
  turnNo: number;
  bareModel: string;
  graderModel: string;
  bareAnswer: string | null;
  behaviorOk: boolean;
  stance: number;
  keyPointCoverage: number;
  forbiddenHits: number;
  hallucinationHits: number;
  failureSignalHits: number;
  style: number;
  score: number;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface SuiteVersionRecord {
  id: number;
  name: string;
  kind: "in_distribution" | "adversarial";
  itemCount: number;
  sha256: string;
  manifest: Record<string, unknown>;
  createdAt: string;
}

export interface SuiteItemRecord {
  id: number;
  suiteId: number;
  itemKey: string;
  videoKey: string;
  probeType: string | null;
  expectedBehavior: string | null;
  difficulty: DifficultyLevel | null;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  rubrics: unknown[];
}

export interface EvalRunRecord {
  id: number;
  suiteId: number;
  suiteName: string;
  suiteKind: "in_distribution" | "adversarial";
  candidate: string;
  model: string;
  historyMode: EvalHistoryMode;
  config: Record<string, unknown>;
  status: ProbeRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface EvalPredictionRecord {
  id: number;
  evalRunId: number;
  suiteItemId: number;
  turnNo: number;
  input: Record<string, unknown>;
  outputText: string | null;
  error: string | null;
  callId: number | null;
  createdAt: string;
}

export interface EvalScoreRecord {
  id: number;
  predictionId: number;
  evalRunId: number;
  suiteItemId: number;
  itemKey: string;
  videoKey: string;
  probeType: string | null;
  itemExpectedBehavior: string | null;
  difficulty: DifficultyLevel | null;
  turnNo: number;
  graderModel: string;
  behaviorOk: boolean;
  stance: number;
  keyPointCoverage: number;
  forbiddenHits: number;
  hallucinationHits: number;
  failureSignalHits: number;
  style: number;
  score: number;
  detail: Record<string, unknown>;
  callId: number | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

function mapSource(row: Row): SourceMaterialRecord {
  return {
    id: Number(row.id),
    videoId: String(row.video_id),
    videoKey: String(row.video_key),
    mainMaterialId: row.main_material_id === null ? null : Number(row.main_material_id),
    partCount: Number(row.part_count),
    content: String(row.content),
    contentSha256: String(row.content_sha256),
    sourcePath: row.source_path === null ? null : String(row.source_path),
    importedAt: String(row.imported_at),
  };
}

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

const PROBE_SELECT = `
  SELECT p.*, s.run_id, s.source_material_id, s.slot_index, s.probe_type, s.persona, s.target_turns
  FROM probes p JOIN probe_specs s ON s.id = p.spec_id`;

export class EvalStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly && databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath, { readOnly: options.readOnly ?? false });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (!options.readOnly) {
      if (databasePath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(SCHEMA_SQL);
      if (!this.hasColumn("suite_items", "difficulty")) {
        this.db.exec("ALTER TABLE suite_items ADD COLUMN difficulty TEXT CHECK(difficulty IS NULL OR difficulty IN ('easy','medium','hard'));");
      }
      this.migrateProbeCheckConstraintsIfNeeded();
      this.setMeta("schema_version", EVAL_SCHEMA_VERSION);
      this.db.prepare("INSERT OR IGNORE INTO eval_meta (key, value) VALUES ('created_at', ?)").run(nowIso());
    }
  }

  /**
   * Safely upgrades schema v1 `probe_specs` / `probes` / `probe_turns` CHECK constraints in-place
   * to accept `trap_*` probe types and `refuse` expected behavior without touching existing data.
   */
  private migrateProbeCheckConstraintsIfNeeded(): void {
    const specsRow = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'probe_specs'")
      .get() as Row | undefined;
    const probesRow = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'probes'")
      .get() as Row | undefined;
    const turnsRow = this.db
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

    this.db.exec("PRAGMA foreign_keys = OFF;");
    try {
      this.transaction(() => {
        this.db.exec("DROP TRIGGER IF EXISTS trg_probes_accepted_frozen;");

        this.db.exec(`
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
      this.db.exec("PRAGMA foreign_keys = ON;");
    }

    const fkErrors = this.db.prepare("PRAGMA foreign_key_check;").all() as Row[];
    if (fkErrors.length > 0) {
      throw new Error(`评测库迁移 schema v2 后外键校验失败：${JSON.stringify(fkErrors[0])}`);
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO eval_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM eval_meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  // ---------- source materials ----------

  insertSourceMaterial(input: {
    videoId: string;
    videoKey: string;
    mainMaterialId?: number | null;
    partCount: number;
    content: string;
    sourcePath?: string | null;
    splitSnapshot: string;
  }): { record: SourceMaterialRecord; created: boolean } {
    if (input.splitSnapshot !== "test") {
      throw new Error(`评测库只接受 test 分区材料：${input.videoKey} 实际为 ${input.splitSnapshot}`);
    }
    const contentSha256 = sha256Hex(input.content);
    const existing = this.getSourceMaterialByVideoId(input.videoId);
    if (existing) {
      if (existing.contentSha256 !== contentSha256) {
        throw new Error(`材料快照 ${input.videoId} 已存在且内容不同（sha256 ${existing.contentSha256.slice(0, 12)}），禁止覆盖`);
      }
      return { record: existing, created: false };
    }
    this.db.prepare(`
      INSERT INTO source_materials (video_id, video_key, main_material_id, split_snapshot, part_count, content, content_sha256, source_path, imported_at)
      VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?)
    `).run(
      input.videoId,
      input.videoKey,
      input.mainMaterialId ?? null,
      input.partCount,
      input.content,
      contentSha256,
      input.sourcePath ?? null,
      nowIso(),
    );
    const record = this.getSourceMaterialByVideoId(input.videoId);
    if (!record) throw new Error(`无法读取材料快照：${input.videoId}`);
    return { record, created: true };
  }

  getSourceMaterialByVideoId(videoId: string): SourceMaterialRecord | undefined {
    const row = this.db.prepare("SELECT * FROM source_materials WHERE video_id = ?").get(videoId) as Row | undefined;
    return row ? mapSource(row) : undefined;
  }

  getSourceMaterial(id: number): SourceMaterialRecord | undefined {
    const row = this.db.prepare("SELECT * FROM source_materials WHERE id = ?").get(id) as Row | undefined;
    return row ? mapSource(row) : undefined;
  }

  listSourceMaterials(): SourceMaterialRecord[] {
    return (this.db.prepare("SELECT * FROM source_materials ORDER BY id").all() as Row[]).map(mapSource);
  }

  /** Source materials that have never been used by any probe_build run (optionally scoped to probeTypes). */
  listUnbuiltSourceMaterials(probeTypes?: readonly ProbeType[]): SourceMaterialRecord[] {
    if (probeTypes && probeTypes.length > 0) {
      const placeholders = probeTypes.map(() => "?").join(", ");
      return (this.db.prepare(`
        SELECT * FROM source_materials m
        WHERE NOT EXISTS (
          SELECT 1 FROM probe_specs s
          WHERE s.source_material_id = m.id
            AND s.probe_type IN (${placeholders})
        )
        ORDER BY id
      `).all(...probeTypes) as Row[]).map(mapSource);
    }
    return (this.db.prepare(`
      SELECT * FROM source_materials m
      WHERE NOT EXISTS (SELECT 1 FROM probe_specs s WHERE s.source_material_id = m.id)
      ORDER BY id
    `).all() as Row[]).map(mapSource);
  }

  listSourceMaterialsByVideoKeys(videoKeys: string[]): SourceMaterialRecord[] {
    if (videoKeys.length === 0) return [];
    const placeholders = videoKeys.map(() => "?").join(", ");
    return (this.db.prepare(`
      SELECT * FROM source_materials
      WHERE video_key IN (${placeholders}) OR video_id IN (${placeholders})
      ORDER BY id
    `).all(...videoKeys, ...videoKeys) as Row[]).map(mapSource);
  }

  /**
   * Returns existing turn-1 questions for a videoKey across frozen suites (e.g. indist-v1)
   * and non-rejected probes, used for deterministic n-gram deduplication.
   */
  listExistingQuestionsForVideoKey(videoKey: string): string[] {
    const questions: string[] = [];
    const probeRows = this.db.prepare(`
      SELECT p.question
      FROM probes p
      JOIN probe_specs s ON s.id = p.spec_id
      JOIN source_materials m ON m.id = s.source_material_id
      WHERE m.video_key = ? AND p.status != 'rejected'
    `).all(videoKey) as Row[];
    for (const row of probeRows) {
      questions.push(String(row.question));
    }
    const suiteRows = this.db.prepare(`
      SELECT messages_json FROM suite_items WHERE video_key = ?
    `).all(videoKey) as Row[];
    for (const row of suiteRows) {
      try {
        const messages = JSON.parse(String(row.messages_json)) as Array<{ role?: string; content?: string }>;
        const firstUser = messages.find((m) => m.role === "user" && typeof m.content === "string");
        if (firstUser?.content) questions.push(firstUser.content);
      } catch {
        // Ignore malformed messages_json
      }
    }
    return questions;
  }

  listEvalVideoKeys(): Set<string> {
    const keys = new Set<string>();
    for (const row of this.db.prepare("SELECT DISTINCT video_key FROM source_materials").all() as Row[]) {
      keys.add(String(row.video_key));
    }
    for (const row of this.db.prepare("SELECT DISTINCT video_key FROM suite_items").all() as Row[]) {
      keys.add(String(row.video_key));
    }
    return keys;
  }

  // ---------- runs & calls ----------

  createRun(input: {
    kind: "probe_build" | "calibrate" | "mirror";
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

  /** Lists currently running runs (used to guard against freezing while build/calibrate is still writing). */
  listActiveRuns(kinds?: readonly ("probe_build" | "calibrate" | "mirror")[]): Array<{
    id: number;
    kind: string;
    startedAt: string;
  }> {
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

  /** Returns current accepted probe counts per probe_type for soft global mix guidance. */
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

  getRun(runId: number): {
    id: number;
    kind: string;
    status: ProbeRunStatus;
    config: Record<string, unknown>;
    skills: unknown[];
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
  } | undefined {
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

  listReviews(probeId: number): Array<{
    id: number;
    roundNo: number;
    decision: "accept" | "revise" | "reject";
    issues: string[];
    feedback: string;
    questionSnapshot: string;
    callId: number | null;
    createdAt: string;
  }> {
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

  listAttemptsForProbe(probeId: number): Array<{
    turnNo: number;
    attemptNo: number;
    answer: string | null;
    decision: "pass" | "revise" | "drop" | null;
    issues: string[];
    feedback: string | null;
  }> {
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

  getSummary(): {
    schemaVersion: string | undefined;
    mainDbPath: string | undefined;
    sourceMaterials: number;
    unbuiltSourceMaterials: number;
    sourceVideoKeys: number;
    probeRuns: number;
    probesByStatus: Record<string, number>;
    acceptedByType: Record<string, number>;
    acceptedByDifficulty: Record<string, number>;
    suites: Array<{ name: string; kind: string; itemCount: number; sha256: string; createdAt: string }>;
    evalRuns: Array<{
      id: number;
      suiteName: string;
      candidate: string;
      model: string;
      historyMode: EvalHistoryMode;
      status: ProbeRunStatus;
      predictions: number;
      scores: number;
      startedAt: string;
    }>;
    agentCalls: number;
  } {
    const sourceMaterials = Number((this.db.prepare("SELECT count(*) AS c FROM source_materials").get() as Row).c);
    const unbuiltSourceMaterials = Number((this.db.prepare(
      "SELECT count(*) AS c FROM source_materials m WHERE NOT EXISTS (SELECT 1 FROM probe_specs s WHERE s.source_material_id = m.id)",
    ).get() as Row).c);
    const sourceVideoKeys = Number((this.db.prepare("SELECT count(DISTINCT video_key) AS c FROM source_materials").get() as Row).c);
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
    const evalRuns: Array<{
      id: number;
      suiteName: string;
      candidate: string;
      model: string;
      historyMode: EvalHistoryMode;
      status: ProbeRunStatus;
      predictions: number;
      scores: number;
      startedAt: string;
    }> = this.hasTable("eval_runs")
      ? (this.db.prepare(`
          SELECT
            er.id,
            sv.name AS suite_name,
            er.candidate,
            er.model,
            er.history_mode,
            er.status,
            er.started_at,
            (SELECT count(*) FROM eval_predictions ep WHERE ep.eval_run_id = er.id AND ep.output_text IS NOT NULL AND ep.error IS NULL) AS predictions,
            (SELECT count(*) FROM eval_scores es JOIN eval_predictions ep ON ep.id = es.prediction_id WHERE ep.eval_run_id = er.id) AS scores
          FROM eval_runs er
          JOIN suite_versions sv ON sv.id = er.suite_id
          ORDER BY er.id
        `).all() as Row[]).map((row) => ({
          id: Number(row.id),
          suiteName: String(row.suite_name),
          candidate: String(row.candidate),
          model: String(row.model),
          historyMode: row.history_mode as EvalHistoryMode,
          status: row.status as ProbeRunStatus,
          predictions: Number(row.predictions),
          scores: Number(row.scores),
          startedAt: String(row.started_at),
        }))
      : [];
    return {
      schemaVersion: this.getMeta("schema_version"),
      mainDbPath: this.getMeta("main_db_path"),
      sourceMaterials,
      unbuiltSourceMaterials,
      sourceVideoKeys,
      probeRuns,
      probesByStatus,
      acceptedByType,
      acceptedByDifficulty,
      suites: this.listSuites(),
      evalRuns,
      agentCalls,
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

  // ---------- specs & probes ----------

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

  hasTable(name: string): boolean {
    const row = this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as Row | undefined;
    return row !== undefined;
  }

  hasColumn(table: string, column: string): boolean {
    if (!this.hasTable(table)) return false;
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return rows.some((r) => String(r.name) === column);
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

  // ---------- turns, attempts, rubrics ----------

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

  saveRubric(input: { turnId: number; rubric: unknown; callId: number | null }): void {
    this.db.prepare(`
      INSERT INTO probe_rubrics (turn_id, rubric_json, call_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET rubric_json = excluded.rubric_json, call_id = excluded.call_id, created_at = excluded.created_at
    `).run(input.turnId, JSON.stringify(input.rubric), input.callId, nowIso());
  }

  /** Passed turns (with reference answer + rubric) of one probe, ordered by turn. */
  getProbeDialogue(probeId: number): Array<{ turnNo: number; user: string; answer: string; expectedBehavior: ExpectedBehavior; tactic: string | null; rubric: unknown }> {
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

  // ---------- suites ----------

  getSuite(name: string): SuiteVersionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM suite_versions WHERE name = ?").get(name) as Row | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      name: String(row.name),
      kind: row.kind as "in_distribution" | "adversarial",
      itemCount: Number(row.item_count),
      sha256: String(row.sha256),
      manifest: JSON.parse(String(row.manifest_json)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    };
  }

  getSuiteById(id: number): SuiteVersionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM suite_versions WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      name: String(row.name),
      kind: row.kind as "in_distribution" | "adversarial",
      itemCount: Number(row.item_count),
      sha256: String(row.sha256),
      manifest: JSON.parse(String(row.manifest_json)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    };
  }

  listSuites(): Array<{ name: string; kind: string; itemCount: number; sha256: string; createdAt: string }> {
    return (this.db.prepare("SELECT name, kind, item_count, sha256, created_at FROM suite_versions ORDER BY id").all() as Row[]).map((row) => ({
      name: String(row.name),
      kind: String(row.kind),
      itemCount: Number(row.item_count),
      sha256: String(row.sha256),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * Freezes a suite atomically. Idempotent when name + sha256 match; refuses to overwrite different content.
   */
  freezeSuite(input: {
    name: string;
    kind: "in_distribution" | "adversarial";
    sha256: string;
    manifest: Record<string, unknown>;
    items: Array<{
      itemKey: string;
      videoKey: string;
      probeType: string | null;
      expectedBehavior: string | null;
      difficulty?: DifficultyLevel | null;
      messages: unknown[];
      rubrics: unknown[];
    }>;
  }): { created: boolean; suite: SuiteVersionRecord } {
    if (input.items.length === 0) throw new Error(`套卷 ${input.name} 没有任何条目，无法冻结`);
    const existing = this.getSuite(input.name);
    if (existing) {
      if (existing.sha256 === input.sha256) return { created: false, suite: existing };
      throw new Error(`套卷 ${input.name} 已冻结（sha256=${existing.sha256.slice(0, 12)}），禁止覆盖为不同内容`);
    }
    this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO suite_versions (name, kind, item_count, manifest_json, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.name, input.kind, input.items.length, JSON.stringify(input.manifest), input.sha256, nowIso());
      const suiteId = Number(result.lastInsertRowid);
      const stmt = this.db.prepare(`
        INSERT INTO suite_items (suite_id, item_key, video_key, probe_type, expected_behavior, difficulty, messages_json, rubrics_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of input.items) {
        stmt.run(
          suiteId,
          item.itemKey,
          item.videoKey,
          item.probeType,
          item.expectedBehavior,
          item.difficulty ?? null,
          JSON.stringify(item.messages),
          JSON.stringify(item.rubrics),
        );
      }
    });
    const suite = this.getSuite(input.name);
    if (!suite) throw new Error(`无法读取冻结套卷：${input.name}`);
    return { created: true, suite };
  }

  listSuiteItems(name: string): SuiteItemRecord[] {
    const suite = this.getSuite(name);
    if (!suite) throw new Error(`未找到套卷：${name}`);
    return this.listSuiteItemsBySuiteId(suite.id);
  }

  listSuiteItemsBySuiteId(suiteId: number): SuiteItemRecord[] {
    const hasDifficulty = this.hasColumn("suite_items", "difficulty");
    return (this.db.prepare("SELECT * FROM suite_items WHERE suite_id = ? ORDER BY id").all(suiteId) as Row[]).map((row) => ({
      id: Number(row.id),
      suiteId: Number(row.suite_id),
      itemKey: String(row.item_key),
      videoKey: String(row.video_key),
      probeType: row.probe_type === null ? null : String(row.probe_type),
      expectedBehavior: row.expected_behavior === null ? null : String(row.expected_behavior),
      difficulty: !hasDifficulty || row.difficulty === null || row.difficulty === undefined
        ? null
        : (row.difficulty as DifficultyLevel),
      messages: JSON.parse(String(row.messages_json)) as Array<{ role: "user" | "assistant" | "system"; content: string }>,
      rubrics: JSON.parse(String(row.rubrics_json)) as unknown[],
    }));
  }

  // ---------- M3 / P2 candidate eval runs, predictions & scores ----------

  createEvalRun(input: {
    suiteId: number;
    candidate: string;
    model: string;
    historyMode: EvalHistoryMode;
    config: Record<string, unknown>;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO eval_runs (suite_id, candidate, model, history_mode, config_json, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `).run(input.suiteId, input.candidate, input.model, input.historyMode, JSON.stringify(input.config), nowIso());
    return Number(result.lastInsertRowid);
  }

  reopenEvalRun(evalRunId: number, configPatch?: Record<string, unknown>): void {
    const existing = this.getEvalRun(evalRunId);
    if (!existing) throw new Error(`未找到评测运行：eval_run #${evalRunId}`);
    const mergedConfig = configPatch ? { ...existing.config, ...configPatch } : existing.config;
    this.db.prepare("UPDATE eval_runs SET status = 'running', finished_at = NULL, error = NULL, config_json = ? WHERE id = ?")
      .run(JSON.stringify(mergedConfig), evalRunId);
  }

  finishEvalRun(evalRunId: number, status: ProbeRunStatus, error?: string): void {
    this.db.prepare("UPDATE eval_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(status, nowIso(), error ?? null, evalRunId);
  }

  getEvalRun(evalRunId: number): EvalRunRecord | undefined {
    if (!this.hasTable("eval_runs")) return undefined;
    const row = this.db.prepare(`
      SELECT er.*, sv.name AS suite_name, sv.kind AS suite_kind
      FROM eval_runs er
      JOIN suite_versions sv ON sv.id = er.suite_id
      WHERE er.id = ?
    `).get(evalRunId) as Row | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      suiteId: Number(row.suite_id),
      suiteName: String(row.suite_name),
      suiteKind: row.suite_kind as "in_distribution" | "adversarial",
      candidate: String(row.candidate),
      model: String(row.model),
      historyMode: row.history_mode as EvalHistoryMode,
      config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
      status: row.status as ProbeRunStatus,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      error: row.error === null ? null : String(row.error),
    };
  }

  listEvalRuns(filter: {
    suiteName?: string;
    candidate?: string;
    historyMode?: EvalHistoryMode;
    status?: ProbeRunStatus;
  } = {}): EvalRunRecord[] {
    if (!this.hasTable("eval_runs")) return [];
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.suiteName !== undefined) { where.push("sv.name = ?"); params.push(filter.suiteName); }
    if (filter.candidate !== undefined) { where.push("er.candidate = ?"); params.push(filter.candidate); }
    if (filter.historyMode !== undefined) { where.push("er.history_mode = ?"); params.push(filter.historyMode); }
    if (filter.status !== undefined) { where.push("er.status = ?"); params.push(filter.status); }
    const sql = `
      SELECT er.*, sv.name AS suite_name, sv.kind AS suite_kind
      FROM eval_runs er
      JOIN suite_versions sv ON sv.id = er.suite_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY er.id
    `;
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => ({
      id: Number(row.id),
      suiteId: Number(row.suite_id),
      suiteName: String(row.suite_name),
      suiteKind: row.suite_kind as "in_distribution" | "adversarial",
      candidate: String(row.candidate),
      model: String(row.model),
      historyMode: row.history_mode as EvalHistoryMode,
      config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
      status: row.status as ProbeRunStatus,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      error: row.error === null ? null : String(row.error),
    }));
  }

  latestEvalRunId(filter: { suiteName?: string; candidate?: string; historyMode?: EvalHistoryMode } = {}): number | undefined {
    const runs = this.listEvalRuns(filter);
    return runs.length > 0 ? runs[runs.length - 1]!.id : undefined;
  }

  saveEvalPrediction(input: {
    evalRunId: number;
    suiteItemId: number;
    turnNo: number;
    input: Record<string, unknown>;
    outputText: string | null;
    error: string | null;
    callId: number | null;
  }): number {
    this.db.prepare(`
      INSERT INTO eval_predictions (eval_run_id, suite_item_id, turn_no, input_json, output_text, error, call_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(eval_run_id, suite_item_id, turn_no) DO UPDATE SET
        input_json = excluded.input_json,
        output_text = excluded.output_text,
        error = excluded.error,
        call_id = excluded.call_id,
        created_at = excluded.created_at
    `).run(
      input.evalRunId,
      input.suiteItemId,
      input.turnNo,
      JSON.stringify(input.input),
      input.outputText,
      input.error,
      input.callId,
      nowIso(),
    );
    const row = this.db.prepare(
      "SELECT id FROM eval_predictions WHERE eval_run_id = ? AND suite_item_id = ? AND turn_no = ?",
    ).get(input.evalRunId, input.suiteItemId, input.turnNo) as Row;
    return Number(row.id);
  }

  listEvalPredictions(evalRunId: number): EvalPredictionRecord[] {
    if (!this.hasTable("eval_predictions")) return [];
    return (this.db.prepare(
      "SELECT * FROM eval_predictions WHERE eval_run_id = ? ORDER BY suite_item_id, turn_no",
    ).all(evalRunId) as Row[]).map((row) => ({
      id: Number(row.id),
      evalRunId: Number(row.eval_run_id),
      suiteItemId: Number(row.suite_item_id),
      turnNo: Number(row.turn_no),
      input: JSON.parse(String(row.input_json)) as Record<string, unknown>,
      outputText: row.output_text === null ? null : String(row.output_text),
      error: row.error === null ? null : String(row.error),
      callId: row.call_id === null ? null : Number(row.call_id),
      createdAt: String(row.created_at),
    }));
  }

  saveEvalScore(input: {
    predictionId: number;
    graderModel: string;
    behaviorOk: boolean;
    stance: number;
    keyPointCoverage: number;
    forbiddenHits: number;
    hallucinationHits: number;
    failureSignalHits: number;
    style: number;
    score: number;
    detail: Record<string, unknown>;
    callId: number | null;
  }): void {
    this.db.prepare(`
      INSERT INTO eval_scores (
        prediction_id, grader_model, behavior_ok, stance, key_point_coverage,
        forbidden_hits, hallucination_hits, failure_signal_hits, style, score, detail_json, call_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prediction_id) DO UPDATE SET
        grader_model = excluded.grader_model,
        behavior_ok = excluded.behavior_ok,
        stance = excluded.stance,
        key_point_coverage = excluded.key_point_coverage,
        forbidden_hits = excluded.forbidden_hits,
        hallucination_hits = excluded.hallucination_hits,
        failure_signal_hits = excluded.failure_signal_hits,
        style = excluded.style,
        score = excluded.score,
        detail_json = excluded.detail_json,
        call_id = excluded.call_id,
        created_at = excluded.created_at
    `).run(
      input.predictionId,
      input.graderModel,
      input.behaviorOk ? 1 : 0,
      input.stance,
      input.keyPointCoverage,
      input.forbiddenHits,
      input.hallucinationHits,
      input.failureSignalHits,
      input.style,
      input.score,
      JSON.stringify(input.detail),
      input.callId,
      nowIso(),
    );
  }

  listEvalScores(evalRunId: number): EvalScoreRecord[] {
    if (!this.hasTable("eval_scores")) return [];
    const hasDifficulty = this.hasColumn("suite_items", "difficulty");
    const difficultyCol = hasDifficulty ? "si.difficulty" : "NULL AS difficulty";
    return (this.db.prepare(`
      SELECT
        es.*,
        ep.eval_run_id,
        ep.suite_item_id,
        ep.turn_no,
        si.item_key,
        si.video_key,
        si.probe_type,
        si.expected_behavior AS item_expected_behavior,
        ${difficultyCol}
      FROM eval_scores es
      JOIN eval_predictions ep ON ep.id = es.prediction_id
      JOIN suite_items si ON si.id = ep.suite_item_id
      WHERE ep.eval_run_id = ?
      ORDER BY ep.suite_item_id, ep.turn_no
    `).all(evalRunId) as Row[]).map((row) => ({
      id: Number(row.id),
      predictionId: Number(row.prediction_id),
      evalRunId: Number(row.eval_run_id),
      suiteItemId: Number(row.suite_item_id),
      itemKey: String(row.item_key),
      videoKey: String(row.video_key),
      probeType: row.probe_type === null ? null : String(row.probe_type),
      itemExpectedBehavior: row.item_expected_behavior === null ? null : String(row.item_expected_behavior),
      difficulty: row.difficulty === null || row.difficulty === undefined ? null : (row.difficulty as DifficultyLevel),
      turnNo: Number(row.turn_no),
      graderModel: String(row.grader_model),
      behaviorOk: Number(row.behavior_ok) === 1,
      stance: Number(row.stance),
      keyPointCoverage: Number(row.key_point_coverage),
      forbiddenHits: Number(row.forbidden_hits),
      hallucinationHits: Number(row.hallucination_hits),
      failureSignalHits: Number(row.failure_signal_hits),
      style: Number(row.style),
      score: Number(row.score),
      detail: JSON.parse(String(row.detail_json)) as Record<string, unknown>,
      callId: row.call_id === null ? null : Number(row.call_id),
      createdAt: String(row.created_at),
    }));
  }
}
