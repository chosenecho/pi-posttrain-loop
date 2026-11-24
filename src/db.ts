import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nonEmpty, validateMaxAttempts, validateSplit } from "./schema.js";
import type {
  DatasetSplit,
  EvalRubric,
  Review,
  SplitAssignMethod,
} from "./types.js";

/**
 * Maps legacy part-level video_ids (e.g. BVxxxx/P001, youtube/abc/P001),
 * multi-P chunk range IDs (e.g. BV1aU4y1b7mX/P001-P005),
 * and video-level video_ids (e.g. BV1Dt4y1Y7S2, youtube/abc, audio/xyz) to the same canonical video key.
 */
export function extractVideoKey(videoId: string): string {
  return videoId.trim().replace(/\/P\d+(?:-P\d+)?$/i, "");
}

export type RunKind = "question_generation" | "answer_judge";
export type RunStatus = "running" | "completed" | "interrupted" | "error";
export type RunItemStatus = "pending" | "running" | "pass" | "drop" | "exhausted" | "error" | "interrupted";
export type TurnStatus = "running" | "pass" | "drop" | "exhausted" | "error" | "interrupted";
export type AttemptStatus = "running" | "completed" | "error" | "interrupted";
export type CallRole = "question" | "followup" | "answer" | "judge";
export type CallStatus = "running" | "completed" | "error" | "interrupted";

export interface MaterialRecord {
  id: number;
  video_id: string;
  content: string;
  sha256: string;
  source_path: string | null;
  created_at: string;
}

export interface QuestionRecord {
  id: number;
  material_id: number;
  question: string;
  generation_run_id: number | null;
  created_at: string;
}

export interface RunRecord {
  id: number;
  kind: RunKind;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  max_attempts: number;
  max_turns: number;
  config_json: string;
  prompts_json: string;
  skills_json: string;
  export_policy_json: string;
  import_key: string | null;
  error: string | null;
}

export interface ResultTurnRow {
  result_id: number;
  run_id: number;
  question_id: number;
  material_id: number;
  turn_count: number;
  turn_no: number;
  user_content: string;
  assistant_content: string;
  attempt_no: number;
}

export interface TrainingMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TrainingSampleLine {
  messages: TrainingMessage[];
}

export interface ExportOptions {
  systemPrompt?: string;
}

export type DedupPolicy = "latest" | "earliest" | "error";

export interface MergedExportOptions extends ExportOptions {
  runIds?: number[];
  allFormal?: boolean;
  split?: DatasetSplit;
  versionName?: string;
  excludeRunIds?: number[];
  minTurns?: number;
  maxTurns?: number;
  dedup?: DedupPolicy;
  shuffle?: boolean;
  seed?: number;
  valRatio?: number;
}

export interface VideoSplitRecord {
  video_key: string;
  split: DatasetSplit;
  method: SplitAssignMethod;
  salt: string;
  assigned_at: string;
}

export interface TestSetVersionRecord {
  id: number;
  name: string;
  split: "test" | "dpo";
  result_ids_json: string;
  sample_count: number;
  video_count: number;
  manifest_json: string;
  sha256: string;
  created_at: string;
}

export interface EvalRubricRecord {
  id: number;
  result_id: number;
  turn_no: number;
  rubric: EvalRubric;
  rubric_json: string;
  call_id: number | null;
  created_at: string;
}

export interface MergedExportRecord {
  resultId: number;
  runId: number;
  questionId: number;
  materialId: number;
  turnCount: number;
  sample: TrainingSampleLine;
}

export interface MergedExportResult {
  train: MergedExportRecord[];
  val: MergedExportRecord[];
  includedRunIds: number[];
  countsByRunId: Record<number, number>;
  turnCountDistribution: Record<number, number>;
  duplicateQuestionsResolved: number;
  materialCount: number;
  trainMaterialCount: number;
  valMaterialCount: number;
}

export interface CreateRunInput {
  kind: RunKind;
  status?: RunStatus;
  startedAt?: string;
  finishedAt?: string | null;
  maxAttempts: number;
  maxTurns?: number;
  config: Record<string, unknown>;
  prompts: Record<string, unknown>;
  skills: unknown[];
  exportPolicy: Record<string, unknown>;
  importKey?: string | null;
  error?: string | null;
}

export interface InterruptedCounts {
  runs: number;
  runItems: number;
  turns: number;
  attempts: number;
  modelCalls: number;
}

export interface IntegrityReport {
  foreignKeyViolations: unknown[];
  integrityCheck: string[];
  ok: boolean;
}

export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic Mulberry32 PRNG for reproducible dataset shuffling and splitting. */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function formatSamplesJsonl(samples: TrainingSampleLine[]): string {
  if (samples.length === 0) return "";
  return samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n";
}

export function validateMaxTurns(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("maxTurns 必须是 1–20 的整数");
  }
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertObjectJson(value: unknown, label: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return JSON.stringify(value);
}

