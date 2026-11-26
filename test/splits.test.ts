import assert from "node:assert/strict";
import test from "node:test";
import { selectVideos, type VideoUnit } from "../src/synth/corpus.js";
import { DataMakerStore } from "../src/synth/store/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateSplit } from "../src/shared/schema.js";
import {
  assertSynthSplit,
  runSynthBatchWorkflow,
  runSynthExportWorkflow,
  runSynthJudgeWorkflow,
  runSynthQuestionsWorkflow,
  SYNTH_TEST_SPLIT_FORBIDDEN_MESSAGE,
} from "../src/synth/workflows.js";
import {
  backfillProcessedTrainSplits,
  computeHashBucket,
  computeVideoSplit,
  ensureVideoSplit,
  summarizeSplitCounts,
  syncCorpusSplits,
} from "../src/synth/splits.js";

test("computeVideoSplit is deterministic, corpus-size invariant, and groups all multi-P chunks into the same split", () => {
  const baseKey = "BV1aU4y1b7mX";
  const variants = [
    baseKey,
    `${baseKey}/P001`,
    `${baseKey}/P012`,
    `${baseKey}/P001-P004`,
    `${baseKey}/P005-P008`,
  ];
  const expectedBucket = computeHashBucket(baseKey);
  const expectedSplit = computeVideoSplit(baseKey);
  for (const variant of variants) {
    assert.equal(computeHashBucket(variant), expectedBucket);
    assert.equal(computeVideoSplit(variant), expectedSplit);
  }

  // Verify validateSplit
  assert.equal(validateSplit("train"), "train");
  assert.equal(validateSplit("test"), "test");
  assert.equal(validateSplit("dpo"), "dpo");
  assert.throws(() => validateSplit("val"), /train、test 或 dpo/);
});

test("video_splits enforces immutability triggers and backfills historical processed videos as train", () => {
  const store = new DataMakerStore(":memory:");
  try {
    // BV_LEGACY has a hash bucket < 0.10 under weimingzi-split-v1 (would be 'test' if hashed fresh),
    // but because it already has a question in SQLite, backfill must lock it to 'train'!
    assert.equal(computeVideoSplit("BV_LEGACY"), "test");
    const legacyMat = store.upsertMaterial({ videoId: "BV_LEGACY/P001", content: "历史已训练视频正文" });
    store.insertQuestion({ materialId: legacyMat.id, question: "历史问题？" });

    const backfilled = backfillProcessedTrainSplits(store);
    assert.equal(backfilled, 1);

    const record = store.getVideoSplit("BV_LEGACY/P002");
    assert.ok(record);
    assert.equal(record.video_key, "BV_LEGACY");
    assert.equal(record.split, "train");
    assert.equal(record.method, "backfill");

    // Re-running backfill or ensureVideoSplit is idempotent and preserves 'train'
    assert.equal(backfillProcessedTrainSplits(store), 0);
    assert.equal(ensureVideoSplit(store, "BV_LEGACY").split, "train");
    assert.throws(
      () => ensureVideoSplit(store, "BV_LEGACY", { preferredSplit: "test", method: "manual" }),
      /已锁定在 train 分区/,
    );

    // SQLite triggers reject direct UPDATE or DELETE on video_splits
    assert.throws(
      () => store.db.prepare("UPDATE video_splits SET split = 'test' WHERE video_key = 'BV_LEGACY'").run(),
      /cannot modify assigned video_split/,
    );
    assert.throws(
      () => store.db.prepare("DELETE FROM video_splits WHERE video_key = 'BV_LEGACY'").run(),
      /cannot delete assigned video_split/,
    );
  } finally {
    store.close();
  }
});

test("syncCorpusSplits and selectVideos partition corpus into train, test, and dpo without cross-split leakage", () => {
  const store = new DataMakerStore(":memory:");
  try {
    const units: VideoUnit[] = [];
    for (let i = 1; i <= 120; i++) {
      const id = `BV_SYN_${String(i).padStart(4, "0")}`;
      units.push({
        videoId: id,
        sourceGroup: "by_bv",
        partPaths: [`/corpus/${id}/P001.md`],
        sourcePath: `/corpus/${id}`,
      });
    }

    const splitMap = syncCorpusSplits(store, units);
    assert.equal(splitMap.size, 120);

    const trainUnits = selectVideos(units, { split: "train", splitMap });
    const testUnits = selectVideos(units, { split: "test", splitMap });
    const dpoUnits = selectVideos(units, { split: "dpo", splitMap });

    assert.ok(trainUnits.length > 0);
    assert.ok(testUnits.length > 0);
    assert.ok(dpoUnits.length > 0);
    assert.equal(trainUnits.length + testUnits.length + dpoUnits.length, 120);

    // Adding 30 new videos to the corpus never changes any of the original 120 split assignments
    const expandedUnits = [
      ...units,
      ...Array.from({ length: 30 }, (_, idx) => ({
        videoId: `BV_NEW_${idx + 1}`,
        sourceGroup: "by_bv" as const,
        partPaths: [`/corpus/BV_NEW_${idx + 1}/P001.md`],
        sourcePath: `/corpus/BV_NEW_${idx + 1}`,
      })),
    ];
    const expandedMap = syncCorpusSplits(store, expandedUnits);
    for (const u of units) {
      assert.equal(expandedMap.get(u.videoId)?.split, splitMap.get(u.videoId)?.split);
    }

    const summary = summarizeSplitCounts(store, expandedUnits);
    assert.equal(
      summary.train.totalVideos + summary.test.totalVideos + summary.dpo.totalVideos,
      150,
    );
  } finally {
    store.close();
  }
});

