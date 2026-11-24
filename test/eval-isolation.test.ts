import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DataMakerStore } from "../src/db.js";
import { assertNoEvalLeak, readEvalVideoKeys } from "../src/eval-guard.js";
import { EvalStore } from "../src/eval/eval-db.js";
import { assertEvalAllowedSkillPath, readEvalSkill } from "../src/eval/eval-prompts.js";
import { importTestSources, mirrorMainVersion, verifySourceSplits } from "../src/eval/source-import.js";
import {
  DEFAULT_ANSWER_STYLE,
  readAnswerStyle,
  readEvalRubricSkill,
  readFollowupSkill,
  readQuestionSkill,
  readRubric,
} from "../src/io.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = join(ROOT, "node_modules/tsx/dist/cli.mjs");

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function seedMixedMainDb(mainDbPath: string): {
  testResultId: number;
  trainRunId: number;
  testVersionSha256: string;
} {
  const store = new DataMakerStore(mainDbPath);
  try {
    const mTrain = store.upsertMaterial({
      videoId: "BV_TRAIN_1",
      content: "这是一篇训练集文稿，讨论工作组织结构与分工原理。",
    });
    const mTestUsed = store.upsertMaterial({
      videoId: "BV_TEST_USED",
      content: "这是一篇已用于 test-v1 的测试文稿，讨论主体行动条件与薪俸结构。",
    });
    const mTestFresh = store.upsertMaterial({
      videoId: "BV_TEST_FRESH",
      content: "这是一篇尚未出题的全新测试文稿，讨论意识形态批判与消费主义机制。",
    });
    const mDpo = store.upsertMaterial({
      videoId: "BV_DPO_1",
      content: "这是一篇 DPO 偏好分区文稿，讨论技术哲学与工具理性。",
    });

    store.assignVideoSplit({ videoKey: "BV_TRAIN_1", split: "train", method: "manual" });
    store.assignVideoSplit({ videoKey: "BV_TEST_USED", split: "test", method: "manual" });
    store.assignVideoSplit({ videoKey: "BV_TEST_FRESH", split: "test", method: "manual" });
    store.assignVideoSplit({ videoKey: "BV_DPO_1", split: "dpo", method: "manual" });

    const addPassedQuestion = (runId: number, questionId: number, answer: string): number => {
      const items = store.createRunItems(runId, [questionId]);
      const itemId = items.get(questionId)!;
      store.startRunItem(itemId);
      const turnId = store.createTurn({ runItemId: itemId, turnNo: 1 });
      const attemptId = store.startAttempt({ turnId, attemptNo: 1 });
      const ca = store.startModelCall({ runId, role: "answer", turnId, attemptId, inputRefs: {} });
      store.finishModelCall(ca, answer);
      store.recordAttemptAnswer(attemptId, answer);
      const cj = store.startModelCall({ runId, role: "judge", turnId, attemptId, inputRefs: {} });
      const outcome = store.commitJudgeOutcome({
        runItemId: itemId,
        turnId,
        turnNo: 1,
        attemptId,
        judgeCallId: cj,
        judgeOutputText: '{"decision":"pass","issues":[],"feedback":""}',
        review: { decision: "pass", issues: [], feedback: "" },
        isFinalTurn: true,
        exhaustedBudget: false,
      });
      assert.ok(outcome.resultId !== undefined);
      return outcome.resultId;
    };

    // Create 1 passed train result
    const trainQ = store.insertQuestion({ materialId: mTrain.id, question: "什么是分工原理？" }).record;
    const trainRunId = store.createRun({
      kind: "answer_judge",
      maxAttempts: 2,
      maxTurns: 1,
      config: {},
      prompts: {},
      skills: [],
      exportPolicy: { format: "messages_jsonl", split: "train", training_enabled: true },
    });
    addPassedQuestion(trainRunId, trainQ.id, "分工是按结构协作。");
    store.finishRun(trainRunId, "completed");

    // Create 1 passed test result + rubric + frozen test-v1
    const testQ = store.insertQuestion({ materialId: mTestUsed.id, question: "薪俸结构如何制约行动主体？" }).record;
    const testRunId = store.createRun({
      kind: "answer_judge",
      maxAttempts: 2,
      maxTurns: 1,
      config: {},
      prompts: {},
      skills: [],
      exportPolicy: { format: "messages_jsonl", split: "test", training_enabled: false, eval_enabled: true },
    });
    const testResultId = addPassedQuestion(testRunId, testQ.id, "薪俸来源决定了时间与立身根本的支配关系。");
    store.finishRun(testRunId, "completed");
    store.upsertEvalRubric({
      resultId: testResultId,
      turnNo: 1,
      rubric: {
        stance: "薪俸来源构成结构性制约",
        keyPoints: ["薪俸支配时间与立身根本"],
        forbidden: ["归结为个人意志软弱"],
        mustNotHallucinate: ["不得编造具体工资数额"],
      },
    });
    const frozenTest = store.freezeTestSetVersion({ name: "test-v1", split: "test" });

    // Create 1 passed dpo result + frozen dpo-v1
    const dpoQ = store.insertQuestion({ materialId: mDpo.id, question: "工具理性的局限是什么？" }).record;
    const dpoRunId = store.createRun({
      kind: "answer_judge",
      maxAttempts: 2,
      maxTurns: 1,
      config: {},
      prompts: {},
      skills: [],
      exportPolicy: { format: "messages_jsonl", split: "dpo", training_enabled: false, eval_enabled: true },
    });
    addPassedQuestion(dpoRunId, dpoQ.id, "工具理性把手段当成目的。");
    store.finishRun(dpoRunId, "completed");
    store.freezeTestSetVersion({ name: "dpo-v1", split: "dpo" });

    // Reference unused variable mTestFresh just to be explicit
    assert.ok(mTestFresh.id > 0);
    return { testResultId, trainRunId, testVersionSha256: frozenTest.sha256 };
  } finally {
    store.close();
  }
}

