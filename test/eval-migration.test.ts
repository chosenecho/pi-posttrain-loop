import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildEvalReport } from "../src/eval/report.js";
import { EvalStore } from "../src/eval/store/index.js";
import { migrateEvalDatabase } from "../src/eval/store/migration.js";
import test from "node:test";
import { EVAL_SCHEMA_V3_SQL, ensureEvalSchemaV3 } from "../src/eval/store/schema-sql.js";
import { TaskSession } from "../src/shared/task-store.js";

const LEGACY_TABLES = ["source_materials", "probe_runs", "probes", "probe_turns", "probe_calibrations", "suite_versions", "suite_items", "eval_runs", "eval_predictions", "eval_scores", "agent_calls"];

function legacyData(db: DatabaseSync): unknown {
  return Object.fromEntries(LEGACY_TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => {
    const { owner_token: _owner, ...fields } = row;
    return fields;
  })]));
}

function createV3(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(EVAL_SCHEMA_V3_SQL);
  db.exec(`
    INSERT INTO eval_meta VALUES ('schema_version', '3');
    INSERT INTO source_materials (video_id,video_key,content,content_sha256,split_snapshot,imported_at)
      VALUES ('BV_LEGACY','BV_LEGACY','original source','source-sha','test','2026-01-01');
    INSERT INTO probe_runs (kind,status,config_json,prompts_json,skills_json,started_at,ended_at)
      VALUES ('probe_build','completed','{}','{}','[]','2026-01-01','2026-01-02');
    INSERT INTO probes (run_id,source_material_id,slot_index,probe_type,persona,question,anchor,trap,anchor_verified,status,reviews_json,difficulty,created_at,updated_at)
      VALUES (1,1,1,'answer','reader','original question','source anchor','trap',1,'accepted','[]','hard','2026-01-01','2026-01-02');
    INSERT INTO probes (run_id,source_material_id,slot_index,probe_type,persona,question,anchor,trap,status,created_at,updated_at)
      VALUES (1,1,2,'answer','reader','unfinished question','anchor','trap','draft','2026-01-01','2026-01-02');
    INSERT INTO probe_turns (probe_id,turn_no,expected_behavior,user_content,reference_answer,rubric_json,attempts,created_at)
      VALUES (1,1,'answer','original question','preserved reference','{"stance":"original rubric"}',2,'2026-01-02');
    INSERT INTO probe_calibrations (probe_id,turn_no,bare_model,grader_model,bare_answer,behavior_ok,score,detail_json,created_at)
      VALUES (1,1,'old-bare','old-grader','old answer',1,80,'{"original":true}','2026-01-02');
    INSERT INTO suite_versions (name,item_count,sha256,manifest_json,frozen_at)
      VALUES ('frozen-v3',1,'frozen-sha-v3','{"probeIds":[1],"original":true}','2026-01-03');
    INSERT INTO suite_items (suite_id,item_key,video_key,probe_type,difficulty,messages_json,rubrics_json)
      VALUES (1,'probe:1','BV_LEGACY','answer','hard','[{"role":"user","content":"original question"},{"role":"assistant","content":"preserved reference"}]','[]');
    INSERT INTO eval_runs (suite_id,candidate,model,history_mode,config_json,status,started_at,ended_at)
      VALUES (1,'old-candidate','old-model','self','{}','completed','2026-01-04','2026-01-05');
    INSERT INTO eval_predictions (eval_run_id,suite_item_id,turn_no,input_json,output_text,created_at)
      VALUES (1,1,1,'[]','preserved prediction','2026-01-04');
    INSERT INTO eval_scores (prediction_id,grader_model,behavior_ok,stance,key_point_coverage,style,score,detail_json,created_at)
      VALUES (1,'old-grader',1,2,1,2,90,'{"original":true}','2026-01-05');
    INSERT INTO agent_calls (run_ref,role,model,input_refs_json,output_text,started_at,ended_at)
      VALUES ('probe_build:1','reference','old-model','{"probe_id":1,"turn_no":1,"attempt":2}','preserved reference','2026-01-01','2026-01-02');
  `);
  return db;
}