test("exportMergedDataset excludes test/dpo from training exports and keeps multi-P chunks together during valRatio split", () => {
  const store = new DataMakerStore(":memory:");
  try {
    // Register 2 train videos (one with 2 multi-P chunks), 1 test video, and 1 dpo video
    store.assignVideoSplit({ videoKey: "BV_TRAIN_A", split: "train", method: "manual" });
    store.assignVideoSplit({ videoKey: "BV_TRAIN_B", split: "train", method: "manual" });
    store.assignVideoSplit({ videoKey: "BV_TEST_ONLY", split: "test", method: "manual" });
    store.assignVideoSplit({ videoKey: "BV_DPO_ONLY", split: "dpo", method: "manual" });

    const matTrainA1 = store.upsertMaterial({ videoId: "BV_TRAIN_A/P001-P002", content: "训练集A上篇" });
    const matTrainA2 = store.upsertMaterial({ videoId: "BV_TRAIN_A/P003-P004", content: "训练集A下篇" });
    const matTrainB = store.upsertMaterial({ videoId: "BV_TRAIN_B", content: "训练集B全文" });
    const matTest = store.upsertMaterial({ videoId: "BV_TEST_ONLY", content: "测试集全文" });
    const matDpo = store.upsertMaterial({ videoId: "BV_DPO_ONLY", content: "DPO集全文" });

    const qA1 = store.insertQuestion({ materialId: matTrainA1.id, question: "A上篇问题？" }).record;
    const qA2 = store.insertQuestion({ materialId: matTrainA2.id, question: "A下篇问题？" }).record;
    const qB = store.insertQuestion({ materialId: matTrainB.id, question: "B问题？" }).record;
    const qTest = store.insertQuestion({ materialId: matTest.id, question: "测试集问题？" }).record;
    const qDpo = store.insertQuestion({ materialId: matDpo.id, question: "DPO问题？" }).record;

    const addPassedQuestion = (runId: number, qId: number, answer: string) => {
      const itemId = store.createRunItems(runId, [qId]).get(qId)!;
      store.startRunItem(itemId);
      const t1 = store.createTurn({ runItemId: itemId, turnNo: 1 });
      const a1 = store.startAttempt({ turnId: t1, attemptNo: 1 });
      const ca = store.startModelCall({ runId, role: "answer", turnId: t1, attemptId: a1, inputRefs: {} });
      store.finishModelCall(ca, answer);
      store.recordAttemptAnswer(a1, answer);
      const cj = store.startModelCall({ runId, role: "judge", turnId: t1, attemptId: a1, inputRefs: {} });
      store.commitJudgeOutcome({
        runItemId: itemId,
        turnId: t1,
        turnNo: 1,
        attemptId: a1,
        judgeCallId: cj,
        judgeOutputText: '{"decision":"pass","issues":[],"feedback":""}',
        review: { decision: "pass", issues: [], feedback: "" },
        isFinalTurn: true,
        exhaustedBudget: false,
      });
    };

    // Train run (even if qTest was accidentally included in a training_enabled=true run, video_splits blocks it!)
    const trainRunId = store.createRun({
      kind: "answer_judge",
      maxAttempts: 2,
      maxTurns: 1,
      config: { split: "train" },
      prompts: {},
      skills: [],
      exportPolicy: { format: "messages_jsonl", split: "train", training_enabled: true },
    });
    addPassedQuestion(trainRunId, qA1.id, "回答A1");
    addPassedQuestion(trainRunId, qA2.id, "回答A2");
    addPassedQuestion(trainRunId, qB.id, "回答B");
    addPassedQuestion(trainRunId, qTest.id, "误混入训练运行的测试题回答");
    store.finishRun(trainRunId, "completed");

    // Formal test run (training_enabled=false, eval_enabled=true)
    const testRunId = store.createRun({
      kind: "answer_judge",
      maxAttempts: 2,
      maxTurns: 1,
      config: { split: "test" },
      prompts: {},
      skills: [],
      exportPolicy: { format: "messages_jsonl", split: "test", purpose: "test", training_enabled: false, eval_enabled: true },
    });
    addPassedQuestion(testRunId, qTest.id, "正式测试题标准回答");
    store.finishRun(testRunId, "completed");

    // Formal dpo run
    const dpoRunId = store.createRun({
      kind: "answer_judge",
      maxAttempts: 2,
      maxTurns: 1,
      config: { split: "dpo" },
      prompts: {},
      skills: [],
      exportPolicy: { format: "messages_jsonl", split: "dpo", purpose: "dpo", training_enabled: false, eval_enabled: true },
    });
    addPassedQuestion(dpoRunId, qDpo.id, "正式DPO标准回答");
    store.finishRun(dpoRunId, "completed");

    // 1. Default allFormal exports ONLY train split (qA1, qA2, qB), never qTest or qDpo
    const trainExport = store.exportMergedDataset({ allFormal: true });
    assert.deepEqual(
      trainExport.train.map((r) => r.questionId).sort((a, b) => a - b),
      [qA1.id, qA2.id, qB.id],
    );

    // 2. Video-key level valRatio keeps both chunks of BV_TRAIN_A (qA1 and qA2) on the same side of train/val
    for (let seed = 1; seed <= 10; seed++) {
      const splitExport = store.exportMergedDataset({ allFormal: true, valRatio: 0.5, seed });
      const trainQIds = new Set(splitExport.train.map((r) => r.questionId));
      const valQIds = new Set(splitExport.val.map((r) => r.questionId));
      assert.equal(
        trainQIds.has(qA1.id),
        trainQIds.has(qA2.id),
        `chunks of BV_TRAIN_A must stay together (seed=${seed})`,
      );
      assert.equal(
        valQIds.has(qA1.id),
        valQIds.has(qA2.id),
        `chunks of BV_TRAIN_A must stay together in val (seed=${seed})`,
      );
    }

    // 3. allFormal + split='test' exports only qTest
    const testExport = store.exportMergedDataset({ allFormal: true, split: "test" });
    assert.equal(testExport.train.length, 1);
    assert.equal(testExport.train[0].questionId, qTest.id);
    assert.equal(testExport.train[0].sample.messages[1].content, "正式测试题标准回答");
  } finally {
    store.close();
  }
});

