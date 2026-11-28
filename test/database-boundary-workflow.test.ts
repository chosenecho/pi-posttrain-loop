import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { importTestSources } from "../src/eval/source-import.js";
import { EvalStore } from "../src/eval/store/index.js";
import { freezeEvalSuite } from "../src/eval/suite-freeze.js";
import { makeEvalSuiteWorkflow } from "../src/eval/workflows.js";
import { DataMakerStore } from "../src/synth/store/index.js";
import { storeConnection } from "./fixtures/store-connection.js";

function seedMain(path: string): void {
  const store = new DataMakerStore(path);
  try {
    store.assignVideoSplit({ videoKey: "BV_BOUNDARY", split: "test", method: "manual" });
    store.upsertMaterial({ videoId: "BV_BOUNDARY", content: "仅供盲测使用的主库材料。" });
  } finally { store.close(); }
}

function snapshotMain(path: string) {
  const store = new DataMakerStore(path, { readOnly: true });
  try {
    return {
      bytes: readFileSync(path),
      schema: storeConnection(store).prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
      owner: storeConnection(store).prepare("SELECT * FROM runtime_task_lock").all(),
      materials: store.listAllMaterials(),
      splits: store.listVideoSplits(),
    };
  } finally { store.close(); }
}

function optionalLink(t: TestContext, kind: "hardlink" | "symlink", path: string, alias: string): boolean {
  try {
    if (kind === "hardlink") linkSync(path, alias);
    else symlinkSync(path, alias, "file");
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))) throw error;
    t.skip(`${kind} fixture unavailable: ${error.code}`);
    return false;
  }
}

for (const kind of ["same path", "relative alias", "normalized alias", "hardlink", "symlink", "Windows case alias"] as const) {
  test(`make rejects ${kind} before eval DDL, source import, or model calls`, async (t) => {
    if (kind === "Windows case alias" && process.platform !== "win32") {
      t.skip("Windows case-insensitive path fixture requires Windows");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "database-workflow-"));
    try {
      const mainPath = join(dir, "main.sqlite");
      seedMain(mainPath);
      let evalPath = mainPath;
      if (kind === "relative alias") evalPath = relative(process.cwd(), mainPath);
      if (kind === "normalized alias") {
        mkdirSync(join(dir, "nested"));
        evalPath = `${dir}/nested/../main.sqlite`;
      }
      if (kind === "hardlink" || kind === "symlink") {
        evalPath = join(dir, `${kind}.sqlite`);
        if (!optionalLink(t, kind, mainPath, evalPath)) return;
      }
      if (kind === "Windows case alias") evalPath = mainPath.toUpperCase();
      const before = snapshotMain(mainPath);
      const filesBefore = readdirSync(dir);
      let modelCalls = 0;
      const progress: string[] = [];
      await assert.rejects(makeEvalSuiteWorkflow({
        mainDbPath: mainPath,
        evalDbPath: evalPath,
        noFreeze: true,
        runRole: async () => { modelCalls++; throw new Error("model must not start"); },
        onProgress: (message) => progress.push(message),
      }), /database_path_conflict/);
      assert.equal(modelCalls, 0);
      assert.deepEqual(progress, [], "source import must not start");
      assert.deepEqual(snapshotMain(mainPath), before, "main schema, coordination rows, materials and file bytes must remain unchanged");
      assert.deepEqual(readdirSync(dir), filesBefore, "no SQLite side files may be created");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("source import and freeze reject a main/eval alias before changing an existing eval database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "database-low-level-"));
  try {
    const path = join(dir, "eval.sqlite");
    const store = new EvalStore(path);
    try {
      store.insertSourceMaterial({ videoId: "BV_ORIGINAL", content: "已有不可变快照", splitSnapshot: "test" });
      const sourcesBefore = store.listSourceMaterials();
      const schemaBefore = storeConnection(store).prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      await assert.rejects(importTestSources({ evalStore: store, mainDbPath: path }), /database_path_conflict/);
      await assert.rejects(freezeEvalSuite({ evalStore: store, mainDbPath: path, name: "conflict" }), /database_path_conflict/);
      assert.deepEqual(store.listSourceMaterials(), sourcesBefore);
      assert.deepEqual(storeConnection(store).prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(), schemaBefore);
      assert.equal(store.getSuite("conflict"), undefined);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two different physical databases import successfully while the main database remains unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "database-distinct-"));
  try {
    const mainPath = join(dir, "main.sqlite");
    seedMain(mainPath);
    const before = snapshotMain(mainPath);
    const store = new EvalStore(join(dir, "eval.sqlite"));
    try {
      const report = await importTestSources({ evalStore: store, mainDbPath: mainPath });
      assert.equal(report.importedChunks, 1);
      assert.equal(report.importedVideos, 1);
      assert.equal(store.listSourceMaterials()[0]?.content, "仅供盲测使用的主库材料。");
      assert.deepEqual(snapshotMain(mainPath), before);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
