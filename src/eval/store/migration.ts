import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { TaskSession, ensureRunOwnerColumn } from "../../shared/task-store.js";
import { ensureProbeBuildSchema } from "./build-plan-schema.js";
import { migrateLegacyProbeBuildPlans, type LegacyBuildMigrationReport } from "./legacy-build-plans.js";
import { ensureEvalSchema } from "./schema-sql.js";
import { EVAL_SCHEMA_VERSION } from "./types.js";

const LEGACY_TABLES = [
  "source_materials", "probe_runs", "probes", "probe_turns", "probe_calibrations",
  "suite_versions", "suite_items", "eval_runs", "eval_predictions", "eval_scores", "agent_calls",
] as const;
const BUILD_TABLES = ["probe_build_plans", "probe_build_slots", "probe_build_executions"] as const;

export interface EvalMigrationSnapshot {
  counts: Record<string, number>;
  legacyDataSha256: string;
  suites: Array<{ id: number; sha256: string; manifestJson: string; itemsSha256: string }>;
}

export interface EvalMigrationReport {
  databasePath: string;
  dryRun: boolean;
  backupPath: string | null;
  fromVersion: string;
  toVersion: string;
  migrated: boolean;
  before: EvalMigrationSnapshot;
  after: EvalMigrationSnapshot;
  integrityCheck: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  legacy: LegacyBuildMigrationReport;
}

export interface EvalMigrationOptions {
  dryRun?: boolean;
  /** Destination for the required pre-migration snapshot; an existing file is never overwritten. */
  backupPath?: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snapshot(db: DatabaseSync): EvalMigrationSnapshot {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  const counts: Record<string, number> = {};
  const legacyRows = LEGACY_TABLES.map(table => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => {
      // Run ownership is the only additive metadata on historical business rows.
      const { owner_token: _owner, ...fields } = row;
      return fields;
    });
    counts[table] = rows.length;
    return [table, rows];
  });
  for (const table of BUILD_TABLES) {
    counts[table] = tables.has(table) ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) : 0;
  }
  const suites = db.prepare("SELECT id,sha256,manifest_json FROM suite_versions ORDER BY id").all().map(row => ({
    id: Number(row.id),
    sha256: String(row.sha256),
    manifestJson: String(row.manifest_json),
    itemsSha256: digest(db.prepare("SELECT * FROM suite_items WHERE suite_id=? ORDER BY id").all(row.id!)),
  }));
  return { counts, legacyDataSha256: digest(legacyRows), suites };
}

function verifyPreserved(before: EvalMigrationSnapshot, after: EvalMigrationSnapshot): void {
  if (before.legacyDataSha256 !== after.legacyDataSha256
    || JSON.stringify(before.suites) !== JSON.stringify(after.suites)
    || LEGACY_TABLES.some(table => before.counts[table] !== after.counts[table])) {
    throw new Error("迁移校验失败：历史业务记录或冻结套卷发生变化 [eval_migration_data_changed]");
  }
}

function integrity(db: DatabaseSync): Pick<EvalMigrationReport, "integrityCheck" | "foreignKeyViolations"> {
  const integrityCheck = db.prepare("PRAGMA integrity_check").all().map(row => String(row.integrity_check));
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (integrityCheck.length !== 1 || integrityCheck[0] !== "ok" || foreignKeyViolations.length) {
    throw new Error(`迁移完整性校验失败 [eval_migration_integrity]: ${JSON.stringify({ integrityCheck, foreignKeyViolations })}`);
  }
  return { integrityCheck, foreignKeyViolations };
}

function existingLegacyReport(db: DatabaseSync): LegacyBuildMigrationReport {
  return {
    createdPlans: 0,
    incompletePlanIds: db.prepare("SELECT id FROM probe_build_plans WHERE plan_complete=0 ORDER BY id").all().map(row => Number(row.id)),
    conflictPlanIds: db.prepare("SELECT id FROM probe_build_plans WHERE error_code='checkpoint_invalid' ORDER BY id").all().map(row => Number(row.id)),
  };
}