test("v3 migration preserves all business data and frozen suites while recording legacy incomplete plans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migration-"));
  try {
    const path = join(dir, "eval.sqlite");
    const backupPath = join(dir, "backup.sqlite");
    const fixture = createV3(path);
    const original = legacyData(fixture);
    fixture.close();
    const report = await migrateEvalDatabase(path, { backupPath });
    assert.equal(report.fromVersion, "3");
    assert.equal(report.toVersion, "4");
    assert.equal(report.migrated, true);
    assert.equal(report.backupPath, backupPath);
    assert.deepEqual(report.integrityCheck, ["ok"]);
    assert.deepEqual(report.foreignKeyViolations, []);
    assert.equal(report.before.counts.probes, 2);
    assert.equal(report.after.counts.probes, 2);
    assert.equal(report.after.counts.probe_build_slots, 2);
    assert.equal(report.legacy.createdPlans, 1);
    assert.deepEqual(report.legacy.incompletePlanIds, [1]);
    assert.deepEqual(report.before.suites, report.after.suites);
    assert.equal(report.after.suites[0]?.sha256, "frozen-sha-v3");
    const migrated = new DatabaseSync(path, { readOnly: true });
    const backedUp = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.deepEqual(legacyData(migrated), original);
      assert.deepEqual(legacyData(backedUp), original);
      assert.equal(backedUp.prepare("SELECT value FROM eval_meta WHERE key='schema_version'").get()?.value, "3");
      assert.equal(migrated.prepare("SELECT value FROM eval_meta WHERE key='schema_version'").get()?.value, "4");
      assert.equal(migrated.prepare("SELECT status FROM probe_build_slots WHERE probe_id=1").get()?.status, "accepted");
    } finally { migrated.close(); backedUp.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dry-run migrates a temporary snapshot and cleans it while leaving the source at v3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-dry-run-"));
  try {
    const path = join(dir, "eval.sqlite");
    const fixture = createV3(path);
    const original = legacyData(fixture);
    fixture.close();
    const report = await migrateEvalDatabase(path, { dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.backupPath, null);
    assert.equal(report.fromVersion, "3");
    assert.equal(report.toVersion, "4");
    assert.equal(report.after.counts.probe_build_slots, 2);
    assert.deepEqual(report.integrityCheck, ["ok"]);
    assert.deepEqual(report.foreignKeyViolations, []);
    const source = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(legacyData(source), original);
      assert.equal(source.prepare("SELECT value FROM eval_meta WHERE key='schema_version'").get()?.value, "3");
      assert.equal(source.prepare("SELECT name FROM sqlite_master WHERE name='probe_build_plans'").get(), undefined);
      assert.equal(source.prepare("SELECT count(*) AS n FROM runtime_task_lock").get()?.n, 0);
    } finally { source.close(); }
    assert.deepEqual(await readdir(dir), ["eval.sqlite"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failure after legacy slot insertion rolls back all schema and data changes and retains the backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migration-rollback-"));
  try {
    const path = join(dir, "eval.sqlite");
    const backupPath = join(dir, "before-failure.sqlite");
    const fixture = createV3(path);
    const original = legacyData(fixture);
    fixture.exec(`CREATE TRIGGER fixture_migration_failure BEFORE UPDATE OF value ON eval_meta
      WHEN NEW.value='4' BEGIN SELECT RAISE(ABORT,'fixture_migration_failure'); END;`);
    fixture.close();
    await assert.rejects(migrateEvalDatabase(path, { backupPath }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fixture_migration_failure/);
      assert.ok(error.message.includes(backupPath), "failure identifies the retained pre-migration snapshot");
      return true;
    });
    const source = new DatabaseSync(path);
    const saved = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.deepEqual(legacyData(source), original);
      assert.deepEqual(legacyData(saved), original);
      assert.equal(source.prepare("SELECT value FROM eval_meta WHERE key='schema_version'").get()?.value, "3");
      assert.equal(source.prepare("SELECT name FROM sqlite_master WHERE name='probe_build_plans'").get(), undefined);
      assert.ok(!source.prepare("PRAGMA table_info(probe_runs)").all().some(column => column.name === "owner_token"));
      assert.equal(source.prepare("SELECT count(*) AS n FROM runtime_task_lock").get()?.n, 0);
      source.exec("DROP TRIGGER fixture_migration_failure");
    } finally { source.close(); saved.close(); }
    assert.equal((await migrateEvalDatabase(path, { backupPath: join(dir, "retry.sqlite") })).toVersion, "4");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("repeating the migration creates no duplicate plans, slots, or backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migration-idempotent-"));
  try {
    const path = join(dir, "eval.sqlite");
    createV3(path).close();
    const first = await migrateEvalDatabase(path);
    assert.ok(first.backupPath);
    const second = await migrateEvalDatabase(path, { backupPath: first.backupPath });
    assert.equal(second.fromVersion, "4");
    assert.equal(second.toVersion, "4");
    assert.equal(second.migrated, false);
    assert.equal(second.backupPath, null);
    assert.equal(second.legacy.createdPlans, 0);
    assert.deepEqual(second.legacy.incompletePlanIds, [1]);
    assert.equal(second.after.counts.probe_build_plans, 1);
    assert.equal(second.after.counts.probe_build_slots, 2);
    assert.equal(second.after.counts.probe_build_executions, 1);
    assert.deepEqual(second.before, second.after);
    assert.deepEqual(first.after, second.after);
    assert.equal((await readdir(dir)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SQLite backup includes committed WAL pages even while another connection keeps the WAL open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migration-wal-"));
  const path = join(dir, "eval.sqlite");
  const fixture = createV3(path);
  try {
    fixture.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    fixture.exec(`INSERT INTO source_materials (video_id,video_key,content,content_sha256,split_snapshot,imported_at)
      VALUES ('BV_WAL','BV_WAL','only committed in WAL','wal-sha','test','2026-01-06')`);
    assert.ok((await stat(`${path}-wal`)).size > 0);
    const report = await migrateEvalDatabase(path, { backupPath: join(dir, "snapshot.sqlite") });
    assert.equal(report.before.counts.source_materials, 2);
    const saved = new DatabaseSync(report.backupPath!, { readOnly: true });
    try {
      assert.equal(saved.prepare("SELECT content FROM source_materials WHERE video_id='BV_WAL'").get()?.content, "only committed in WAL");
      assert.equal(saved.prepare("SELECT count(*) AS n FROM runtime_task_lock").get()?.n, 0);
      assert.deepEqual(legacyData(saved), legacyData(fixture));
    } finally { saved.close(); }
  } finally { fixture.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an existing backup file is retained and the source business schema stays v3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migration-backup-"));
  try {
    const path = join(dir, "eval.sqlite");
    const backupPath = join(dir, "existing.sqlite");
    createV3(path).close();
    await writeFile(backupPath, "retained backup bytes");
    await assert.rejects(migrateEvalDatabase(path, { backupPath }), /EEXIST/);
    assert.equal(await readFile(backupPath, "utf8"), "retained backup bytes");
    const source = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(source.prepare("SELECT value FROM eval_meta WHERE key='schema_version'").get()?.value, "3");
      assert.equal(source.prepare("SELECT name FROM sqlite_master WHERE name='probe_build_plans'").get(), undefined);
      assert.equal(source.prepare("SELECT count(*) AS n FROM runtime_task_lock").get()?.n, 0);
    } finally { source.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("active writer ownership blocks both migration modes before backup or business DDL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migration-busy-"));
  const path = join(dir, "eval.sqlite");
  const fixture = createV3(path);
  const writer = new TaskSession(fixture, "eval:active-fixture");
  try {
    for (const dryRun of [false, true]) {
      await assert.rejects(migrateEvalDatabase(path, { dryRun, backupPath: join(dir, "blocked.sqlite") }), /database_busy/);
    }
    assert.equal(fixture.prepare("SELECT value FROM eval_meta WHERE key='schema_version'").get()?.value, "3");
    assert.equal(fixture.prepare("SELECT name FROM sqlite_master WHERE name='probe_build_plans'").get(), undefined);
    assert.equal(fixture.prepare("SELECT owner_token FROM runtime_task_lock").get()?.owner_token, writer.ownerToken);
    assert.deepEqual(await readdir(dir), ["eval.sqlite"]);
  } finally { writer.release(); fixture.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const conflicting of [false, true]) {
  test(`migration restores a trusted writer batch and reports mismatches without rewriting probes (conflict=${conflicting})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-migration-writer-"));
    try {
      const path = join(dir, "eval.sqlite");
      const fixture = createV3(path);
      fixture.prepare("UPDATE probe_runs SET config_json=?,prompts_json=? WHERE id=1").run(
        JSON.stringify({ modelId: "old-builder", maxProbesPerVideo: 3, maxRevisions: 2, maxAnswerAttempts: 2 }),
        JSON.stringify({ probeWriter: "writer", probeCritic: "critic", reference: "reference", verifier: "verifier", adversary: "adversary" }),
      );
      const drafts = [
        { probeType: "answer", persona: "reader", targetTurns: 1, question: conflicting ? "mismatched question" : "original question", anchor: "source anchor", trap: "trap" },
        { probeType: "answer", persona: "reader", targetTurns: 1, question: "unfinished question", anchor: "anchor", trap: "trap" },
        { probeType: "answer", persona: "reader", targetTurns: 1, question: "not yet persisted question", anchor: "anchor", trap: "trap" },
      ];
      fixture.prepare(`INSERT INTO agent_calls (run_ref,role,model,input_refs_json,output_text,started_at,ended_at)
        VALUES ('probe_build:1','probe_writer','old-builder','{"source_material_id":1,"mode":"draft"}',?,'2026-01-01','2026-01-02')`).run(JSON.stringify({ probes: drafts }));
      const original = legacyData(fixture);
      fixture.close();
      const report = await migrateEvalDatabase(path);
      assert.equal(report.legacy.createdPlans, 1);
      assert.deepEqual(report.legacy.incompletePlanIds, conflicting ? [1] : []);
      assert.deepEqual(report.legacy.conflictPlanIds, conflicting ? [1] : []);
      assert.equal(report.after.counts.probe_build_slots, conflicting ? 2 : 3);
      assert.equal(report.after.counts.probes, 2);
      const migrated = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(legacyData(migrated), original);
        const plan = migrated.prepare("SELECT plan_complete,error_code FROM probe_build_plans").get();
        assert.equal(plan?.plan_complete, conflicting ? 0 : 1);
        assert.equal(plan?.error_code, conflicting ? "checkpoint_invalid" : "build_incomplete");
        if (!conflicting) assert.equal(migrated.prepare("SELECT probe_id FROM probe_build_slots WHERE slot_index=3").get()?.probe_id, null);
      } finally { migrated.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("v3 report remains readable without schema changes and legacy v1/v2 retain their data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migration-readonly-"));
  try {
    const path = join(dir, "eval.sqlite");
    createV3(path).close();
    const before = await readFile(path);
    const historical = new EvalStore(path, { readOnly: true });
    try {
      const report = buildEvalReport({ evalStore: historical, runIds: [1] });
      assert.equal(report.entries[0]?.model, "old-model");
      assert.equal(report.entries[0]?.historyMode, "self");
      assert.equal(report.entries[0]?.meanItemScore, 90);
      assert.equal(historical.getMeta("schema_version"), "3");
    } finally { historical.close(); }
    assert.deepEqual(await readFile(path), before);
    for (const version of ["1", "2"]) {
      const legacyPath = join(dir, `legacy-v${version}.sqlite`);
      const legacy = new DatabaseSync(legacyPath);
      legacy.exec("CREATE TABLE eval_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE old_payload(value TEXT); INSERT INTO old_payload VALUES ('preserved')");
      legacy.prepare("INSERT INTO eval_meta VALUES ('schema_version',?)").run(version);
      legacy.close();
      await assert.rejects(migrateEvalDatabase(legacyPath), /请保留原库/);
      const checked = new DatabaseSync(legacyPath, { readOnly: true });
      try {
        assert.equal(checked.prepare("SELECT value FROM eval_meta").get()?.value, version);
        assert.equal(checked.prepare("SELECT value FROM old_payload").get()?.value, "preserved");
        assert.equal(checked.prepare("SELECT name FROM sqlite_master WHERE name='probe_build_plans'").get(), undefined);
      } finally { checked.close(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dry-run foreign-key validation failure preserves the source and removes its temporary snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migration-invalid-"));
  try {
    const path = join(dir, "eval.sqlite");
    const fixture = createV3(path);
    fixture.exec("PRAGMA foreign_keys=OFF; UPDATE probe_calibrations SET probe_id=999 WHERE id=1");
    const original = legacyData(fixture);
    fixture.close();
    await assert.rejects(migrateEvalDatabase(path, { dryRun: true }), /eval_migration_integrity/);
    const source = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(legacyData(source), original);
      assert.equal(source.prepare("SELECT value FROM eval_meta WHERE key='schema_version'").get()?.value, "3");
      assert.equal(source.prepare("SELECT name FROM sqlite_master WHERE name='probe_build_plans'").get(), undefined);
    } finally { source.close(); }
    assert.deepEqual(await readdir(dir), ["eval.sqlite"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("fresh eval database initializes v4 after its writer coordination table is claimed", () => {
  const db = new DatabaseSync(":memory:");
  const session = new TaskSession(db, "eval:test");
  try {
    session.mutate(() => ensureEvalSchemaV3(db, false));
    assert.equal(db.prepare("SELECT value FROM eval_meta WHERE key = 'schema_version'").get()?.value, "4");
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'probe_build_plans'").get());
    assert.ok(db.prepare("PRAGMA table_info(eval_runs)").all().some(column => column.name === "owner_token"));
  } finally { session.release(); db.close(); }
});

test("v3 permits read-only history but requires explicit migration before writes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(EVAL_SCHEMA_V3_SQL);
    db.exec("INSERT INTO eval_meta VALUES ('schema_version', '3')");
    assert.doesNotThrow(() => ensureEvalSchemaV3(db, true));
    assert.throws(() => ensureEvalSchemaV3(db, false), /eval migrate/);
    assert.equal(db.prepare("SELECT value FROM eval_meta WHERE key = 'schema_version'").get()?.value, "3");
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'probe_build_plans'").get(), undefined);
  } finally { db.close(); }
});
