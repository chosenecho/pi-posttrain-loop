import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DataMakerStore, formatSamplesJsonl, type MergedExportOptions } from "../src/synth/store/index.js";
import { runSynthExportWorkflow } from "../src/synth/workflows.js";
import { populateSynthExportFixture } from "./fixtures/synth-export.js";

const oracle = JSON.parse(readFileSync(new URL("./fixtures/synth-export-oracle.json", import.meta.url), "utf8")) as Record<string, {
  options: MergedExportOptions;
  merged: unknown;
  trainJsonl: string;
  valJsonl: string;
}>;

test("public export preserves captured formal filtering, dedup, tool projection and seeded video split bytes", () => {
  const store = new DataMakerStore(":memory:");
  try {
    populateSynthExportFixture(store);
    for (const [mode, expected] of Object.entries(oracle)) {
      const merged = store.exportMergedDataset(expected.options);
      assert.deepEqual(merged, expected.merged, mode);
      assert.equal(formatSamplesJsonl(merged.train.map((r) => r.sample)), expected.trainJsonl, mode);
      assert.equal(formatSamplesJsonl(merged.val.map((r) => r.sample)), expected.valJsonl, mode);
    }
    assert.throws(() => store.exportMergedDataset({ allFormal: true, dedup: "error" }), /q1 \(runs: 2,3\)/);
  } finally { store.close(); }
});

test("export workflow writes the captured train/validation bytes and reports their business counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synth-export-oracle-"));
  try {
    const dbPath = join(dir, "main.sqlite");
    const store = new DataMakerStore(dbPath);
    populateSynthExportFixture(store);
    store.close();
    const expected = oracle.latest!;
    const outPath = join(dir, "train.jsonl");
    const valOutPath = join(dir, "val.jsonl");
    const report = await runSynthExportWorkflow({ ...expected.options, dbPath, outPath, valOutPath });
    assert.equal(readFileSync(outPath, "utf8"), expected.trainJsonl);
    assert.equal(readFileSync(valOutPath, "utf8"), expected.valJsonl);
    assert.equal(report.mode, "all-formal");
    assert.equal(report.materialCount, 4);
    assert.equal(report.trainSamples, 1);
    assert.equal(report.valSamples, 3);
    assert.equal(report.duplicateQuestionsResolved, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
