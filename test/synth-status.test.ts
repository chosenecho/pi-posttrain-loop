import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DataMakerStore } from "../src/synth/store/index.js";
import { getSynthStatus } from "../src/synth/workflows.js";

test("status remains read-only beside an active writer and reports pending corpus split sync", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synth-status-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputDir = join(dir, "corpus");
  await mkdir(join(inputDir, "by_bv", "BV_STATUS"), { recursive: true });
  await writeFile(join(inputDir, "by_bv", "BV_STATUS", "P001.md"), "# 状态材料\n正文");
  const dbPath = join(dir, "main.sqlite");
  const writer = new DataMakerStore(dbPath);
  try {
    const legacy = writer.upsertMaterial({ videoId: "BV_LEGACY", content: "历史正文" });
    const questionId = writer.insertQuestion({ materialId: legacy.id, question: "历史问题" }).record.id;
    const runId = writer.createRun({ kind: "answer_judge", maxAttempts: 1, config: {}, prompts: {}, skills: [], exportPolicy: {} });
    const itemId = writer.createRunItems(runId, [questionId]).get(questionId)!;
    writer.startRunItem(itemId);
    const report = await getSynthStatus({ dbPath, inputDir });
    assert.equal(report.totalVideos, 1);
    assert.equal(report.unprocessedVideos, 1);
    assert.equal(report.pendingSplitSyncVideos, 2);
    assert.equal(writer.listVideoSplits().length, 0);
    assert.equal(writer.queryOutcomeCounts(runId).running, 1);
    assert.deepEqual(await getSynthStatus({ dbPath, inputDir }), report);
  } finally { writer.close(); }
});

test("status on a missing database never initializes a database file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synth-status-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "missing.sqlite");
  await assert.rejects(getSynthStatus({ dbPath, inputDir: dir }));
  assert.equal(existsSync(dbPath), false);
});
