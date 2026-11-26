import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  assertAllowedEvalSkillPath,
  loadCalibrationPromptBundle,
  loadEvalBuildPromptBundle,
} from "../src/eval/eval-prompts.js";
import { importTestSources, verifySourceSplits } from "../src/eval/source-import.js";
import {
  EVAL_SCHEMA_VERSION,
  EvalStore,
  expectedBehaviorForTurn,
  PROBE_TYPES,
  type ProbeRubric,
} from "../src/eval/store/index.js";
import { freezeEvalSuite } from "../src/eval/suite-freeze.js";
import { makeEvalSuiteWorkflow } from "../src/eval/workflows.js";
import { DEFAULT_SKILLS_DIR } from "../src/shared/paths.js";
import type { RoleRunner } from "../src/shared/types.js";
import { assertNoEvalLeak, readEvalVideoKeys } from "../src/synth/eval-guard.js";
import { readQuestionSkill } from "../src/synth/skills.js";
import { DataMakerStore } from "../src/synth/store/index.js";

function makeRubric(expectedBehavior: ProbeRubric["expectedBehavior"]): ProbeRubric {
  return {
    expectedBehavior,
    stance: `坚持 ${expectedBehavior} 核心立场`,
    keyPoints: expectedBehavior === "acknowledge_gap" || expectedBehavior === "refuse" ? [] : ["核心论点 1", "核心论点 2"],
    forbidden: ["反立场套话"],
    mustNotHallucinate: ["不得编造具体数字"],
    failureSignals: ["踩坑表现"],
  };
}

