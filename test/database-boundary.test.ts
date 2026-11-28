import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDistinctDatabaseFiles } from "../src/shared/database-path.js";
import { DataMakerStore } from "../src/synth/store/index.js";
import { storeConnection } from "./fixtures/store-connection.js";

test("rejects the same physical database without changing its schema or bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "database-boundary-"));
  try {
    const path = join(dir, "main.sqlite");
    const main = new DataMakerStore(path);
    try {
      main.upsertMaterial({ videoId: "BV_BOUNDARY", content: "主库原始材料" });
      const schemaBefore = storeConnection(main).prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      const bytesBefore = readFileSync(path);
      assert.throws(() => assertDistinctDatabaseFiles(path, path), /database_path_conflict/);
      assert.deepEqual(storeConnection(main).prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(), schemaBefore);
      assert.deepEqual(readFileSync(path), bytesBefore);
    } finally { main.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows distinct fresh paths without creating them or equating absent file identities", () => {
  const dir = mkdtempSync(join(tmpdir(), "database-fresh-"));
  try {
    const mainPath = join(dir, "main.sqlite");
    const evalPath = join(dir, "new", "eval.sqlite");
    assert.doesNotThrow(() => assertDistinctDatabaseFiles(mainPath, evalPath));
    assert.equal(existsSync(mainPath), false);
    assert.equal(existsSync(evalPath), false);
    assert.throws(() => assertDistinctDatabaseFiles(mainPath, join(dir, "main.sqlite")), /database_path_conflict/);
    writeFileSync(mainPath, "existing database placeholder");
    assert.doesNotThrow(() => assertDistinctDatabaseFiles(mainPath, evalPath));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("private memory and empty-filename SQLite connections may use the same connection path", () => {
  for (const path of [":memory:", ""]) {
    assert.doesNotThrow(() => assertDistinctDatabaseFiles(path, path));
    const first = new DataMakerStore(path);
    const second = new DataMakerStore(path);
    try {
      first.upsertMaterial({ videoId: "BV_PRIVATE", content: "独立连接" });
      assert.equal(second.listAllMaterials().length, 0);
    } finally { first.close(); second.close(); }
  }
});

test("propagates filesystem errors other than a missing fresh path", () => {
  assert.throws(() => assertDistinctDatabaseFiles("invalid\0.sqlite", "other.sqlite"), { code: "ERR_INVALID_ARG_VALUE" });
});

test("leaves directory paths to SQLite's original open error", () => {
  const dir = mkdtempSync(join(tmpdir(), "database-directory-"));
  try {
    assert.doesNotThrow(() => assertDistinctDatabaseFiles(dir, dir));
    assert.throws(() => new DataMakerStore(dir, { readOnly: true }), /open database|directory/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
