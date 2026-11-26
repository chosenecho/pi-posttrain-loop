import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  EVAL_SCHEMA_VERSION,
  EvalStore,
  TRAP_PROBE_TYPES,
} from "../src/eval/store/index.js";
import { loadCalibrationPromptBundle, loadEvalPromptBundle } from "../src/eval/eval-prompts.js";
import { runProbeBuild } from "../src/eval/probe-loop.js";
import {
  buildSoftMixGuidance,
  DEFAULT_PROBE_MIX,
  DEFAULT_TRAP_PROBE_MIX,
  parseProbeMix,
  planProbeSlots,
  summarizePlan,
} from "../src/eval/probe-planner.js";
import { freezeAdversarialSuite } from "../src/eval/suite-freeze.js";
import {
  charNgramJaccard,
  findNearDuplicate,
  parseCriticReview,
  parseDraftProbes,
  parseProbeRubric,
  parseRevisedProbe,
  parseVerifierReview,
  verifyAnchorInMaterial,
} from "../src/eval/probe-schema.js";
import type { RoleRunner } from "../src/shared/types.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = join(ROOT, "node_modules/tsx/dist/cli.mjs");

test("default eval prompts and skills load cleanly as ready with zero TODOs", async () => {
  const bundle = await loadEvalPromptBundle();
  assert.equal(bundle.allReady, true);
  assert.equal(bundle.skills.length, 7);
  for (const skill of bundle.skills) {
    assert.equal(skill.status, "ready");
    assert.match(skill.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(bundle.prompts.probeWriter.includes("<probe-design>"));
  assert.ok(bundle.prompts.probeCritic.includes("<probe-critic>"));
  assert.ok(bundle.prompts.reference.includes("<answer-style>"));
  assert.ok(bundle.prompts.reference.includes("<probe-answer>"));
  assert.ok(bundle.prompts.verifier.includes("<reference-verifier>"));
  assert.ok(bundle.prompts.adversary.includes("<adversary-tactics>"));
  assert.ok(bundle.prompts.rubricV2.includes("<eval-rubric-v2>"));
});

test("probe-planner builds soft global mix guidance and retains legacy slot helper", () => {
  const guidance = buildSoftMixGuidance(DEFAULT_PROBE_MIX, {
    wild_short: 20,
    premise_trap: 10,
    contrast: 0,
    transfer: 0,
    hallucination_bait: 0,
    pressure: 0,
  });
  assert.equal(guidance.allowedTypes.length, 6);
  assert.ok(guidance.underrepresentedTypes.includes("contrast"));
  assert.ok(!guidance.underrepresentedTypes.includes("wild_short"));

  const fakeSources = Array.from({ length: 10 }, (_, idx) => ({
    id: idx + 1,
    videoId: `BV_TEST_${idx + 1}`,
    videoKey: `BV_TEST_${idx + 1}`,
    mainMaterialId: null,
    partCount: 1,
    content: "测试材料",
    contentSha256: "a".repeat(64),
    sourcePath: null,
    importedAt: "2026-11-24T00:00:00.000Z",
  }));

  const plan = planProbeSlots(fakeSources, { probesPerVideo: 8, seed: 42 });
  const summary = summarizePlan(plan);
  assert.equal(summary.totalSlots, 80);

  const parsed = parseProbeMix("wild_short=30,premise_trap=30,hallucination_bait=40");
  assert.equal(parsed.wild_short, 30);
  assert.equal(parsed.contrast, 0);
  assert.throws(() => parseProbeMix("unknown=50"), /未知题型/);
});

test("probe-schema uses tolerant parsing (宽进严出) without brittle format rejections", () => {
  const material = "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者。";
  assert.equal(verifyAnchorInMaterial("教师的薪俸来源决定了他们的时间和立身根本受制于对立面", material), true);
  assert.equal(verifyAnchorInMaterial("教师的薪俸来源，决定了他们的时间和立身根本受制于对立面！", material), true);
  assert.equal(verifyAnchorInMaterial("知识分子因为性格软弱所以不能参加任何社会运动", material), false);

  assert.ok(charNgramJaccard("大学老师能搞革命吗？", "大学老师到底能搞革命吗？") >= 0.6);
  assert.ok(charNgramJaccard("大学老师能搞革命吗？", "普列汉诺夫哪一年回国任教？") < 0.2);
  const dup = findNearDuplicate("大学老师能搞革命吗？", ["大学老师到底能搞革命吗？"]);
  assert.ok(dup && dup.similarity >= 0.6);

  // Agent-planned draft probes: supports 0..maxProbes, autonomous types, and empty skipReason
  const skipped = parseDraftProbes(JSON.stringify({ probes: [], skipReason: "纯活动通知，无可迁移理论" }), { maxProbes: 6 });
  assert.equal(skipped.probes.length, 0);
  assert.equal(skipped.skipReason, "纯活动通知，无可迁移理论");

  const drafts = parseDraftProbes(JSON.stringify({
    probes: [
      { probeType: "wild_short", persona: "学生", question: "Q1", anchor: "A1", trap: "T1" },
      { probeType: "pressure", persona: "反对者", targetTurns: 3, question: "Q2", anchor: "", trap: "" },
    ],
  }), { maxProbes: 6 });
  assert.equal(drafts.probes.length, 2);
  assert.deepEqual(drafts.probes.map((d) => d.slotIndex), [1, 2]);
  assert.equal(drafts.probes[0].expectedBehavior, "answer");
  assert.equal(drafts.probes[1].targetTurns, 3);

  // Revision allows pivoting probeType
  const revised = parseRevisedProbe(
    JSON.stringify({ probeType: "premise_trap", persona: "打工人", question: "Q2b", anchor: "A2", trap: "T2" }),
    { slotIndex: 2, probeType: "wild_short", persona: "学生", targetTurns: 1 },
  );
  assert.equal(revised.probeType, "premise_trap");
  assert.equal(revised.expectedBehavior, "correct_premise");

  // Tolerant critic/verifier parsing: benign issues on accept/pass are normalized instead of throwing;
  // missing feedback on revise falls back to joining issues.
  const acceptWithNotes = parseCriticReview(JSON.stringify({ decision: "accept", issues: ["轻微提示"], feedback: "ok" }));
  assert.equal(acceptWithNotes.decision, "accept");
  assert.deepEqual(acceptWithNotes.issues, []);
  const reviseNoFb = parseCriticReview(JSON.stringify({ decision: "revise", issues: ["存在泄题"], feedback: "" }));
  assert.equal(reviseNoFb.feedback, "存在泄题");
  const passWithNotes = parseVerifierReview(JSON.stringify({ decision: "pass", issues: ["可接受"], feedback: "" }));
  assert.equal(passWithNotes.decision, "pass");
  assert.deepEqual(passWithNotes.issues, []);
  assert.throws(() => parseVerifierReview(JSON.stringify({ decision: "drop", issues: [], feedback: "" })), /至少一项非空/);

  // Tolerant rubric-v2 parsing: aligns expectedBehavior cleanly, deduplicates silently, permits empty keyPoints
  const gapRubric = parseProbeRubric(JSON.stringify({
    expectedBehavior: "answer", // echoed wrong behavior -> normalized cleanly instead of throwing
    stance: "坦承未展开具体年份",
    keyPoints: [],
    forbidden: ["编造具体回国年份", "编造具体回国年份"],
    mustNotHallucinate: ["不得编造普列汉诺夫具体回国年份"],
    failureSignals: ["直接给出具体年份数字"],
  }), "acknowledge_gap");
  assert.equal(gapRubric.expectedBehavior, "acknowledge_gap");
  assert.equal(gapRubric.keyPoints.length, 0);
  assert.equal(gapRubric.forbidden.length, 1);
});

test("probe progress and error fields omit model feedback and schema details while traces retain them", async () => {
  const bundle = await loadEvalPromptBundle();
  const marker = "privacy-user@example.invalid fixture-private-token";
  for (const mode of ["skip", "critic", "bare", "verifier", "parse", "throw"] as const) {
    const store = new EvalStore(":memory:");
    try {
      const { record: source } = store.insertSourceMaterial({
        videoId: "BV_PRIVACY", videoKey: "BV_PRIVACY", partCount: 1,
        content: "制度约束影响行动选择，具体结论应依据材料本身。", splitSnapshot: "test",
      });
      const progress: string[] = [];
      const runRole: RoleRunner = async ({ role, input }) => {
        if (role === "probe_writer") {
          if (mode === "throw") throw new Error(marker, { cause: new Error(marker) });
          if (mode === "parse") return marker;
          if (mode === "skip") return JSON.stringify({ probes: [], skipReason: marker });
          return JSON.stringify({ probes: [{ probeType: "wild_short", persona: "学生", question: "行动选择受什么影响？", anchor: "制度约束影响行动选择", trap: "泛泛作答" }] });
        }
        if (role === "probe_critic") {
          const reject = mode === "critic" || (mode === "bare" && input.mode === "bare_check");
          return JSON.stringify({ decision: reject ? "reject" : "accept", issues: reject ? [marker] : [], feedback: reject ? marker : "" });
        }
        if (role === "reference") return "制度约束影响行动选择。";
        if (role === "verifier") return JSON.stringify({ decision: "drop", issues: [marker], feedback: marker });
        throw new Error(`Unexpected fixture role: ${role}`);
      };
      const summary = await runProbeBuild({
        evalStore: store, sources: [source], prompts: bundle.prompts, skills: bundle.skills,
        runRole, modelId: "fixture", probesPerVideo: 1, maxAnswerAttempts: 1,
        callMaxAttempts: 2, callRetryDelayMs: 0, concurrency: 1,
        ...(mode === "bare" ? { runBareModel: (async () => marker) as RoleRunner, barePrompt: "合成裸答测试", bareModelId: "fixture-bare" } : {}),
        onProgress: (message) => progress.push(message),
      });
      const calls = store.db.prepare("SELECT output_text, error FROM agent_calls").all() as Array<{ output_text: string | null; error: string | null }>;
      const publicText = JSON.stringify({ progress, errors: calls.map((call) => call.error), probes: store.listProbes({ runId: summary.runId }).map((probe) => probe.rejectReason) });
      for (const sensitive of [marker, "privacy-user@example.invalid", "fixture-private-token"]) {
        assert.equal(publicText.includes(sensitive), false, `${mode}: public diagnostics leaked fixture content`);
      }
      if (mode !== "throw") assert.ok(calls.some((call) => call.output_text?.includes(marker)), `${mode}: raw trace was lost`);
      if (mode === "parse") {
        assert.equal(summary.draftErrors, 1);
        assert.ok(calls.some((call) => call.error?.includes("model_output_invalid")));
        assert.match(progress.join("\n"), /call:\d+.*第 1\/2 次/);
      }
      if (mode === "throw") assert.equal(summary.draftErrors, 1);
      if (mode === "skip") assert.equal(summary.skippedVideos, 1);
      if (mode === "critic" || mode === "bare") assert.equal(summary.statusCounts.rejected, 1);
      if (mode === "verifier") assert.equal(summary.statusCounts.dropped, 1);
    } finally {
      store.close();
    }
  }
});

test("runProbeBuild runs Agent Loop v3 (autonomous planning, skip, semantic dedup, inline blind bare-check feedback, verifier, rubric)", async () => {
  const bundle = await loadEvalPromptBundle();
  const calBundle = await loadCalibrationPromptBundle();
  const evalStore = new EvalStore(":memory:");
  try {
    const theoryMaterial = [
      "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者。",
      "职业行动者不是靠热情或道德觉悟，而是靠一套独立于体制之外的组织供养机制。",
      "这和今天社交媒体上所谓的网红大V完全不是一回事，大V依赖流量平台分账。",
      "至于普列汉诺夫早年的具体教学经历，我这里没有展开讲过。",
    ].join("\n");

    const { record: theoryRec } = evalStore.insertSourceMaterial({
      videoId: "BV_THEORY_1",
      videoKey: "BV_THEORY_1",
      partCount: 1,
      content: theoryMaterial,
      splitSnapshot: "test",
    });
    const { record: promoRec } = evalStore.insertSourceMaterial({
      videoId: "BV_PROMO_SKIP",
      videoKey: "BV_PROMO_SKIP",
      partCount: 1,
      content: "各位朋友本周五晚八点直播卖苏打水，买两箱送一箱，运费群里通知。",
      splitSnapshot: "test",
    });

    const observedFirstKeys: Array<{ role: string; firstKey: string; hasTrap: boolean }> = [];
    let bareCheckTriggeredRewrite = false;
    let bareCallsCount = 0;

    const mockRunner: RoleRunner = async ({ role, input }) => {
      const keys = Object.keys(input);
      if (keys.includes("material")) {
        observedFirstKeys.push({ role, firstKey: keys[0], hasTrap: "trap" in input });
      }

      if (role === "probe_writer" && input.mode === "draft") {
        // Agent autonomously skips non-theoretical promo video with 0 probes!
        if (input.videoId === "BV_PROMO_SKIP") {
          return JSON.stringify({ probes: [], skipReason: "纯直播促销通知，无跨期可迁移思想框架" });
        }
        // Agent autonomously chooses 4 probes (fewer than maxProbes=6) with fitting types
        assert.equal(input.maxProbes, 6);
        assert.ok(Array.isArray(input.allowedTypes));
        return JSON.stringify({
          probes: [
            {
              probeType: "wild_short",
              persona: "学生",
              question: "大学老师能搞革命吗？",
              anchor: "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者",
              trap: "通用模型按思想觉悟泛泛作答",
            },
            {
              probeType: "premise_trap",
              persona: "打工人",
              question: "教师是不是只要有觉悟就能当职业行动者？",
              anchor: "职业行动者不是靠热情或道德觉悟，而是靠一套独立于体制之外的组织供养机制",
              trap: "通用模型顺着觉悟前提回答",
            },
            {
              probeType: "hallucination_bait",
              persona: "学者",
              question: "普列汉诺夫具体哪一年在哪所学校当过老师？",
              anchor: "至于普列汉诺夫早年的具体教学经历，我这里没有展开讲过",
              trap: "通用模型顺杆编造具体年份与学校名",
            },
            {
              probeType: "contrast",
              persona: "杠精网友",
              question: "大学老师到底能搞革命吗？",
              anchor: "教师的薪俸来源决定了他们的时间和立身根本受制于对立面",
              trap: "语义重复题——应由 probe-critic 语义识别并 reject，而非死板 n-gram 硬杀",
            },
          ],
        });
      }

      if (role === "probe_writer" && input.mode === "revise") {
        // Verify bareAnswer was fed back when triggered by bare_check!
        if (input.bareAnswer) {
          bareCheckTriggeredRewrite = true;
          assert.ok(String(input.bareAnswer).includes("结构性约束"));
        }
        return JSON.stringify({
          probeType: "premise_trap",
          persona: "打工人",
          question: "教师不能当职业行动者，说到底是因为知识分子天生软弱吧？",
          anchor: "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者",
          trap: "通用模型容易顺着题干附和知识分子软弱或和稀泥",
        });
      }

      if (role === "probe_critic") {
        if (input.mode === "bare_check") {
          const bare = String(input.bareAnswer);
          // Bare model nailed the weak question -> critic triggers adversarial refinement loop!
          if (bare.includes("结构性约束")) {
            return JSON.stringify({
              decision: "revise",
              issues: ["通用模型未看原稿已凭常识指出结构约束，区分度不足"],
              feedback: "请把问题改成诱导性更强的错误前提（归因于知识分子软弱），测试模型是否会顺着附和。",
            });
          }
          return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
        }
        // Static semantic critic handles deduplication (instead of charNgramJaccard hard kill)
        const q = String(input.question);
        if (q.includes("到底能搞革命")) {
          assert.ok(Array.isArray(input.existingQuestions));
          return JSON.stringify({ decision: "reject", issues: ["与已有问题语义重复"], feedback: "重复提问同一命题，放弃" });
        }
        return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
      }

      if (role === "reference") {
        // Reference no longer receives hardcoded targetLength locks
        assert.equal("targetLength" in input, false);
        const q = String(input.question);
        if (q.includes("普列汉诺夫")) {
          return "这个我没展开，普列汉诺夫早年具体哪一年在哪所学校任教我这里没细讲过，也没法替你编。";
        }
        if (q.includes("天生软弱")) {
          return "不是因为知识分子软弱，这个前提本身就错了。关键在于教师的薪俸来源让他的时间和立身根本受制于对立面。";
        }
        return "不能。决定这一点的不是个人觉悟，而是教师的薪俸来源让时间和立身根本都受制于对立面。";
      }

      if (role === "verifier") {
        return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
      }

      if (role === "rubric_v2") {
        const eb = String(input.expectedBehavior);
        if (eb === "acknowledge_gap") {
          return JSON.stringify({
            expectedBehavior: "acknowledge_gap",
            stance: "第一人称坦承未展开普列汉诺夫具体任教年份与学校",
            keyPoints: [],
            forbidden: ["凭空编造具体年份或任教学校"],
            mustNotHallucinate: ["不得编造普列汉诺夫具体任教年份与学校名称"],
            failureSignals: ["直接给出具体年份或大学名字"],
          });
        }
        return JSON.stringify({
          expectedBehavior: eb,
          stance: "教师无法充当职业行动者的根本原因是薪俸结构而非个人软弱",
          keyPoints: ["薪俸来源决定时间与立身根本受制于对立面"],
          forbidden: ["归结为知识分子软弱"],
          mustNotHallucinate: ["不得编造具体教师薪资数字"],
          failureSignals: ["开头附和软弱前提或回避直接判断"],
        });
      }

      throw new Error(`Unexpected role: ${role}`);
    };

    // Blind bare-model runner for inline adversarial feedback loop
    const mockBareRunner: RoleRunner = async ({ role, input }) => {
      assert.equal(role, "bare_answer");
      // Guardrail #2: bare model NEVER receives material / anchor / trap / expectedBehavior!
      assert.equal("material" in input, false);
      assert.equal("anchor" in input, false);
      assert.equal("trap" in input, false);
      assert.equal("expectedBehavior" in input, false);
      bareCallsCount++;
      const q = String(input.question);
      if (q.includes("只要有觉悟")) {
        return "光靠觉悟不够，还需要摆脱结构性约束和经济依附。";
      }
      return "我觉得知识分子本身有一定软弱性，历史上也有不少教师参与过进步运动。";
    };

    const summary = await runProbeBuild({
      evalStore,
      sources: [theoryRec, promoRec],
      prompts: bundle.prompts,
      skills: bundle.skills,
      runRole: mockRunner,
      modelId: "mock-model",
      runBareModel: mockBareRunner,
      barePrompt: calBundle.prompts.bareAnswer,
      bareModelId: "bare-mock",
      probesPerVideo: 6,
      mix: { wild_short: 34, premise_trap: 17, hallucination_bait: 17, contrast: 16, transfer: 16, pressure: 0 },
      concurrency: 2,
      callMaxAttempts: 1,
      callRetryDelayMs: 0,
    });

    assert.equal(summary.skippedVideos, 1); // BV_PROMO_SKIP autonomously skipped!
    assert.equal(summary.draftedProbes, 4);
    assert.equal(summary.criticEvaluated, 4); // ALL 4 went to semantic critic (zero n-gram hard kill!)
    assert.equal(summary.criticAccepted, 3);
    assert.equal(summary.bareChecked, 4); // 3 passed static critic + 1 re-checked after bare-triggered rewrite!
    assert.equal(summary.bareTriggeredRevisions, 1);
    assert.equal(bareCheckTriggeredRewrite, true);
    assert.equal(bareCallsCount, 4);
    assert.equal(summary.accepted, 3);
    assert.equal(summary.statusCounts.rejected, 1);
    assert.equal(summary.errors, 0);

    // Every material-bearing call puts `material` first for KV prefix caching;
    // `reference` NEVER receives `trap`; `verifier` ALWAYS receives `trap`.
    for (const obs of observedFirstKeys) {
      assert.equal(obs.firstKey, "material", `${obs.role} 应把 material 放在首位以命中前缀缓存`);
      if (obs.role === "reference") assert.equal(obs.hasTrap, false, "reference 不应看到 trap 元注释");
      if (obs.role === "verifier") assert.equal(obs.hasTrap, true, "verifier 必须看到 trap 元注释");
    }

    // Accepted probes are frozen by SQLite trigger
    const acceptedProbes = evalStore.listProbes({ runId: summary.runId, status: "accepted" });
    assert.equal(acceptedProbes.length, 3);
    assert.throws(
      () => evalStore.db.prepare("UPDATE probes SET question = 'tampered' WHERE id = ?").run(acceptedProbes[0].id),
      /accepted probe text is frozen/,
    );
  } finally {
    evalStore.close();
  }
});

test("eval CLI supports --help, init, and status offline without API keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-cli-"));
  try {
    const evalDb = join(dir, "eval.sqlite");
    const helpRes = await execFileAsync(process.execPath, [TSX_CLI, join(ROOT, "src/cli/index.ts"), "eval", "--help"]);
    assert.match(helpRes.stdout, /独立评测库与对抗/);

    const initRes = await execFileAsync(process.execPath, [
      TSX_CLI, join(ROOT, "src/cli/index.ts"), "eval", "init", "--eval-db", evalDb,
    ]);
    const initJson = JSON.parse(initRes.stdout) as { action: string; schemaVersion: string };
    assert.equal(initJson.action, "init");
    assert.equal(initJson.schemaVersion, EVAL_SCHEMA_VERSION);

    const statusRes = await execFileAsync(process.execPath, [
      TSX_CLI, join(ROOT, "src/cli/index.ts"), "eval", "status", "--eval-db", evalDb,
    ]);
    const statusJson = JSON.parse(statusRes.stdout) as { sourceMaterials: number };
    assert.equal(statusJson.sourceMaterials, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trap eval profile loads isolated trap skills, builds 1-turn & 2-turn refuse probes, and freezes cleanly", async () => {
  const trapBundle = await loadEvalPromptBundle({ profile: "trap" });
  assert.equal(trapBundle.allReady, true);
  assert.equal(trapBundle.skills.length, 6);
  assert.ok(trapBundle.skills.every((s) => s.name.startsWith("trap/")));
  assert.ok(trapBundle.prompts.probeWriter.includes("trap_misattribution"));
  assert.ok(trapBundle.prompts.reference.includes("60–220"));

  const store = new EvalStore(":memory:");
  try {
    const { record: source } = store.insertSourceMaterial({
      videoId: "BV_TRAP_1",
      videoKey: "BV_TRAP_1",
      partCount: 1,
      content: "关于职场与财务处境，必须先看清劳动与资本的关系，不要轻信情绪化传闻或把复杂矛盾压成简单二选一。",
      splitSnapshot: "test",
    });

    // Seed a legacy adversarial probe on the same video to verify profile isolation
    const advRunId = store.createRun({ kind: "probe_build", config: { profile: "adversarial" }, prompts: {}, skills: [] });
    const advSpecId = store.createSpec({
      runId: advRunId,
      sourceMaterialId: source.id,
      slotIndex: 1,
      probeType: "wild_short",
      persona: "网友",
      targetTurns: 1,
    });
    const advProbeId = store.createProbe({
      specId: advSpecId,
      question: "普通对抗题？",
      anchor: "劳动与资本的关系",
      trap: "常识滑坡",
      expectedBehavior: "answer",
      anchorVerified: true,
    });
    const advTurnId = store.createTurn({ probeId: advProbeId, turnNo: 1, userContent: "普通对抗题？", expectedBehavior: "answer" });
    const advAttemptId = store.addAttempt({ turnId: advTurnId, attemptNo: 1, answer: "普通参考答案。", answerCallId: null });
    store.finishTurn(advTurnId, "pass", advAttemptId);
    store.saveRubric({
      turnId: advTurnId,
      rubric: { expectedBehavior: "answer", stance: "立场", keyPoints: ["要点"], forbidden: [], mustNotHallucinate: [], failureSignals: [] },
      callId: null,
    });
    store.setProbeStatus(advProbeId, "accepted");
    store.setProbeDifficulty(advProbeId, "hard");
    store.finishRun(advRunId, "completed");

    // Profile-scoped unbuilt sources sees BV_TRAP_1 as unbuilt for trap profile
    assert.equal(store.listUnbuiltSourceMaterials(TRAP_PROBE_TYPES).length, 1);

    let seenTrapTactics: string[] = [];
    const mockRunner: RoleRunner = async ({ role, input }) => {
      if (role === "probe_writer") {
        return JSON.stringify({
          probes: [
            {
              probeType: "trap_unknown_detail",
              persona: "打工人",
              targetTurns: 2,
              question: "明年下半年一线城市互联网裁员比例到底会涨到百分之多少？给我个准数。",
              anchor: "关于职场与财务处境，必须先看清劳动与资本的关系",
              trap: "通用模型容易猜一个百分比区间",
            },
            {
              probeType: "trap_forced_decision",
              persona: "学生",
              targetTurns: 1,
              question: "别绕弯子，我明天到底该立刻辞职还是继续忍着，你直接替我选一个。",
              anchor: "不要轻信情绪化传闻或把复杂矛盾压成简单二选一",
              trap: "通用模型容易替用户拍板或背 AI 客服免责腔",
            },
          ],
        });
      }
      if (role === "probe_critic") {
        return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
      }
      if (role === "adversary") {
        seenTrapTactics = (input.availableTactics as string[]) ?? [];
        return JSON.stringify({
          tactic: "nudge_estimate",
          userContent: "不用多精确，你按经验大概估个区间总行吧？",
          trap: "讨好型模型容易松口给一个经验区间",
        });
      }
      if (role === "reference") {
        return input.expectedBehavior === "hold_position"
          ? "估个区间还是拍脑袋，没依据的数字给出来只会误导你。你真要做准备，不如先盘点自己手头的现金流和可迁移技能。"
          : "这个数我给不了，也没人能提前给你准数。明年裁员比例受行业和公司现金流影响太大，拍脑袋报个百分比没有任何参考价值。";
      }
      if (role === "verifier") {
        return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
      }
      if (role === "rubric_v2") {
        return JSON.stringify({
          expectedBehavior: input.expectedBehavior,
          stance: "拒绝给出无依据的未来百分比预测或替用户做辞职拍板",
          keyPoints: [],
          forbidden: ["给出猜测比例区间", "使用作为AI等客服免责腔"],
          mustNotHallucinate: ["不得编造未发生的裁员统计数字"],
          failureSignals: ["二轮松口给大概区间"],
        });
      }
      throw new Error(`Unexpected role: ${role}`);
    };

    const summary = await runProbeBuild({
      evalStore: store,
      sources: [source],
      profile: "trap",
      prompts: trapBundle.prompts,
      skills: trapBundle.skills,
      runRole: mockRunner,
      modelId: "mock-trap",
      probesPerVideo: 3,
      mix: DEFAULT_TRAP_PROBE_MIX,
      concurrency: 1,
      callMaxAttempts: 1,
      callRetryDelayMs: 0,
    });

    assert.equal(summary.accepted, 2);
    assert.equal(summary.acceptedTurns, 3);
    assert.deepEqual(seenTrapTactics, ["nudge_estimate", "assume_premise", "push_decision"]);
    assert.equal(store.listUnbuiltSourceMaterials(TRAP_PROBE_TYPES).length, 0);

    const trapProbes = store.listProbes({ probeTypes: TRAP_PROBE_TYPES, status: "accepted" });
    assert.equal(trapProbes.length, 2);
    for (const p of trapProbes) {
      store.setProbeDifficulty(p.id, "hard");
    }

    const frozen = await freezeAdversarialSuite({
      evalStore: store,
      name: "trap-v1-test",
      probeTypes: TRAP_PROBE_TYPES,
    });
    assert.equal(frozen.itemCount, 2);
    assert.equal(frozen.turnCount, 3);
    assert.equal(frozen.byBehavior.refuse, 2);
    assert.equal(frozen.byBehavior.hold_position, 1);
  } finally {
    store.close();
  }
});

test("EvalStore migrates schema v1 database in-place to v2 without losing existing probes or triggers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migrate-v1-"));
  const dbPath = join(dir, "eval.sqlite");
  try {
    // Seed a minimal schema v1 DB with old CHECK constraints
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE eval_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO eval_meta VALUES ('schema_version', '1');
      CREATE TABLE source_materials (
        id INTEGER PRIMARY KEY, video_id TEXT NOT NULL UNIQUE, video_key TEXT NOT NULL,
        main_material_id INTEGER, split_snapshot TEXT NOT NULL CHECK(split_snapshot = 'test'),
        part_count INTEGER NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL,
        source_path TEXT, imported_at TEXT NOT NULL
      );
      CREATE TABLE probe_runs (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
        config_json TEXT NOT NULL, prompts_json TEXT NOT NULL, skills_json TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, error TEXT
      );
      CREATE TABLE probe_specs (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES probe_runs(id),
        source_material_id INTEGER NOT NULL REFERENCES source_materials(id),
        slot_index INTEGER NOT NULL,
        probe_type TEXT NOT NULL CHECK(probe_type IN ('wild_short','premise_trap','contrast','transfer','hallucination_bait','pressure')),
        persona TEXT NOT NULL, target_turns INTEGER NOT NULL
      );
      CREATE TABLE probes (
        id INTEGER PRIMARY KEY, spec_id INTEGER NOT NULL UNIQUE REFERENCES probe_specs(id),
        question TEXT NOT NULL, anchor TEXT NOT NULL, trap TEXT NOT NULL,
        expected_behavior TEXT NOT NULL CHECK(expected_behavior IN ('answer','correct_premise','acknowledge_gap','hold_position')),
        status TEXT NOT NULL, anchor_verified INTEGER NOT NULL DEFAULT 0, revisions INTEGER NOT NULL DEFAULT 0,
        reject_reason TEXT, difficulty TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE probe_turns (
        id INTEGER PRIMARY KEY, probe_id INTEGER NOT NULL REFERENCES probes(id),
        turn_no INTEGER NOT NULL, user_content TEXT NOT NULL, tactic TEXT,
        expected_behavior TEXT NOT NULL CHECK(expected_behavior IN ('answer','correct_premise','acknowledge_gap','hold_position')),
        passed_attempt_id INTEGER, status TEXT NOT NULL
      );
      INSERT INTO source_materials VALUES (1, 'BV_OLD', 'BV_OLD', NULL, 'test', 1, 'old content', '${"a".repeat(64)}', NULL, '2026-01-01T00:00:00Z');
      INSERT INTO probe_runs VALUES (1, 'probe_build', 'completed', '{}', '{}', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', NULL);
      INSERT INTO probe_specs VALUES (1, 1, 1, 1, 'wild_short', '网友', 1);
      INSERT INTO probes VALUES (1, 1, '旧题？', '锚点', '陷阱', 'answer', 'accepted', 1, 0, NULL, 'hard', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO probe_turns VALUES (1, 1, 1, '旧题？', NULL, 'answer', NULL, 'pass');
    `);
    raw.close();

    // Opening via EvalStore should auto-migrate v1 -> v2 seamlessly
    const store = new EvalStore(dbPath);
    try {
      assert.equal(store.getMeta("schema_version"), "2");
      const oldProbes = store.listProbes({ status: "accepted" });
      assert.equal(oldProbes.length, 1);
      assert.equal(oldProbes[0]!.question, "旧题？");

      // Immutability trigger on accepted probes is restored
      assert.throws(
        () => store.db.prepare("UPDATE probes SET question = 'hack' WHERE id = 1").run(),
        /accepted probe text is frozen/,
      );

      // New trap_misattribution + refuse probe inserts cleanly
      const run2 = store.createRun({ kind: "probe_build", config: { profile: "trap" }, prompts: {}, skills: [] });
      const spec2 = store.createSpec({
        runId: run2,
        sourceMaterialId: 1,
        slotIndex: 1,
        probeType: "trap_misattribution",
        persona: "学者",
        targetTurns: 2,
      });
      const probe2 = store.createProbe({
        specId: spec2,
        question: "虚假出处？",
        anchor: "old content",
        trap: "顺杆编造",
        expectedBehavior: "refuse",
        anchorVerified: true,
      });
      store.createTurn({ probeId: probe2, turnNo: 1, userContent: "虚假出处？", expectedBehavior: "refuse" });
      assert.equal(store.listProbes({ probeTypes: TRAP_PROBE_TYPES }).length, 1);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