test("opening a main DB drops legacy test-v1 tables (eval_rubrics / eval_model_calls / test_set_versions)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dm-legacy-drop-"));
  const dbPath = join(dir, "main.sqlite");
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE test_set_versions (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TRIGGER trg_test_set_versions_immutable_delete BEFORE DELETE ON test_set_versions
      BEGIN SELECT RAISE(ABORT, 'cannot delete frozen test_set_version'); END;
      CREATE TABLE eval_model_calls (id INTEGER PRIMARY KEY, role TEXT NOT NULL);
      CREATE TABLE eval_rubrics (id INTEGER PRIMARY KEY, call_id INTEGER REFERENCES eval_model_calls(id), rubric_json TEXT);
      CREATE INDEX idx_eval_rubrics_call ON eval_rubrics(call_id);
      INSERT INTO test_set_versions (name) VALUES ('test-v1');
      INSERT INTO eval_model_calls (role) VALUES ('rubric');
      INSERT INTO eval_rubrics (call_id, rubric_json) VALUES (1, '{}');
    `);
    raw.close();

    const legacy = ["test_set_versions", "eval_rubrics", "eval_model_calls"];
    for (let open = 0; open < 2; open++) {
      // Second open verifies the drop is idempotent.
      const store = new DataMakerStore(dbPath);
      try {
        for (const name of legacy) {
          assert.equal(store.hasTable(name), false, `${name} should be dropped (open #${open + 1})`);
        }
        const leftovers = store.db.prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE '%test_set_version%' OR name LIKE '%eval_rubric%' OR name LIKE '%eval_model_call%'",
        ).all();
        assert.deepEqual(leftovers, []);
        assert.equal(store.hasTable("video_splits"), true);
        assert.equal(store.checkIntegrity().ok, true);
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synth run / questions / judge / export reject --split test (eval pipeline only)", async () => {
  assert.match(SYNTH_TEST_SPLIT_FORBIDDEN_MESSAGE, /test 分区仅供 eval 流水线使用/);
  assert.match(SYNTH_TEST_SPLIT_FORBIDDEN_MESSAGE, /npm run dm -- eval make/);
  assert.equal(assertSynthSplit("train"), "train");
  assert.equal(assertSynthSplit("dpo"), "dpo");
  assert.throws(() => assertSynthSplit("test"), /test 分区仅供 eval 流水线使用/);

  const dir = mkdtempSync(join(tmpdir(), "dm-synth-test-split-"));
  const dbPath = join(dir, "main.sqlite");
  const runRole = async () => {
    throw new Error("model must not be called");
  };
  try {
    await assert.rejects(
      runSynthBatchWorkflow({ dbPath, split: "test", runRole } as Parameters<typeof runSynthBatchWorkflow>[0]),
      /test 分区仅供 eval 流水线使用/,
    );
    await assert.rejects(
      runSynthQuestionsWorkflow({ dbPath, split: "test", runRole } as Parameters<typeof runSynthQuestionsWorkflow>[0]),
      /test 分区仅供 eval 流水线使用/,
    );
    await assert.rejects(
      runSynthJudgeWorkflow({ dbPath, split: "test", runRole } as Parameters<typeof runSynthJudgeWorkflow>[0]),
      /test 分区仅供 eval 流水线使用/,
    );
    await assert.rejects(
      runSynthExportWorkflow({ dbPath, split: "test" } as Parameters<typeof runSynthExportWorkflow>[0]),
      /test 分区仅供 eval 流水线使用/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