function migrateV3ToV4(db: DatabaseSync, before: EvalMigrationSnapshot): Pick<EvalMigrationReport, "after" | "legacy" | "integrityCheck" | "foreignKeyViolations"> {
  ensureProbeBuildSchema(db);
  ensureRunOwnerColumn(db, "probe_runs");
  ensureRunOwnerColumn(db, "eval_runs");
  const legacy = migrateLegacyProbeBuildPlans(db);
  db.prepare("UPDATE eval_meta SET value=? WHERE key='schema_version'").run(EVAL_SCHEMA_VERSION);
  const after = snapshot(db);
  verifyPreserved(before, after);
  return { after, legacy, ...integrity(db) };
}

async function createSnapshot(db: DatabaseSync, path: string, ownerToken: string, before: EvalMigrationSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Reserve the exact destination before SQLite opens it with its normal overwrite semantics.
  const reserved = await open(path, "wx", 0o600);
  await reserved.close();
  await backup(db, path);
  const copied = new DatabaseSync(path);
  try {
    copied.exec("PRAGMA foreign_keys=ON");
    // The source session belongs to another physical database; the snapshot starts unclaimed.
    copied.prepare("DELETE FROM runtime_task_lock WHERE owner_token=?").run(ownerToken);
    verifyPreserved(before, snapshot(copied));
    integrity(copied);
  } finally { copied.close(); }
}

/**
 * Explicit, additive v3→v4 migration. The writer session spans backup and the single migration
 * transaction; no legacy probe, turn, calibration, suite, prediction or score is rewritten.
 */
export async function migrateEvalDatabase(path: string, options: EvalMigrationOptions = {}): Promise<EvalMigrationReport> {
  const databasePath = resolve(path);
  if (!(await stat(databasePath)).isFile()) throw new Error("评测迁移路径必须是现有 SQLite 文件");
  const db = new DatabaseSync(databasePath);
  let session: TaskSession | undefined;
  let backupPath: string | null = null;
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    session = new TaskSession(db, "eval:migrate");
    ensureEvalSchema(db, true);
    const fromVersion = String(db.prepare("SELECT value FROM eval_meta WHERE key='schema_version'").get()!.value);
    const before = snapshot(db);
    const common = { databasePath, dryRun: Boolean(options.dryRun), fromVersion, toVersion: EVAL_SCHEMA_VERSION, before };
    if (fromVersion === EVAL_SCHEMA_VERSION) {
      return { ...common, backupPath: null, migrated: false, after: before, legacy: existingLegacyReport(db), ...integrity(db) };
    }
    if (options.dryRun) {
      const temporaryDirectory = await mkdtemp(join(dirname(databasePath), ".eval-migration-"));
      try {
        const temporaryPath = join(temporaryDirectory, "snapshot.sqlite");
        await createSnapshot(db, temporaryPath, session.ownerToken, before);
        const copied = new DatabaseSync(temporaryPath);
        let copiedSession: TaskSession | undefined;
        try {
          copied.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
          copiedSession = new TaskSession(copied, "eval:migrate:dry-run");
          const result = copiedSession.mutate(() => migrateV3ToV4(copied, before));
          return { ...common, backupPath: null, migrated: true, ...result };
        } finally {
          try { copiedSession?.release(); } finally { copied.close(); }
        }
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
    backupPath = resolve(options.backupPath ?? `${databasePath}.v3-backup-${randomUUID()}.sqlite`);
    await createSnapshot(db, backupPath, session.ownerToken, before);
    try {
      const result = session.mutate(() => migrateV3ToV4(db, before));
      return { ...common, backupPath, migrated: true, ...result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`迁移失败，事务已回滚；迁移前备份保留于 ${backupPath}：${reason}`, { cause: error });
    }
  } finally {
    try { session?.release(); } finally { db.close(); }
  }
}
