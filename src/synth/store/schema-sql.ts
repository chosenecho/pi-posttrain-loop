import type {
  DatasetSplit,
  DedupPolicy,
  SplitAssignMethod,
  TrainingMessage,
  TrainingSampleLine,
} from "../../shared/types.js";

export type { DedupPolicy, TrainingMessage, TrainingSampleLine };

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
  attempt_id: number;
  user_content: string;
  assistant_content: string;
  attempt_no: number;
}

export interface ExportOptions {
  systemPrompt?: string;
  generalizeTools?: boolean;
  negativeToolsRatio?: number;
  seed?: number;
}

export interface MergedExportOptions extends ExportOptions {
  runIds?: number[];
  allFormal?: boolean;
  split?: DatasetSplit;
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
  maxAttempts: number;
  maxTurns?: number;
  config: Record<string, unknown>;
  prompts: Record<string, unknown>;
  skills: unknown[];
  exportPolicy: Record<string, unknown>;
  status?: RunStatus;
  startedAt?: string;
  finishedAt?: string | null;
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

export interface TargetQuestionRow {
  id: number;
  materialId: number;
  videoId: string;
  materialContent: string;
  question: string;
}

export function formatSamplesJsonl(samples: TrainingSampleLine[]): string {
  if (samples.length === 0) return "";
  return samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n";
}

export function assertObjectJson(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return JSON.stringify(value);
}

export function assertArrayJson(value: unknown, label: string): string {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 数组`);
  }
  return JSON.stringify(value);
}

export const SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS attempt_tool_steps (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  step_no INTEGER NOT NULL CHECK(step_no >= 1),
  tool_name TEXT NOT NULL CHECK(length(trim(tool_name)) > 0),
  arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
  tool_output TEXT NOT NULL,
  pre_call_thought TEXT,
  created_at TEXT NOT NULL CHECK(length(trim(created_at)) > 0),
  UNIQUE(attempt_id, step_no)
);

CREATE INDEX IF NOT EXISTS idx_attempt_tool_steps_attempt_id ON attempt_tool_steps(attempt_id);

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
`;

/**
 * Legacy test-v1 blind-test tables (frozen test versions + rubric extraction) were removed;
 * evaluation sets are produced exclusively by the isolated eval pipeline (eval.sqlite).
 * Dropping them is idempotent and runs on every writable main-store open. Their triggers
 * and indexes are dropped together with the tables.
 */
export const LEGACY_DROP_SQL = `
DROP TRIGGER IF EXISTS trg_test_set_versions_immutable_update;
DROP TRIGGER IF EXISTS trg_test_set_versions_immutable_delete;
DROP TABLE IF EXISTS eval_rubrics;
DROP TABLE IF EXISTS eval_model_calls;
DROP TABLE IF EXISTS test_set_versions;
`;