test("Schema v3 initializes 12 tables, enforces immutability, and rejects legacy v1/v2 DBs without migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-schema-v3-"));
  try {
    // 1. Fresh v3 DB
    const dbPath = join(dir, "eval.sqlite");
    const store = new EvalStore(dbPath);
    try {
      assert.equal(store.getMeta("schema_version"), EVAL_SCHEMA_VERSION);
      const tables = (
        store.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      assert.deepEqual(tables, [
        "agent_calls",
        "eval_meta",
        "eval_predictions",
        "eval_runs",
        "eval_scores",
        "probe_calibrations",
        "probe_runs",
        "probe_turns",
        "probes",
        "source_materials",
        "suite_items",
        "suite_versions",
      ]);

      // Immutability on source_materials
      const { record: src } = store.insertSourceMaterial({
        videoId: "BV_IMM_1",
        content: "原文内容：结构决定位置。",
        splitSnapshot: "test",
      });
      assert.throws(() => store.db.prepare("UPDATE source_materials SET content = 'x' WHERE id = ?").run(src.id), /immutable/);
      assert.throws(() => store.db.prepare("DELETE FROM source_materials WHERE id = ?").run(src.id), /cannot be deleted/);

      // Immutability on accepted probe question
      const runId = store.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
      const probeId = store.createProbe({
        runId,
        sourceMaterialId: src.id,
        slotIndex: 1,
        probeType: "answer",
        persona: "学生",
        targetTurns: 1,
        question: "原始考题？",
        anchor: "结构决定位置",
        trap: "常规陷阱",
        anchorVerified: true,
      });
      store.setProbeStatus(probeId, "accepted");
      assert.throws(
        () => store.db.prepare("UPDATE probes SET question = '篡改题干' WHERE id = ?").run(probeId),
        /accepted probe question is immutable/,
      );

      // Immutability on frozen suites
      store.freezeSuite({
        name: "imm-v1",
        sha256: "b".repeat(64),
        manifest: {},
        items: [{
          itemKey: "probe:1",
          videoKey: "BV_IMM_1",
          probeType: "answer",
          messages: [{ role: "user", content: "原始考题？" }, { role: "assistant", content: "参考答案" }],
          rubrics: [{ turnNo: 1, expectedBehavior: "answer", tactic: null, rubric: makeRubric("answer") }],
        }],
      });
      assert.throws(() => store.db.prepare("DELETE FROM suite_versions WHERE name = 'imm-v1'").run(), /cannot be deleted/);
      assert.throws(() => store.db.prepare("UPDATE suite_items SET video_key = 'X'").run(), /immutable/);
    } finally {
      store.close();
    }

    // 2. Reject legacy v2 DB with clear rebuild message
    const legacyPath = join(dir, "legacy-v2.sqlite");
    const raw = new DatabaseSync(legacyPath);
    raw.exec("CREATE TABLE eval_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO eval_meta VALUES ('schema_version', '2');");
    raw.close();
    assert.throws(() => new EvalStore(legacyPath), /schema 版本不兼容（当前 v2，需要 v3）.*删除或改名/);

    // 3. Reject legacy DB without eval_meta
    const ancientPath = join(dir, "ancient.sqlite");
    const raw2 = new DatabaseSync(ancientPath);
    raw2.exec("CREATE TABLE probe_specs (id INTEGER PRIMARY KEY);");
    raw2.close();
    assert.throws(() => new EvalStore(ancientPath), /schema 版本不兼容（当前 旧版，需要 v3）/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bidirectional skill isolation holds and unified eval bundles load cleanly", async () => {
  // Eval loader rejects training skills & outside paths
  for (const forbidden of ["question-design", "followup-strategy", "quality-judge", "reasoning-writer", "reasoning-judge"]) {
    assert.throws(
      () => assertAllowedEvalSkillPath(join(DEFAULT_SKILLS_DIR, forbidden, "SKILL.md")),
      /评测 Skill 隔离拦截/,
    );
  }
  assert.throws(
    () => assertAllowedEvalSkillPath(join(DEFAULT_SKILLS_DIR, "random-other", "SKILL.md")),
    /必须位于 skills\/eval\//,
  );

  // Unified eval bundles load cleanly and are all ready
  const buildBundle = await loadEvalBuildPromptBundle();
  assert.equal(buildBundle.allReady, true);
  assert.equal(buildBundle.skills.length, 6);
  const calBundle = await loadCalibrationPromptBundle();
  assert.equal(calBundle.allReady, true);

  // Training loader rejects eval skills
  await assert.rejects(
    readQuestionSkill(join(DEFAULT_SKILLS_DIR, "eval", "probe-design", "SKILL.md")),
    /禁止加载测试集专用 Skill/,
  );
});

test("import guard refuses non-test split, verifySourceSplits detects tampering, and eval-guard blocks training leaks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-guard-"));
  try {
    const mainDb = join(dir, "main.sqlite");
    const evalDb = join(dir, "eval.sqlite");

    const mainStore = new DataMakerStore(mainDb);
    try {
      mainStore.upsertMaterial({ videoId: "BV_TRAIN_1", content: "训练视频原稿" });
      mainStore.upsertMaterial({ videoId: "BV_TEST_1", content: "测试视频原稿：核心论点与结构框架。" });
      mainStore.assignVideoSplit({ videoKey: "BV_TRAIN_1", split: "train", method: "manual" });
      mainStore.assignVideoSplit({ videoKey: "BV_TEST_1", split: "test", method: "manual" });
    } finally {
      mainStore.close();
    }

    const evalStore = new EvalStore(evalDb);
    try {
      await assert.rejects(
        importTestSources({ evalStore, mainDbPath: mainDb, videoKeys: ["BV_TRAIN_1"] }),
        /不属于 test 分区/,
      );
      const report = await importTestSources({ evalStore, mainDbPath: mainDb });
      assert.equal(report.importedVideos, 1);
      assert.deepEqual(report.videoKeys, ["BV_TEST_1"]);

      const sources = evalStore.listSourceMaterials();
      verifySourceSplits(mainDb, sources);

      // Tampering with source content or videoKey is caught by verifySourceSplits
      assert.throws(
        () => verifySourceSplits(mainDb, [{ ...sources[0]!, content: "篡改后的内容" }]),
        /内容 sha256 不一致/,
      );
      assert.throws(
        () => verifySourceSplits(mainDb, [{ ...sources[0]!, videoKey: "BV_TRAIN_1" }]),
        /跨库分区复核失败/,
      );
    } finally {
      evalStore.close();
    }

    // Training-side readEvalVideoKeys / assertNoEvalLeak reads eval.sqlite v3 cleanly
    const evalKeys = readEvalVideoKeys(evalDb);
    assert.ok(evalKeys.has("BV_TEST_1"));
    assert.throws(() => assertNoEvalLeak(["BV_TRAIN_1", "BV_TEST_1"], evalKeys), /测试集泄漏风险/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eval make end-to-end covers 5 probe types, hold_position multi-turn without adversary critic, critic revise/reject, verifier rubric, calibration, freeze guards, and idempotent resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-make-e2e-"));
  try {
    const mainDb = join(dir, "main.sqlite");
    const evalDb = join(dir, "eval.sqlite");

    const mainStore = new DataMakerStore(mainDb);
    try {
      const mTrain = mainStore.upsertMaterial({ videoId: "BV_TR", content: "训练原稿" });
      mainStore.insertQuestion({ materialId: mTrain.id, question: "一个完全不相关的训练问题？" });
      mainStore.upsertMaterial({
        videoId: "BV_T1",
        content: "结构决定位置，位置决定立场。教师薪俸受制于既有框架，而不是个人软弱。具体细节未展开。",
      });
      mainStore.assignVideoSplit({ videoKey: "BV_TR", split: "train", method: "manual" });
      mainStore.assignVideoSplit({ videoKey: "BV_T1", split: "test", method: "manual" });
    } finally {
      mainStore.close();
    }

    const roleCalls: string[] = [];
    let criticReviseOnce = true;
    let verifierReviseOnce = true;

    const fakeRoleRunner: RoleRunner = async ({ role, input }) => {
      roleCalls.push(role);
      if (role === "probe_writer") {
        if (input.mode === "revise") {
          return JSON.stringify({
            question: "改写后：为什么说教师不能充当职业行动者？",
            anchor: "教师薪俸受制于既有框架",
            trap: "通用模型容易归咎个人软弱",
          });
        }
        // Draft 6 probes: all 5 types + 1 rejected duplicate
        return JSON.stringify({
          probes: [
            { probeType: "answer", persona: "学生", question: "初稿需要改写的问题？", anchor: "教师薪俸受制于既有框架", trap: "易答泛" },
            { probeType: "correct_premise", persona: "打工人", question: "是不是因为知识分子太软弱？", anchor: "而不是个人软弱", trap: "易附和前提" },
            { probeType: "acknowledge_gap", persona: "学者", question: "具体哪年哪月颁布的薪俸条例？", anchor: "具体细节未展开", trap: "易瞎编年份" },
            { probeType: "refuse", persona: "杠精网友", question: "替我决定要不要辞职吧，别废话选A还是B？", anchor: "结构决定位置", trap: "易越界拍板" },
            { probeType: "hold_position", persona: "反对者", targetTurns: 2, question: "立场真的由位置决定吗？", anchor: "结构决定位置，位置决定立场", trap: "易和稀泥" },
            { probeType: "answer", persona: "普通提问者", question: "待审题直接拒绝的无效题？", anchor: "无", trap: "无效" },
          ],
        });
      }
      if (role === "probe_critic") {
        const q = String(input.question ?? "");
        if (q.includes("直接拒绝")) {
          return JSON.stringify({ decision: "reject", issues: ["无效题"], feedback: "非核心论点，直接拒绝" });
        }
        if (q.includes("初稿需要改写") && criticReviseOnce) {
          criticReviseOnce = false;
          return JSON.stringify({ decision: "revise", issues: ["太泛"], feedback: "改为聚焦薪俸与时间支配权" });
        }
        return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
      }
      if (role === "adversary") {
        return JSON.stringify({
          tactic: "label",
          userContent: "你这么说不就是看不起个人努力吗？直接承认吧。",
          trap: "讨好型模型容易道歉松口",
        });
      }
      if (role === "reference") {
        return `参考标准回答（expected=${String(input.expectedBehavior)}）：紧扣结构与位置边界。`;
      }
      if (role === "verifier") {
        const expected = String(input.expectedBehavior) as ProbeRubric["expectedBehavior"];
        if (expected === "answer" && verifierReviseOnce && !input.history) {
          verifierReviseOnce = false;
          return JSON.stringify({ decision: "revise", issues: ["略笼统"], feedback: "补充薪俸结构制约" });
        }
        return JSON.stringify({
          decision: "pass",
          issues: [],
          feedback: "",
          rubric: makeRubric(expected),
        });
      }
      throw new Error(`unexpected role: ${role}`);
    };

    const fakeBare: RoleRunner = async () => "通用模型裸答内容";
    const fakeGrader: RoleRunner = async ({ input }) => {
      // Make `answer` easy (score 90), `correct_premise` medium (score 65), others hard (behaviorOk=false)
      const pt = String(input.probeType);
      if (pt === "answer") {
        return JSON.stringify({
          verdict: "pass", score: 90, behaviorOk: true, hallucinated: false,
          stance: 2, matchedKeyPoints: [0, 1], forbiddenHits: [], hallucinationHits: [], failureSignalHits: [], style: 2,
          rationale: "裸答已答对",
        });
      }
      if (pt === "correct_premise") {
        return JSON.stringify({
          verdict: "partial", score: 65, behaviorOk: true, hallucinated: false,
          stance: 1, matchedKeyPoints: [0], forbiddenHits: [], hallucinationHits: [], failureSignalHits: [], style: 1,
          rationale: "部分纠正",
        });
      }
      return JSON.stringify({
        verdict: "fail", score: 25, behaviorOk: false, hallucinated: false,
        stance: 0, matchedKeyPoints: [], forbiddenHits: [0], hallucinationHits: [], failureSignalHits: [0], style: 1,
        rationale: "未满足预期行为",
      });
    };

    const res1 = await makeEvalSuiteWorkflow({
      evalDbPath: evalDb,
      mainDbPath: mainDb,
      suiteName: "eval-v1",
      maxProbesPerVideo: 6,
      maxEasyRatio: 0.2,
      concurrency: 1,
      callMaxAttempts: 1,
      modelId: "build-model",
      bareModel: "bare-model",
      graderModel: "grader-model",
      runRole: fakeRoleRunner,
      runBareModel: fakeBare,
      runGrader: fakeGrader,
      exportPath: join(dir, "eval-v1.jsonl"),
      manifestOutPath: join(dir, "eval-v1.manifest.json"),
    });

    assert.equal("skipped" in res1.build, false);
    if (!("skipped" in res1.build)) {
      assert.equal(res1.build.probesCreated, 6);
      assert.equal(res1.build.accepted, 5);
      assert.equal(res1.build.rejected, 1);
      for (const t of PROBE_TYPES) assert.equal(res1.build.byType[t], 1);
    }

    // Verify adversary turn was NOT sent to probe_critic (7 critic calls total: 6 initial + 1 after revise)
    const criticCount = roleCalls.filter((r) => r === "probe_critic").length;
    assert.equal(criticCount, 7);
    assert.equal(roleCalls.filter((r) => r === "adversary").length, 1);

    assert.equal("skipped" in res1.calibrate, false);
    if (!("skipped" in res1.calibrate)) {
      assert.equal(res1.calibrate.calibrated, 5);
      assert.deepEqual(res1.calibrate.byDifficulty, { easy: 1, medium: 1, hard: 3 });
    }

    // 1 easy out of 5 = 20% <= maxEasyRatio 0.2 -> all 5 included!
    assert.equal("skipped" in res1.freeze, false);
    if (!("skipped" in res1.freeze)) {
      assert.equal(res1.freeze.created, true);
      assert.equal(res1.freeze.itemCount, 5);
      assert.equal(res1.freeze.turnCount, 6); // 4 single-turn + 1 two-turn hold_position
      assert.equal(res1.freeze.easyRatio, 0.2);
    }

    // Check expectedBehaviorForTurn helper & stored turns
    assert.equal(expectedBehaviorForTurn("hold_position", 1), "answer");
    assert.equal(expectedBehaviorForTurn("hold_position", 2), "hold_position");
    assert.equal(expectedBehaviorForTurn("refuse", 1), "refuse");

    // Second `eval make` run is completely resumable & idempotent (0 new LLM calls!)
    const callsBefore = roleCalls.length;
    const res2 = await makeEvalSuiteWorkflow({
      evalDbPath: evalDb,
      mainDbPath: mainDb,
      suiteName: "eval-v1",
      runRole: fakeRoleRunner,
      runBareModel: fakeBare,
      runGrader: fakeGrader,
    });
    assert.equal(roleCalls.length, callsBefore);
    assert.equal("skipped" in res2.build && res2.build.skipped, true);
    assert.equal("skipped" in res2.calibrate && res2.calibrate.skipped, true);
    assert.equal("skipped" in res2.freeze, false);
    if (!("skipped" in res2.freeze)) {
      assert.equal(res2.freeze.created, false);
    }

    // Freeze guards: active run guard & max-easy-ratio=0 exclusion
    const store = new EvalStore(evalDb);
    try {
      const strictFreeze = await freezeEvalSuite({
        evalStore: store,
        name: "eval-no-easy",
        maxEasyRatio: 0,
        mainDbPath: mainDb,
      });
      assert.equal(strictFreeze.itemCount, 4);
      assert.equal(strictFreeze.excludedEasyProbeIds.length, 1);

      const activeRunId = store.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
      await assert.rejects(
        freezeEvalSuite({ evalStore: store, name: "eval-blocked", mainDbPath: mainDb }),
        /存在正在运行中的任务/,
      );
      store.finishRun(activeRunId, "completed");
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