test("training code never imports src/eval/* (static import graph isolation)", async () => {
  const allSrc = await listTsFiles(join(ROOT, "src"));
  const trainingFiles = allSrc.filter((filePath) => {
    const normalized = filePath.replace(/\\/g, "/");
    return !normalized.includes("/src/eval/") && !normalized.endsWith("/src/eval-cli.ts");
  });
  assert.ok(trainingFiles.length >= 15);
  for (const filePath of trainingFiles) {
    const code = await readFile(filePath, "utf8");
    const badImport = /(?:from\s+["'][^"']*\/eval\/[^"']*["']|import\s*\(\s*["'][^"']*\/eval\/[^"']*["']\s*\))/.test(code);
    assert.equal(badImport, false, `训练侧文件禁止 import src/eval/*：${filePath}`);
  }
});

test("skill loaders enforce two-way isolation between training and eval skill trees", async () => {
  const evalSkillPath = join(ROOT, "skills/eval/probe-design/SKILL.md");
  await assert.rejects(() => readQuestionSkill(evalSkillPath), /训练 Loop 禁止加载测试集专用 Skill/);
  await assert.rejects(() => readFollowupSkill(evalSkillPath), /训练 Loop 禁止加载测试集专用 Skill/);
  await assert.rejects(() => readAnswerStyle(evalSkillPath), /训练 Loop 禁止加载测试集专用 Skill/);
  await assert.rejects(() => readRubric(evalSkillPath), /训练 Loop 禁止加载测试集专用 Skill/);
  await assert.rejects(() => readEvalRubricSkill(evalSkillPath), /训练 Loop 禁止加载测试集专用 Skill/);

  for (const forbidden of [
    "skills/question-design/SKILL.md",
    "skills/followup-strategy/SKILL.md",
    "skills/quality-judge/SKILL.md",
    "skills/eval-rubric/SKILL.md",
    "skills/reasoning-writer/SKILL.md",
    "skills/reasoning-judge/SKILL.md",
  ]) {
    const full = join(ROOT, forbidden);
    assert.throws(() => assertEvalAllowedSkillPath(full, "test"), /评测 Loop 禁止加载训练专用 Skill/);
    await assert.rejects(() => readEvalSkill(full, "test"), /评测 Loop 禁止加载训练专用 Skill/);
  }

  // Allowed eval skill and shared answer-style baseline both succeed
  const probeDesign = await readEvalSkill(evalSkillPath, "probe-design");
  assert.equal(probeDesign.status, "ready");
  const answerStyle = await readEvalSkill(DEFAULT_ANSWER_STYLE, "answer-style");
  assert.equal(answerStyle.status, "ready");
});

test("EvalStore enforces test-only split check and immutability triggers", () => {
  const store = new EvalStore(":memory:");
  try {
    assert.throws(
      () => store.insertSourceMaterial({
        videoId: "BV_TRAIN",
        videoKey: "BV_TRAIN",
        partCount: 1,
        content: "训练集内容",
        splitSnapshot: "train",
      }),
      /只接受 test 分区/,
    );

    const { record } = store.insertSourceMaterial({
      videoId: "BV_TEST_1",
      videoKey: "BV_TEST_1",
      partCount: 1,
      content: "测试集内容原文",
      splitSnapshot: "test",
    });

    assert.throws(
      () => store.db.prepare("UPDATE source_materials SET content = 'x' WHERE id = ?").run(record.id),
      /source_materials is immutable/,
    );
    assert.throws(
      () => store.db.prepare("DELETE FROM source_materials WHERE id = ?").run(record.id),
      /source_materials is immutable/,
    );

    const runId = store.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
    const specId = store.createSpec({
      runId,
      sourceMaterialId: record.id,
      slotIndex: 1,
      probeType: "wild_short",
      persona: "学生",
      targetTurns: 1,
    });
    const probeId = store.createProbe({
      specId,
      question: "原题面？",
      anchor: "测试集内容原文",
      trap: "可能答偏",
      expectedBehavior: "answer",
      anchorVerified: true,
    });

    // While drafted, question can be revised
    store.reviseProbe(probeId, {
      question: "修改后题面？",
      anchor: "测试集内容原文",
      trap: "可能答偏",
      anchorVerified: true,
    });
    store.setProbeStatus(probeId, "accepted");

    // Once accepted, question/anchor/trap/expected_behavior are frozen
    assert.throws(
      () => store.db.prepare("UPDATE probes SET question = '篡改题面' WHERE id = ?").run(probeId),
      /accepted probe text is frozen/,
    );
    // Updating difficulty remains allowed for M2 calibration
    store.db.prepare("UPDATE probes SET difficulty = 'hard' WHERE id = ?").run(probeId);

    // Frozen suites are immutable
    store.freezeSuite({
      name: "indist-v1",
      kind: "in_distribution",
      sha256: "a".repeat(64),
      manifest: {},
      items: [{
        itemKey: "k1",
        videoKey: "BV_TEST_1",
        probeType: null,
        expectedBehavior: null,
        messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
        rubrics: [],
      }],
    });
    assert.throws(
      () => store.db.prepare("DELETE FROM suite_versions WHERE name = 'indist-v1'").run(),
      /suite_versions is immutable/,
    );
    assert.throws(
      () => store.db.prepare("UPDATE suite_items SET video_key = 'X'").run(),
      /suite_items is immutable/,
    );
  } finally {
    store.close();
  }
});

test("importTestSources, mirrorMainVersion, verifySourceSplits, and export-cli cross-DB leak guard", async () => {
  const dir = await makeTempDir("eval-iso-");
  try {
    const mainDbPath = join(dir, "data-maker.sqlite");
    const evalDbPath = join(dir, "eval.sqlite");
    const { testVersionSha256, trainRunId } = seedMixedMainDb(mainDbPath);

    const evalStore = new EvalStore(evalDbPath);
    try {
      // 1. Mirroring dpo-v1 is blocked
      assert.throws(
        () => mirrorMainVersion({ evalStore, mainDbPath, fromVersion: "dpo-v1", asSuiteName: "bad-dpo" }),
        /仅允许镜像 test 分区版本/,
      );

      // 2. Mirroring test-v1 -> indist-v1 succeeds with exact sha256 match and is idempotent
      const m1 = mirrorMainVersion({ evalStore, mainDbPath, fromVersion: "test-v1", asSuiteName: "indist-v1" });
      assert.equal(m1.created, true);
      assert.equal(m1.itemCount, 1);
      assert.equal(m1.rubricTurns, 1);
      assert.equal(m1.sha256, testVersionSha256);

      const m2 = mirrorMainVersion({ evalStore, mainDbPath, fromVersion: "test-v1", asSuiteName: "indist-v1" });
      assert.equal(m2.created, false);
      assert.equal(m2.sha256, testVersionSha256);

      // 3. Explicit import of train or dpo video is rejected
      await assert.rejects(
        () => importTestSources({ evalStore, mainDbPath, videoKeys: ["BV_TRAIN_1"] }),
        /不属于 test 分区/,
      );
      await assert.rejects(
        () => importTestSources({ evalStore, mainDbPath, videoKeys: ["BV_DPO_1"] }),
        /不属于 test 分区/,
      );

      // 4. Import with --exclude-used only picks BV_TEST_FRESH (excludes BV_TEST_USED from test-v1, train, dpo)
      const imported = await importTestSources({ evalStore, mainDbPath, excludeUsed: true });
      assert.equal(imported.importedVideos, 1);
      assert.deepEqual(imported.videoKeys, ["BV_TEST_FRESH"]);

      // 5. verifySourceSplits passes for genuine test sources and fails if a source is tampered or not test
      const sources = evalStore.listSourceMaterials();
      verifySourceSplits(mainDbPath, sources);
      assert.throws(
        () => verifySourceSplits(mainDbPath, [{ ...sources[0], videoKey: "BV_TRAIN_1" }]),
        /不是 test 分区/,
      );
      assert.throws(
        () => verifySourceSplits(mainDbPath, [{ ...sources[0], content: "被篡改的正文" }]),
        /内容 sha256 不一致/,
      );

      // 6. Training export leak guard: clean train export passes, overlapping eval key fails
      const evalKeys = readEvalVideoKeys(evalDbPath);
      assert.ok(evalKeys.has("BV_TEST_USED"));
      assert.ok(evalKeys.has("BV_TEST_FRESH"));
      assert.equal(evalKeys.has("BV_TRAIN_1"), false);
      assertNoEvalLeak(["BV_TRAIN_1"], evalKeys);
      assert.throws(() => assertNoEvalLeak(["BV_TRAIN_1", "BV_TEST_FRESH"], evalKeys), /测试集泄漏风险/);

      // 7. End-to-end export-cli test: clean training export succeeds
      const cleanOut = join(dir, "train-clean.jsonl");
      await execFileAsync(process.execPath, [
        TSX_CLI,
        join(ROOT, "src/export-cli.ts"),
        "--db", mainDbPath,
        "--eval-db", evalDbPath,
        "--run", String(trainRunId),
        "--out", cleanOut,
      ]);
      assert.equal(existsSync(cleanOut), true);

      // 8. Inject BV_TRAIN_1 into a poisoned eval DB and confirm export-cli blocks training export BEFORE writing file
      const poisonedEvalDb = join(dir, "eval-poisoned.sqlite");
      const poisonedStore = new EvalStore(poisonedEvalDb);
      poisonedStore.insertSourceMaterial({
        videoId: "BV_TRAIN_1",
        videoKey: "BV_TRAIN_1",
        partCount: 1,
        content: "模拟误入评测库的视频",
        splitSnapshot: "test",
      });
      poisonedStore.close();

      const leakedOut = join(dir, "train-leaked.jsonl");
      await assert.rejects(
        () => execFileAsync(process.execPath, [
          TSX_CLI,
          join(ROOT, "src/export-cli.ts"),
          "--db", mainDbPath,
          "--eval-db", poisonedEvalDb,
          "--run", String(trainRunId),
          "--out", leakedOut,
        ]),
        (err: unknown) => {
          const stderr = (err as { stderr?: string }).stderr ?? "";
          return /测试集泄漏风险/.test(stderr);
        },
      );
      assert.equal(existsSync(leakedOut), false, "触发泄漏守卫时绝不应写出训练文件");
    } finally {
      evalStore.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("importTestSources reads corpus directories and writes nothing to main DB", async () => {
  const dir = await makeTempDir("eval-corpus-");
  try {
    const corpusDir = join(dir, "corpus");
    const mainDbPath = join(dir, "main.sqlite");
    const evalDbPath = join(dir, "eval.sqlite");
    const byBv = join(corpusDir, "by_bv");

    // Create 1 train video folder and 2 test video folders on disk
    const { mkdir } = await import("node:fs/promises");
    for (const [bv, body] of [
      ["BV_TR_DISK", "# 标题\n这是训练集磁盘文稿内容。"],
      ["BV_TE_DISK_1", "# 标题1\n这是测试集磁盘文稿一，讲结构与主体。"],
      ["BV_TE_DISK_2", "# 标题2\n这是测试集磁盘文稿二，讲语言与意识形态。"],
    ] as const) {
      await mkdir(join(byBv, bv), { recursive: true });
      await writeFile(join(byBv, bv, "P001.md"), body, "utf8");
    }

    const mainStore = new DataMakerStore(mainDbPath);
    mainStore.assignVideoSplit({ videoKey: "BV_TR_DISK", split: "train", method: "manual" });
    mainStore.assignVideoSplit({ videoKey: "BV_TE_DISK_1", split: "test", method: "manual" });
    mainStore.assignVideoSplit({ videoKey: "BV_TE_DISK_2", split: "test", method: "manual" });
    mainStore.close();

    const evalStore = new EvalStore(evalDbPath);
    try {
      const report = await importTestSources({
        evalStore,
        mainDbPath,
        inputDir: corpusDir,
        limit: 10,
        shuffle: true,
        seed: 7,
        excludeUsed: true,
      });
      assert.equal(report.importedVideos, 2);
      assert.deepEqual([...report.videoKeys].sort(), ["BV_TE_DISK_1", "BV_TE_DISK_2"]);
      assert.equal(evalStore.listSourceMaterials().length, 2);
    } finally {
      evalStore.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