function assertArrayJson(value: unknown, label: string): string {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 数组`);
  }
  return JSON.stringify(value);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL CHECK(length(trim(video_id)) > 0),
  content TEXT NOT NULL CHECK(length(trim(content)) > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  source_path TEXT,
  created_at TEXT NOT NULL CHECK(length(trim(created_at)) > 0),
  UNIQUE(video_id, sha256)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('question_generation', 'answer_judge')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'interrupted', 'error')),
  started_at TEXT NOT NULL CHECK(length(trim(started_at)) > 0),
  finished_at TEXT,
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
  max_turns INTEGER NOT NULL DEFAULT 1 CHECK(max_turns BETWEEN 1 AND 20),
  config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json) = 'object'),
  prompts_json TEXT NOT NULL CHECK(json_valid(prompts_json) AND json_type(prompts_json) = 'object'),
  skills_json TEXT NOT NULL CHECK(json_valid(skills_json) AND json_type(skills_json) = 'array'),
  export_policy_json TEXT NOT NULL CHECK(json_valid(export_policy_json) AND json_type(export_policy_json) = 'object'),
  import_key TEXT UNIQUE,
  error TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  question TEXT NOT NULL CHECK(length(trim(question)) > 0),
  generation_run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL CHECK(length(trim(created_at)) > 0),
  UNIQUE(material_id, question)
);

CREATE TABLE IF NOT EXISTS run_items (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  question_id INTEGER NOT NULL REFERENCES questions(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'pass', 'drop', 'exhausted', 'error', 'interrupted')),
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  UNIQUE(run_id, question_id)
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  run_item_id INTEGER NOT NULL REFERENCES run_items(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  user_content TEXT,
  status TEXT NOT NULL CHECK(status IN ('running', 'pass', 'drop', 'exhausted', 'error', 'interrupted')),
  passed_attempt_id INTEGER UNIQUE REFERENCES attempts(id),
  started_at TEXT NOT NULL CHECK(length(trim(started_at)) > 0),
  finished_at TEXT,
  error TEXT,
  UNIQUE(run_item_id, turn_no),
  CHECK(
    (turn_no = 1 AND user_content IS NULL) OR
    (turn_no > 1 AND user_content IS NOT NULL AND length(trim(user_content)) > 0)
  ),
  CHECK(
    (status = 'pass' AND passed_attempt_id IS NOT NULL) OR
    (status != 'pass' AND passed_attempt_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'error', 'interrupted')),
  answer TEXT CHECK(answer IS NULL OR length(trim(answer)) > 0),
  decision TEXT CHECK(decision IS NULL OR decision IN ('pass', 'revise', 'drop')),
  issues_json TEXT CHECK(issues_json IS NULL OR (json_valid(issues_json) AND json_type(issues_json) = 'array')),
  feedback TEXT,
  started_at TEXT NOT NULL CHECK(length(trim(started_at)) > 0),
  finished_at TEXT,
  error TEXT,
  UNIQUE(turn_id, attempt_no),
  CHECK(
    decision IS NULL OR
    (status = 'completed' AND answer IS NOT NULL AND issues_json IS NOT NULL AND feedback IS NOT NULL)
  ),
  CHECK(
    decision IS NULL OR decision != 'pass' OR json_array_length(issues_json) = 0
  )
);

CREATE TABLE IF NOT EXISTS model_calls (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  turn_id INTEGER REFERENCES turns(id),
  attempt_id INTEGER REFERENCES attempts(id),
  material_id INTEGER REFERENCES materials(id),
  role TEXT NOT NULL CHECK(role IN ('question', 'followup', 'answer', 'judge')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'error', 'interrupted')),
  input_refs_json TEXT NOT NULL CHECK(json_valid(input_refs_json) AND json_type(input_refs_json) = 'object'),
  output_text TEXT,
  error TEXT,
  started_at TEXT NOT NULL CHECK(length(trim(started_at)) > 0),
  finished_at TEXT,
  CHECK(
    (role = 'question' AND material_id IS NOT NULL AND turn_id IS NULL AND attempt_id IS NULL) OR
    (role = 'followup' AND turn_id IS NOT NULL AND attempt_id IS NULL AND material_id IS NULL) OR
    (role IN ('answer', 'judge') AND turn_id IS NOT NULL AND attempt_id IS NOT NULL AND material_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  run_item_id INTEGER NOT NULL UNIQUE REFERENCES run_items(id),
  turn_count INTEGER NOT NULL CHECK(turn_count >= 1),
  created_at TEXT NOT NULL CHECK(length(trim(created_at)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_questions_material_id ON questions(material_id);
CREATE INDEX IF NOT EXISTS idx_run_items_question_id ON run_items(question_id);
CREATE INDEX IF NOT EXISTS idx_turns_run_item_turn ON turns(run_item_id, turn_no);
CREATE INDEX IF NOT EXISTS idx_attempts_turn_attempt ON attempts(turn_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_model_calls_run_id ON model_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_model_calls_turn_id ON model_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_model_calls_attempt_id ON model_calls(attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_calls_attempt_role
  ON model_calls(attempt_id, role) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_calls_followup_turn
  ON model_calls(turn_id, role) WHERE role = 'followup';

-- Turn invariants
CREATE TRIGGER IF NOT EXISTS trg_turns_validate_insert
BEFORE INSERT ON turns
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM results WHERE run_item_id = NEW.run_item_id)
    THEN RAISE(ABORT, 'cannot add turn to run_item already referenced by results')
  END;
  SELECT CASE
    WHEN NEW.turn_no > (
      SELECT r.max_turns FROM runs r JOIN run_items i ON i.run_id = r.id WHERE i.id = NEW.run_item_id
    )
    THEN RAISE(ABORT, 'turn_no exceeds run max_turns')
  END;
  SELECT CASE
    WHEN NEW.passed_attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM attempts a
      WHERE a.id = NEW.passed_attempt_id
        AND a.turn_id = NEW.id
        AND a.status = 'completed'
        AND a.decision = 'pass'
    )
    THEN RAISE(ABORT, 'passed_attempt_id must reference a completed pass attempt of this turn')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_turns_validate_update
BEFORE UPDATE ON turns
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM results WHERE run_item_id = OLD.run_item_id)
    THEN RAISE(ABORT, 'cannot modify turn referenced by results')
  END;
  SELECT CASE
    WHEN NEW.turn_no > (
      SELECT r.max_turns FROM runs r JOIN run_items i ON i.run_id = r.id WHERE i.id = NEW.run_item_id
    )
    THEN RAISE(ABORT, 'turn_no exceeds run max_turns')
  END;
  SELECT CASE
    WHEN NEW.passed_attempt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM attempts a
      WHERE a.id = NEW.passed_attempt_id
        AND a.turn_id = NEW.id
        AND a.status = 'completed'
        AND a.decision = 'pass'
    )
    THEN RAISE(ABORT, 'passed_attempt_id must reference a completed pass attempt of this turn')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_turns_immutable_delete
BEFORE DELETE ON turns
WHEN EXISTS (SELECT 1 FROM results WHERE run_item_id = OLD.run_item_id)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete turn referenced by results');
END;

-- Attempt invariants
CREATE TRIGGER IF NOT EXISTS trg_attempts_validate_insert
BEFORE INSERT ON attempts
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM turns t JOIN results r ON r.run_item_id = t.run_item_id WHERE t.id = NEW.turn_id
    )
    THEN RAISE(ABORT, 'cannot add attempt to turn already referenced by results')
  END;
  SELECT CASE
    WHEN NEW.attempt_no > (
      SELECT r.max_attempts
      FROM runs r
      JOIN run_items i ON i.run_id = r.id
      JOIN turns t ON t.run_item_id = i.id
      WHERE t.id = NEW.turn_id
    )
    THEN RAISE(ABORT, 'attempt_no exceeds run max_attempts')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_attempts_validate_update
BEFORE UPDATE ON attempts
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM turns t JOIN results r ON r.run_item_id = t.run_item_id WHERE t.passed_attempt_id = OLD.id
    )
    THEN RAISE(ABORT, 'cannot modify winning attempt referenced by results')
  END;
  SELECT CASE
    WHEN NEW.attempt_no > (
      SELECT r.max_attempts
      FROM runs r
      JOIN run_items i ON i.run_id = r.id
      JOIN turns t ON t.run_item_id = i.id
      WHERE t.id = NEW.turn_id
    )
    THEN RAISE(ABORT, 'attempt_no exceeds run max_attempts')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_attempts_immutable_delete
BEFORE DELETE ON attempts
WHEN EXISTS (
  SELECT 1 FROM turns t JOIN results r ON r.run_item_id = t.run_item_id WHERE t.passed_attempt_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete winning attempt referenced by results');
END;

-- Model call cross-table consistency
CREATE TRIGGER IF NOT EXISTS trg_model_calls_validate_insert
BEFORE INSERT ON model_calls
BEGIN
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND (
      SELECT i.run_id FROM turns t JOIN run_items i ON i.id = t.run_item_id WHERE t.id = NEW.turn_id
    ) != NEW.run_id
    THEN RAISE(ABORT, 'model_calls turn_id does not belong to run_id')
  END;
  SELECT CASE
    WHEN NEW.attempt_id IS NOT NULL AND (
      SELECT a.turn_id FROM attempts a WHERE a.id = NEW.attempt_id
    ) != NEW.turn_id
    THEN RAISE(ABORT, 'model_calls attempt_id does not belong to turn_id')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_calls_validate_update
BEFORE UPDATE ON model_calls
BEGIN
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND (
      SELECT i.run_id FROM turns t JOIN run_items i ON i.id = t.run_item_id WHERE t.id = NEW.turn_id
    ) != NEW.run_id
    THEN RAISE(ABORT, 'model_calls turn_id does not belong to run_id')
  END;
  SELECT CASE
    WHEN NEW.attempt_id IS NOT NULL AND (
      SELECT a.turn_id FROM attempts a WHERE a.id = NEW.attempt_id
    ) != NEW.turn_id
    THEN RAISE(ABORT, 'model_calls attempt_id does not belong to turn_id')
  END;
END;

-- Results invariants: every turn 1..turn_count must pass with a valid completed pass attempt
CREATE TRIGGER IF NOT EXISTS trg_results_validate_insert
BEFORE INSERT ON results
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM run_items i WHERE i.id = NEW.run_item_id AND i.status = 'pass')
    THEN RAISE(ABORT, 'result requires run_item with status = pass')
  END;
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM turns t WHERE t.run_item_id = NEW.run_item_id) != NEW.turn_count
      OR (SELECT MIN(t.turn_no) FROM turns t WHERE t.run_item_id = NEW.run_item_id) != 1
      OR (SELECT MAX(t.turn_no) FROM turns t WHERE t.run_item_id = NEW.run_item_id) != NEW.turn_count
    THEN RAISE(ABORT, 'result turn_count must match contiguous turns 1..turn_count')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM turns t
      LEFT JOIN attempts a ON a.id = t.passed_attempt_id
      WHERE t.run_item_id = NEW.run_item_id
        AND (
          t.status != 'pass'
          OR t.passed_attempt_id IS NULL
          OR a.id IS NULL
          OR a.turn_id != t.id
          OR a.status != 'completed'
          OR a.decision != 'pass'
        )
    )
    THEN RAISE(ABORT, 'every turn in a result must have status = pass and a completed pass attempt')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_results_validate_update
BEFORE UPDATE ON results
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM run_items i WHERE i.id = NEW.run_item_id AND i.status = 'pass')
    THEN RAISE(ABORT, 'result requires run_item with status = pass')
  END;
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM turns t WHERE t.run_item_id = NEW.run_item_id) != NEW.turn_count
      OR (SELECT MIN(t.turn_no) FROM turns t WHERE t.run_item_id = NEW.run_item_id) != 1
      OR (SELECT MAX(t.turn_no) FROM turns t WHERE t.run_item_id = NEW.run_item_id) != NEW.turn_count
    THEN RAISE(ABORT, 'result turn_count must match contiguous turns 1..turn_count')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM turns t
      LEFT JOIN attempts a ON a.id = t.passed_attempt_id
      WHERE t.run_item_id = NEW.run_item_id
        AND (
          t.status != 'pass'
          OR t.passed_attempt_id IS NULL
          OR a.id IS NULL
          OR a.turn_id != t.id
          OR a.status != 'completed'
          OR a.decision != 'pass'
        )
    )
    THEN RAISE(ABORT, 'every turn in a result must have status = pass and a completed pass attempt')
  END;
END;

-- Immutability of run_items, questions, and materials referenced by results
CREATE TRIGGER IF NOT EXISTS trg_run_items_immutable_update
BEFORE UPDATE ON run_items
WHEN EXISTS (SELECT 1 FROM results WHERE run_item_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'cannot modify run_item referenced by results');
END;

CREATE TRIGGER IF NOT EXISTS trg_run_items_immutable_delete
BEFORE DELETE ON run_items
WHEN EXISTS (SELECT 1 FROM results WHERE run_item_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete run_item referenced by results');
END;

CREATE TRIGGER IF NOT EXISTS trg_questions_immutable_update
BEFORE UPDATE ON questions
WHEN EXISTS (
  SELECT 1 FROM run_items i JOIN results r ON r.run_item_id = i.id WHERE i.question_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'cannot modify question referenced by results');
END;

CREATE TRIGGER IF NOT EXISTS trg_questions_immutable_delete
BEFORE DELETE ON questions
WHEN EXISTS (
  SELECT 1 FROM run_items i JOIN results r ON r.run_item_id = i.id WHERE i.question_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete question referenced by results');
END;

CREATE TRIGGER IF NOT EXISTS trg_materials_immutable_update
BEFORE UPDATE ON materials
WHEN EXISTS (
  SELECT 1
  FROM questions q
  JOIN run_items i ON i.question_id = q.id
  JOIN results r ON r.run_item_id = i.id
  WHERE q.material_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'cannot modify material referenced by results');
END;

CREATE TRIGGER IF NOT EXISTS trg_materials_immutable_delete
BEFORE DELETE ON materials
WHEN EXISTS (
  SELECT 1
  FROM questions q
  JOIN run_items i ON i.question_id = q.id
  JOIN results r ON r.run_item_id = i.id
  WHERE q.material_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'cannot delete material referenced by results');
END;

-- Persistent video-level split registry (train / test / dpo)
CREATE TABLE IF NOT EXISTS video_splits (
  video_key TEXT PRIMARY KEY CHECK(length(trim(video_key)) > 0),
  split TEXT NOT NULL CHECK(split IN ('train', 'test', 'dpo')),
  method TEXT NOT NULL CHECK(method IN ('backfill', 'hash', 'manual')),
  salt TEXT NOT NULL CHECK(length(trim(salt)) > 0),
  assigned_at TEXT NOT NULL CHECK(length(trim(assigned_at)) > 0)
);

CREATE TRIGGER IF NOT EXISTS trg_video_splits_immutable_update
BEFORE UPDATE ON video_splits
BEGIN
  SELECT RAISE(ABORT, 'cannot modify assigned video_split');
END;

CREATE TRIGGER IF NOT EXISTS trg_video_splits_immutable_delete
BEFORE DELETE ON video_splits
BEGIN
  SELECT RAISE(ABORT, 'cannot delete assigned video_split');
END;

-- Frozen test / dpo dataset versions
CREATE TABLE IF NOT EXISTS test_set_versions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK(length(trim(name)) > 0),
  split TEXT NOT NULL CHECK(split IN ('test', 'dpo')),
  result_ids_json TEXT NOT NULL CHECK(json_valid(result_ids_json) AND json_type(result_ids_json) = 'array'),
  sample_count INTEGER NOT NULL CHECK(sample_count >= 1),
  video_count INTEGER NOT NULL CHECK(video_count >= 1),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  created_at TEXT NOT NULL CHECK(length(trim(created_at)) > 0)
);

CREATE TRIGGER IF NOT EXISTS trg_test_set_versions_immutable_update
BEFORE UPDATE ON test_set_versions
BEGIN
  SELECT RAISE(ABORT, 'cannot modify frozen test_set_version');
END;

CREATE TRIGGER IF NOT EXISTS trg_test_set_versions_immutable_delete
BEFORE DELETE ON test_set_versions
BEGIN
  SELECT RAISE(ABORT, 'cannot delete frozen test_set_version');
END;

-- Evaluation rubric calls and extracted per-turn rubrics (P1)
CREATE TABLE IF NOT EXISTS eval_model_calls (
  id INTEGER PRIMARY KEY,
  result_id INTEGER REFERENCES results(id),
  turn_no INTEGER CHECK(turn_no IS NULL OR turn_no >= 1),
  role TEXT NOT NULL CHECK(role IN ('rubric')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'error', 'interrupted')),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json) = 'object'),
  output_text TEXT,
  error TEXT,
  started_at TEXT NOT NULL CHECK(length(trim(started_at)) > 0),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS eval_rubrics (
  id INTEGER PRIMARY KEY,
  result_id INTEGER NOT NULL REFERENCES results(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  rubric_json TEXT NOT NULL CHECK(json_valid(rubric_json) AND json_type(rubric_json) = 'object'),
  call_id INTEGER REFERENCES eval_model_calls(id),
  created_at TEXT NOT NULL CHECK(length(trim(created_at)) > 0),
  UNIQUE(result_id, turn_no)
);
`;

export class DataMakerStore {
  readonly db: DatabaseSync;
  private txDepth = 0;

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
    }
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

      if (this.hasTable("eval_model_calls")) {
        this.db.prepare(
          "UPDATE eval_model_calls SET status = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
        ).run(timestamp);
      }

      return { runs, runItems, turns, attempts, modelCalls };
    });
  }

  getVideoSplit(videoIdOrKey: string): VideoSplitRecord | undefined {
    if (!this.hasTable("video_splits")) return undefined;
    const videoKey = extractVideoKey(nonEmpty(videoIdOrKey, "video_key"));
    return this.db.prepare(
      "SELECT video_key, split, method, salt, assigned_at FROM video_splits WHERE video_key = ?",
    ).get(videoKey) as unknown as VideoSplitRecord | undefined;
  }

  listVideoSplits(split?: DatasetSplit): VideoSplitRecord[] {
    if (!this.hasTable("video_splits")) return [];
    if (split !== undefined) {
      validateSplit(split);
      return this.db.prepare(
        "SELECT video_key, split, method, salt, assigned_at FROM video_splits WHERE split = ? ORDER BY video_key",
      ).all(split) as unknown as VideoSplitRecord[];
    }
    return this.db.prepare(
      "SELECT video_key, split, method, salt, assigned_at FROM video_splits ORDER BY video_key",
    ).all() as unknown as VideoSplitRecord[];
  }

  assignVideoSplit(input: {
    videoKey: string;
    split: DatasetSplit;
    method: SplitAssignMethod;
    salt?: string;
    assignedAt?: string;
  }): VideoSplitRecord {
    const videoKey = extractVideoKey(nonEmpty(input.videoKey, "video_key"));
    const split = validateSplit(input.split);
    const method = input.method;
    if (method !== "backfill" && method !== "hash" && method !== "manual") {
      throw new Error("split method 必须为 backfill、hash 或 manual");
    }
    const salt = nonEmpty(input.salt ?? "weimingzi-split-v1", "salt");
    const assignedAt = input.assignedAt ?? nowIso();

    this.db.prepare(`
      INSERT OR IGNORE INTO video_splits (video_key, split, method, salt, assigned_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(videoKey, split, method, salt, assignedAt);

    const record = this.getVideoSplit(videoKey);
    if (!record) throw new Error(`无法读取 video_split：${videoKey}`);
    return record;
  }

  /**
   * Returns a map from material.id to its canonical videoKey and assigned split
   * (defaults to 'train' when a material's videoKey is not registered in video_splits).
   */
  getMaterialVideoAndSplitMap(): Map<number, { videoKey: string; videoId: string; split: DatasetSplit }> {
    const splitByVideoKey = new Map<string, DatasetSplit>();
    if (this.hasTable("video_splits")) {
      const splitRows = this.db.prepare("SELECT video_key, split FROM video_splits").all() as Array<{
        video_key: string;
        split: DatasetSplit;
      }>;
      for (const row of splitRows) {
        splitByVideoKey.set(row.video_key, row.split);
      }
    }
    const matRows = this.db.prepare("SELECT id, video_id FROM materials").all() as Array<{
      id: number;
      video_id: string;
    }>;
    const map = new Map<number, { videoKey: string; videoId: string; split: DatasetSplit }>();
    for (const row of matRows) {
      const videoKey = extractVideoKey(row.video_id);
      const split = splitByVideoKey.get(videoKey) ?? "train";
      map.set(Number(row.id), { videoKey, videoId: row.video_id, split });
    }
    return map;
  }

  upsertMaterial(input: { videoId: string; content: string; sourcePath?: string | null; createdAt?: string }): MaterialRecord {
    const videoId = nonEmpty(input.videoId, "video_id");
    const content = normalizeText(input.content);
    nonEmpty(content, "material content");
    const sha256 = sha256Hex(content);
    const createdAt = input.createdAt ?? nowIso();
    const sourcePath = input.sourcePath ?? null;

    this.db.prepare(`
      INSERT OR IGNORE INTO materials (video_id, content, sha256, source_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(videoId, content, sha256, sourcePath, createdAt);

    const row = this.db.prepare(`
      SELECT id, video_id, content, sha256, source_path, created_at
      FROM materials
      WHERE video_id = ? AND sha256 = ?
    `).get(videoId, sha256) as unknown as MaterialRecord | undefined;
    if (!row) throw new Error(`无法读取材料记录：${videoId}`);
    return row;
  }

  insertQuestion(input: {
    id?: number;
    materialId: number;
    question: string;
    generationRunId?: number | null;
    createdAt?: string;
  }): { record: QuestionRecord; inserted: boolean } {
    const question = nonEmpty(input.question, "question");
    const createdAt = input.createdAt ?? nowIso();
    const generationRunId = input.generationRunId ?? null;

    const existing = this.db.prepare(`
      SELECT id, material_id, question, generation_run_id, created_at
      FROM questions
      WHERE material_id = ? AND question = ?
    `).get(input.materialId, question) as unknown as QuestionRecord | undefined;

    if (existing) {
      if (input.id !== undefined && existing.id !== input.id) {
        throw new Error(`问题已存在但 ID 不一致：期望 ${input.id}，实际 ${existing.id}`);
      }
      return { record: existing, inserted: false };
    }

    let insertedId: number;
    if (input.id !== undefined) {
      if (!Number.isSafeInteger(input.id) || input.id < 1) throw new Error("问题 ID 必须是正整数");
      this.db.prepare(`
        INSERT INTO questions (id, material_id, question, generation_run_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.id, input.materialId, question, generationRunId, createdAt);
      insertedId = input.id;
    } else {
      const info = this.db.prepare(`
        INSERT INTO questions (material_id, question, generation_run_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(input.materialId, question, generationRunId, createdAt);
      insertedId = Number(info.lastInsertRowid);
    }

    const record = this.db.prepare(`
      SELECT id, material_id, question, generation_run_id, created_at
      FROM questions WHERE id = ?
    `).get(insertedId) as unknown as QuestionRecord;
    return { record, inserted: true };
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

  /**
   * Atomically commits a judge review and advances turn/run_item/results state.
   * When decision is 'pass' and isFinalTurn is true, run_item is marked pass and inserted into results in the same transaction.
   */
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

  /**
   * Finalizes a multi-turn run_item whose turns 1..turnCount have already passed
   * (for example, when a follow-up role decides to stop early after Turn 1).
   */
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

  queryResultTurns(runId: number): ResultTurnRow[] {
    return this.db.prepare(`
      SELECT r.id AS result_id,
             i.run_id,
             q.id AS question_id,
             q.material_id,
             r.turn_count,
             t.turn_no,
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

  exportRunSamples(runId: number, options: ExportOptions = {}): TrainingSampleLine[] {
    const rows = this.queryResultTurns(runId);
    const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;
    const grouped = new Map<number, ResultTurnRow[]>();
    for (const row of rows) {
      const list = grouped.get(row.result_id);
      if (list) list.push(row);
      else grouped.set(row.result_id, [row]);
    }
    const samples: TrainingSampleLine[] = [];
    for (const turns of grouped.values()) {
      const messages: TrainingMessage[] = [];
      if (systemPrompt !== undefined) {
        messages.push({ role: "system", content: systemPrompt });
      }
      for (const turn of turns) {
        messages.push({ role: "user", content: turn.user_content });
        messages.push({ role: "assistant", content: turn.assistant_content });
      }
      samples.push({ messages });
    }
    return samples;
  }

  exportRunJsonl(runId: number, options: ExportOptions = {}): string {
    return formatSamplesJsonl(this.exportRunSamples(runId, options));
  }

  /**
   * Explicitly merges passed results across selected runs (either `--runs`, `--all-formal`, or `--version`),
   * applying an explicit per-question dedup policy (`latest` / `earliest` / `error`),
   * persistent split filtering (`train` / `test` / `dpo`, strictly excluding test/dpo from training exports),
   * optional turn-count filtering, optional deterministic shuffle, and optional video-level train/val split.
   */
  exportMergedDataset(options: MergedExportOptions): MergedExportResult {
    const hasVersion = options.versionName !== undefined;
    const hasRunIds = options.runIds !== undefined && options.runIds.length > 0;
    const allFormal = Boolean(options.allFormal);
    if (!hasVersion) {
      if (hasRunIds && allFormal) {
        throw new Error("runIds 与 allFormal 不能同时指定");
      }
      if (!hasRunIds && !allFormal) {
        throw new Error("必须指定 runIds、allFormal 或 versionName");
      }
    }
    const targetSplit = options.split !== undefined ? validateSplit(options.split) : undefined;
    const dedup: DedupPolicy = options.dedup ?? "latest";
    if (dedup !== "latest" && dedup !== "earliest" && dedup !== "error") {
      throw new Error("dedup 必须为 latest、earliest 或 error");
    }
    if (options.minTurns !== undefined) validateMaxTurns(options.minTurns);
    if (options.maxTurns !== undefined) validateMaxTurns(options.maxTurns);
    if (options.minTurns !== undefined && options.maxTurns !== undefined && options.minTurns > options.maxTurns) {
      throw new Error("minTurns 不能大于 maxTurns");
    }
    if (options.valRatio !== undefined && (!Number.isFinite(options.valRatio) || options.valRatio <= 0 || options.valRatio >= 1)) {
      throw new Error("valRatio 必须是 (0, 1) 之间的小数");
    }

    const systemPrompt = options.systemPrompt !== undefined ? nonEmpty(options.systemPrompt, "systemPrompt") : undefined;
    const excludeSet = new Set(options.excludeRunIds ?? []);
    const materialInfo = this.getMaterialVideoAndSplitMap();

    let rows: ResultTurnRow[];
    if (hasVersion) {
      const version = this.getTestSetVersion(nonEmpty(options.versionName, "versionName"));
      if (!version) throw new Error(`未找到测试集版本：${options.versionName}`);
      if (targetSplit !== undefined && version.split !== targetSplit) {
        throw new Error(`版本 ${version.name} 属于 ${version.split} 分区，与请求的 --split ${targetSplit} 不一致`);
      }
      const resultIds = JSON.parse(version.result_ids_json) as number[];
      if (resultIds.length === 0) {
        return {
          train: [], val: [], includedRunIds: [], countsByRunId: {}, turnCountDistribution: {},
          duplicateQuestionsResolved: 0, materialCount: 0, trainMaterialCount: 0, valMaterialCount: 0,
        };
      }
      const placeholders = resultIds.map(() => "?").join(", ");
      rows = this.db.prepare(`
        SELECT r.id AS result_id,
               i.run_id,
               q.id AS question_id,
               q.material_id,
               r.turn_count,
               t.turn_no,
               COALESCE(t.user_content, q.question) AS user_content,
               a.answer AS assistant_content,
               a.attempt_no
        FROM results r
        JOIN run_items i ON i.id = r.run_item_id
        JOIN questions q ON q.id = i.question_id
        JOIN turns t ON t.run_item_id = i.id
        JOIN attempts a ON a.id = t.passed_attempt_id
        WHERE r.id IN (${placeholders})
        ORDER BY i.run_id, q.id, t.turn_no
      `).all(...resultIds) as unknown as ResultTurnRow[];
    } else {
      let candidateRunIds: number[];
      if (allFormal) {
        const effectiveSplit = targetSplit ?? "train";
        const runRows = effectiveSplit === "train"
          ? (this.db.prepare(`
              SELECT id FROM runs
              WHERE kind = 'answer_judge'
                AND json_extract(export_policy_json, '$.training_enabled') = 1
                AND COALESCE(json_extract(export_policy_json, '$.split'), 'train') = 'train'
              ORDER BY id
            `).all() as Array<{ id: number }>)
          : (this.db.prepare(`
              SELECT id FROM runs
              WHERE kind = 'answer_judge'
                AND (
                  json_extract(export_policy_json, '$.eval_enabled') = 1
                  OR json_extract(export_policy_json, '$.training_enabled') = 1
                  OR json_extract(export_policy_json, '$.split') = ?
                )
              ORDER BY id
            `).all(effectiveSplit) as Array<{ id: number }>);
        candidateRunIds = runRows.map((r) => Number(r.id)).filter((id) => !excludeSet.has(id));
      } else {
        const requested = [...new Set(options.runIds!)];
        for (const id of requested) {
          if (!Number.isSafeInteger(id) || id < 1) throw new Error(`无效的 run_id：${id}`);
          const exists = this.db.prepare("SELECT id, kind FROM runs WHERE id = ?").get(id) as { id: number; kind: string } | undefined;
          if (!exists) throw new Error(`未找到 run_id=${id}`);
          if (exists.kind !== "answer_judge") throw new Error(`run_id=${id} 不是 answer_judge 运行（kind=${exists.kind}）`);
        }
        candidateRunIds = requested.filter((id) => !excludeSet.has(id));
      }

      if (candidateRunIds.length === 0) {
        return {
          train: [],
          val: [],
          includedRunIds: [],
          countsByRunId: {},
          turnCountDistribution: {},
          duplicateQuestionsResolved: 0,
          materialCount: 0,
          trainMaterialCount: 0,
          valMaterialCount: 0,
        };
      }

      const placeholders = candidateRunIds.map(() => "?").join(", ");
      const params: number[] = [...candidateRunIds];
      let sql = `
        SELECT r.id AS result_id,
               i.run_id,
               q.id AS question_id,
               q.material_id,
               r.turn_count,
               t.turn_no,
               COALESCE(t.user_content, q.question) AS user_content,
               a.answer AS assistant_content,
               a.attempt_no
        FROM results r
        JOIN run_items i ON i.id = r.run_item_id
        JOIN questions q ON q.id = i.question_id
        JOIN turns t ON t.run_item_id = i.id
        JOIN attempts a ON a.id = t.passed_attempt_id
        WHERE i.run_id IN (${placeholders})
      `;
      if (options.minTurns !== undefined) {
        sql += " AND r.turn_count >= ?";
        params.push(options.minTurns);
      }
      if (options.maxTurns !== undefined) {
        sql += " AND r.turn_count <= ?";
        params.push(options.maxTurns);
      }
      sql += " ORDER BY i.run_id, q.id, t.turn_no";

      rows = this.db.prepare(sql).all(...params) as unknown as ResultTurnRow[];
    }

    const effectiveSplitFilter: DatasetSplit | undefined = hasVersion
      ? undefined
      : (targetSplit ?? (allFormal ? "train" : undefined));

    const groupedByResult = new Map<number, ResultTurnRow[]>();
    for (const row of rows) {
      if (effectiveSplitFilter !== undefined) {
        const matSplit = materialInfo.get(Number(row.material_id))?.split ?? "train";
        if (matSplit !== effectiveSplitFilter) continue;
      }
      if (hasVersion) {
        if (options.minTurns !== undefined && Number(row.turn_count) < options.minTurns) continue;
        if (options.maxTurns !== undefined && Number(row.turn_count) > options.maxTurns) continue;
      }
      const list = groupedByResult.get(row.result_id);
      if (list) list.push(row);
      else groupedByResult.set(row.result_id, [row]);
    }

    const byQuestion = new Map<number, MergedExportRecord[]>();
    for (const turns of groupedByResult.values()) {
      const first = turns[0];
      const messages: TrainingMessage[] = [];
      if (systemPrompt !== undefined) {
        messages.push({ role: "system", content: systemPrompt });
      }
      for (const turn of turns) {
        messages.push({ role: "user", content: turn.user_content });
        messages.push({ role: "assistant", content: turn.assistant_content });
      }
      const record: MergedExportRecord = {
        resultId: Number(first.result_id),
        runId: Number(first.run_id),
        questionId: Number(first.question_id),
        materialId: Number(first.material_id),
        turnCount: Number(first.turn_count),
        sample: { messages },
      };
      const list = byQuestion.get(record.questionId);
      if (list) list.push(record);
      else byQuestion.set(record.questionId, [record]);
    }

    const selected: MergedExportRecord[] = [];
    let duplicateQuestionsResolved = 0;
    const conflicts: string[] = [];

    for (const [questionId, list] of [...byQuestion.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a.runId - b.runId);
      if (list.length > 1) {
        if (dedup === "error") {
          conflicts.push(`q${questionId} (runs: ${list.map((r) => r.runId).join(",")})`);
          continue;
        }
        duplicateQuestionsResolved += list.length - 1;
        selected.push(dedup === "latest" ? list[list.length - 1] : list[0]);
      } else {
        selected.push(list[0]);
      }
    }

    if (conflicts.length > 0) {
      throw new Error(`发现同题多版本冲突（--dedup error）：${conflicts.join("; ")}`);
    }

    const rng = options.seed !== undefined ? createSeededRng(options.seed) : Math.random;
    const allMaterials = [...new Set(selected.map((r) => r.materialId))].sort((a, b) => a - b);
    const videoKeyOfMaterial = (matId: number): string => materialInfo.get(matId)?.videoKey ?? String(matId);
    const allVideoKeys = [...new Set(allMaterials.map(videoKeyOfMaterial))].sort();

    let train: MergedExportRecord[];
    let val: MergedExportRecord[];

    if (options.valRatio !== undefined) {
      if (allVideoKeys.length < 2) {
        throw new Error("按视频切分验证集至少需要 2 个不同视频（material）");
      }
      const shuffledVideoKeys = shuffleInPlace([...allVideoKeys], rng);
      const valVideoCount = Math.min(allVideoKeys.length - 1, Math.max(1, Math.round(allVideoKeys.length * options.valRatio)));
      const valVideoKeySet = new Set(shuffledVideoKeys.slice(0, valVideoCount));
      train = selected.filter((r) => !valVideoKeySet.has(videoKeyOfMaterial(r.materialId)));
      val = selected.filter((r) => valVideoKeySet.has(videoKeyOfMaterial(r.materialId)));
    } else {
      train = [...selected];
      val = [];
    }

    if (options.shuffle) {
      shuffleInPlace(train, rng);
      if (val.length > 0) shuffleInPlace(val, rng);
    }

    const countsByRunId: Record<number, number> = {};
    const turnCountDistribution: Record<number, number> = {};
    for (const rec of selected) {
      countsByRunId[rec.runId] = (countsByRunId[rec.runId] ?? 0) + 1;
      turnCountDistribution[rec.turnCount] = (turnCountDistribution[rec.turnCount] ?? 0) + 1;
    }

    return {
      train,
      val,
      includedRunIds: Object.keys(countsByRunId).map(Number).sort((a, b) => a - b),
      countsByRunId,
      turnCountDistribution,
      duplicateQuestionsResolved,
      materialCount: allMaterials.length,
      trainMaterialCount: new Set(train.map((r) => r.materialId)).size,
      valMaterialCount: new Set(val.map((r) => r.materialId)).size,
    };
  }

  getTestSetVersion(nameOrId: string | number): TestSetVersionRecord | undefined {
    if (!this.hasTable("test_set_versions")) return undefined;
    if (typeof nameOrId === "number") {
      return this.db.prepare(
        "SELECT id, name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at FROM test_set_versions WHERE id = ?",
      ).get(nameOrId) as unknown as TestSetVersionRecord | undefined;
    }
    return this.db.prepare(
      "SELECT id, name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at FROM test_set_versions WHERE name = ?",
    ).get(nonEmpty(nameOrId, "version name")) as unknown as TestSetVersionRecord | undefined;
  }

  listTestSetVersions(split?: "test" | "dpo"): TestSetVersionRecord[] {
    if (!this.hasTable("test_set_versions")) return [];
    if (split !== undefined) {
      return this.db.prepare(
        "SELECT id, name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at FROM test_set_versions WHERE split = ? ORDER BY id",
      ).all(split) as unknown as TestSetVersionRecord[];
    }
    return this.db.prepare(
      "SELECT id, name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at FROM test_set_versions ORDER BY id",
    ).all() as unknown as TestSetVersionRecord[];
  }

  /**
   * Freezes an immutable test/dpo dataset version (e.g. `test-v1`) from current passed results in that split.
   * Idempotent when called again with the same name and identical content sha256; rejects conflicting overwrites.
   */
  freezeTestSetVersion(input: {
    name: string;
    split?: "test" | "dpo";
    runIds?: number[];
    dedup?: DedupPolicy;
    minTurns?: number;
    maxTurns?: number;
    systemPrompt?: string;
    createdAt?: string;
  }): TestSetVersionRecord {
    const name = nonEmpty(input.name, "version name");
    const split = input.split ?? "test";
    if (split !== "test" && split !== "dpo") {
      throw new Error("冻结评测集版本的 split 必须为 test 或 dpo（禁止将 train 冻结为测试集）");
    }

    const merged = this.exportMergedDataset({
      allFormal: input.runIds === undefined,
      runIds: input.runIds,
      split,
      dedup: input.dedup ?? "latest",
      minTurns: input.minTurns,
      maxTurns: input.maxTurns,
      systemPrompt: input.systemPrompt,
    });

    if (merged.train.length === 0) {
      throw new Error(`未找到属于 ${split} 分区的已通过样本，无法冻结版本 ${name}`);
    }

    const materialInfo = this.getMaterialVideoAndSplitMap();
    const videoKeys = [...new Set(merged.train.map((r) => materialInfo.get(r.materialId)?.videoKey ?? String(r.materialId)))].sort();
    for (const r of merged.train) {
      const matSplit = materialInfo.get(r.materialId)?.split;
      if (matSplit !== split) {
        throw new Error(`样本 result_id=${r.resultId} 的视频不属于 ${split} 分区（实际为 ${matSplit ?? "unassigned"}）`);
      }
    }

    const resultIds = merged.train.map((r) => r.resultId);
    const jsonl = formatSamplesJsonl(merged.train.map((r) => r.sample));
    const sha256 = sha256Hex(jsonl);
    const createdAt = input.createdAt ?? nowIso();

    const existing = this.getTestSetVersion(name);
    if (existing) {
      if (existing.sha256 === sha256 && existing.split === split) {
        return existing;
      }
      throw new Error(`测试集版本 ${name} 已冻结（sha256=${existing.sha256.slice(0, 12)}），禁止覆盖为不同内容`);
    }

    const manifest = {
      name,
      split,
      sampleCount: merged.train.length,
      videoCount: videoKeys.length,
      materialCount: merged.materialCount,
      videoKeys,
      resultIds,
      questionIds: merged.train.map((r) => r.questionId),
      includedRunIds: merged.includedRunIds,
      turnCountDistribution: merged.turnCountDistribution,
      sha256,
    };

    this.db.prepare(`
      INSERT INTO test_set_versions (name, split, result_ids_json, sample_count, video_count, manifest_json, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      split,
      JSON.stringify(resultIds),
      merged.train.length,
      videoKeys.length,
      JSON.stringify(manifest),
      sha256,
      createdAt,
    );

    const created = this.getTestSetVersion(name);
    if (!created) throw new Error(`无法读取冻结版本：${name}`);
    return created;
  }

  upsertEvalRubric(input: {
    resultId: number;
    turnNo: number;
    rubric: EvalRubric;
    callId?: number | null;
    createdAt?: string;
  }): EvalRubricRecord {
    const createdAt = input.createdAt ?? nowIso();
    const rubricJson = assertObjectJson(input.rubric, "rubric");
    this.db.prepare(`
      INSERT INTO eval_rubrics (result_id, turn_no, rubric_json, call_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(result_id, turn_no) DO UPDATE SET
        rubric_json = excluded.rubric_json,
        call_id = excluded.call_id,
        created_at = excluded.created_at
    `).run(input.resultId, input.turnNo, rubricJson, input.callId ?? null, createdAt);
    const record = this.getEvalRubric(input.resultId, input.turnNo);
    if (!record) throw new Error(`无法读取 eval_rubric (result_id=${input.resultId}, turn_no=${input.turnNo})`);
    return record;
  }

  getEvalRubric(resultId: number, turnNo: number): EvalRubricRecord | undefined {
    if (!this.hasTable("eval_rubrics")) return undefined;
    const row = this.db.prepare(
      "SELECT id, result_id, turn_no, rubric_json, call_id, created_at FROM eval_rubrics WHERE result_id = ? AND turn_no = ?",
    ).get(resultId, turnNo) as {
      id: number;
      result_id: number;
      turn_no: number;
      rubric_json: string;
      call_id: number | null;
      created_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      result_id: Number(row.result_id),
      turn_no: Number(row.turn_no),
      rubric: JSON.parse(row.rubric_json) as EvalRubric,
      rubric_json: row.rubric_json,
      call_id: row.call_id !== null ? Number(row.call_id) : null,
      created_at: row.created_at,
    };
  }

  startEvalModelCall(input: {
    resultId?: number | null;
    turnNo?: number | null;
    role: "rubric";
    input: Record<string, unknown>;
    startedAt?: string;
  }): number {
    const info = this.db.prepare(`
      INSERT INTO eval_model_calls (result_id, turn_no, role, status, input_json, started_at)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(
      input.resultId ?? null,
      input.turnNo ?? null,
      input.role,
      assertObjectJson(input.input, "eval input_json"),
      input.startedAt ?? nowIso(),
    );
    return Number(info.lastInsertRowid);
  }

  finishEvalModelCall(callId: number, outputText: string, finishedAt = nowIso()): void {
    this.db.prepare(`
      UPDATE eval_model_calls SET status = 'completed', output_text = ?, finished_at = ? WHERE id = ?
    `).run(outputText, finishedAt, callId);
  }

  failEvalModelCall(callId: number, error: string, options: { outputText?: string | null; finishedAt?: string } = {}): void {
    this.db.prepare(`
      UPDATE eval_model_calls
      SET status = 'error', error = ?, output_text = COALESCE(?, output_text), finished_at = ?
      WHERE id = ?
    `).run(error, options.outputText ?? null, options.finishedAt ?? nowIso(), callId);
  }
}
