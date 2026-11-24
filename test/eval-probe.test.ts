import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EvalStore } from "../src/eval/eval-db.js";
import { loadEvalPromptBundle } from "../src/eval/eval-prompts.js";
import { runProbeBuild } from "../src/eval/probe-loop.js";
import { parseProbeMix, planProbeSlots, summarizePlan } from "../src/eval/probe-planner.js";
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
import type { RoleRunner } from "../src/types.js";

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

test("probe-planner produces balanced deterministic slot allocation and locks expectedBehavior", () => {
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
  assert.deepEqual(summary.byType, {
    wild_short: 16,
    premise_trap: 16,
    contrast: 12,
    transfer: 12,
    hallucination_bait: 12,
    pressure: 12,
  });

  // Every single video gets all 6 probe types represented; pressure gets 2-3 turns and unique tactics
  let twoTurnPressure = 0;
  let threeTurnPressure = 0;
  for (const slots of plan.values()) {
    assert.equal(slots.length, 8);
    const typesInVideo = new Set(slots.map((s) => s.probeType));
    assert.equal(typesInVideo.size, 6);
    for (const s of slots) {
      if (s.probeType === "premise_trap") assert.equal(s.expectedBehavior, "correct_premise");
      else if (s.probeType === "hallucination_bait") assert.equal(s.expectedBehavior, "acknowledge_gap");
      else assert.equal(s.expectedBehavior, "answer");

      if (s.probeType === "pressure") {
        assert.ok(s.targetTurns === 2 || s.targetTurns === 3);
        assert.equal(s.tactics.length, s.targetTurns - 1);
        assert.equal(new Set(s.tactics).size, s.tactics.length);
        if (s.targetTurns === 2) twoTurnPressure++;
        else threeTurnPressure++;
      } else {
        assert.equal(s.targetTurns, 1);
        assert.equal(s.tactics.length, 0);
      }
    }
  }
  assert.equal(twoTurnPressure, 8);
  assert.equal(threeTurnPressure, 4);

  const parsed = parseProbeMix("wild_short=30,premise_trap=30,hallucination_bait=40");
  assert.equal(parsed.wild_short, 30);
  assert.equal(parsed.contrast, 0);
  assert.throws(() => parseProbeMix("unknown=50"), /未知题型/);
});

test("probe-schema validates anchors, n-gram duplicates, critic/verifier reviews, and rubric v2 contracts", () => {
  const material = "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者。";
  assert.equal(verifyAnchorInMaterial("教师的薪俸来源决定了他们的时间和立身根本受制于对立面", material), true);
  assert.equal(verifyAnchorInMaterial("教师的薪俸来源，决定了他们的时间和立身根本受制于对立面！", material), true);
  assert.equal(verifyAnchorInMaterial("知识分子因为性格软弱所以不能参加任何社会运动", material), false);

  assert.ok(charNgramJaccard("大学老师能搞革命吗？", "大学老师到底能搞革命吗？") >= 0.6);
  assert.ok(charNgramJaccard("大学老师能搞革命吗？", "普列汉诺夫哪一年回国任教？") < 0.2);
  const dup = findNearDuplicate("大学老师能搞革命吗？", ["大学老师到底能搞革命吗？"]);
  assert.ok(dup && dup.similarity >= 0.6);

  const drafts = parseDraftProbes(JSON.stringify({
    probes: [
      { slotIndex: 2, question: "Q2", anchor: "A2", trap: "T2" },
      { slotIndex: 1, question: "Q1", anchor: "A1", trap: "T1" },
    ],
  }), [1, 2]);
  assert.deepEqual(drafts.map((d) => d.slotIndex), [1, 2]);
  assert.throws(() => parseDraftProbes(JSON.stringify({ probes: [{ slotIndex: 1, question: "Q1", anchor: "A1", trap: "T1" }] }), [1, 2]), /缺少槽位/);

  const revised = parseRevisedProbe(JSON.stringify({ slotIndex: 2, question: "Q2b", anchor: "A2", trap: "T2" }), 2);
  assert.equal(revised.question, "Q2b");

  assert.equal(parseCriticReview(JSON.stringify({ decision: "accept", issues: [], feedback: "" })).decision, "accept");
  assert.throws(() => parseCriticReview(JSON.stringify({ decision: "accept", issues: ["x"], feedback: "" })), /必须为空数组/);
  assert.throws(() => parseCriticReview(JSON.stringify({ decision: "revise", issues: ["x"], feedback: "" })), /非空 feedback/);
  assert.equal(parseVerifierReview(JSON.stringify({ decision: "pass", issues: [], feedback: "" })).decision, "pass");
  assert.throws(() => parseVerifierReview(JSON.stringify({ decision: "drop", issues: [], feedback: "" })), /放弃原因/);

  // acknowledge_gap allows empty keyPoints, requires >=1 mustNotHallucinate
  const gapRubric = parseProbeRubric(JSON.stringify({
    expectedBehavior: "acknowledge_gap",
    stance: "坦承未展开具体年份",
    keyPoints: [],
    forbidden: ["编造具体回国年份"],
    mustNotHallucinate: ["不得编造普列汉诺夫具体回国年份"],
    failureSignals: ["直接给出具体年份数字"],
  }), "acknowledge_gap", "hallucination_bait");
  assert.equal(gapRubric.keyPoints.length, 0);

  // missing mustNotHallucinate for hallucination_bait fails
  assert.throws(() => parseProbeRubric(JSON.stringify({
    expectedBehavior: "acknowledge_gap",
    stance: "坦承未展开",
    keyPoints: [],
    forbidden: [],
    mustNotHallucinate: [],
    failureSignals: ["瞎编年份"],
  }), "acknowledge_gap", "hallucination_bait"), /rubric\.mustNotHallucinate/);

  // mismatched expectedBehavior fails
  assert.throws(() => parseProbeRubric(JSON.stringify({
    expectedBehavior: "answer",
    stance: "纠偏",
    keyPoints: ["k1"],
    forbidden: [],
    mustNotHallucinate: [],
    failureSignals: ["顺从错误前提"],
  }), "correct_premise", "premise_trap"), /与代码锁定值不一致/);
});

test("runProbeBuild executes full M1 state machine (dedup, critic revise/reject, verifier revise/drop, rubric-v2, immutability)", async () => {
  const bundle = await loadEvalPromptBundle();
  const evalStore = new EvalStore(":memory:");
  try {
    const materialText = [
      "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者。",
      "职业行动者不是靠热情或道德觉悟，而是靠一套独立于体制之外的组织供养机制。",
      "这和今天社交媒体上所谓的网红大V完全不是一回事，大V依赖流量平台分账。",
      "这套结构判断同样可以用来观察现代大厂里高度依赖期权与绩效的从业者。",
      "至于普列汉诺夫早年的具体教学经历，我这里没有展开讲过。",
    ].join("\n");

    const { record } = evalStore.insertSourceMaterial({
      videoId: "BV_MOCK_1",
      videoKey: "BV_MOCK_1",
      partCount: 1,
      content: materialText,
      splitSnapshot: "test",
    });

    const observedFirstKeys: Array<{ role: string; firstKey: string; hasTrap: boolean }> = [];
    const criticRoundsBySlot = new Map<number, number>();
    const verifyAttemptsBySlot = new Map<number, number>();

    const mockRunner: RoleRunner = async ({ role, input }) => {
      const firstKey = Object.keys(input)[0] ?? "";
      observedFirstKeys.push({ role, firstKey, hasTrap: "trap" in input });

      if (role === "probe_writer" && input.mode === "draft") {
        // 6 slots planned with custom mix:
        // slot 1: wild_short -> accept -> pass -> accepted
        // slot 2: premise_trap -> revise -> accept -> verifier revise -> pass -> accepted
        // slot 3: hallucination_bait -> accept -> pass (first-person "这个我没展开") -> accepted
        // slot 4: contrast -> critic reject
        // slot 5: transfer -> critic accept -> verifier drop
        // slot 6: wild_short (near duplicate of slot 1) -> deterministic n-gram reject!
        const slots = input.slots as Array<{ slotIndex: number; probeType: string }>;
        return JSON.stringify({
          probes: slots.map((s) => {
            if (s.slotIndex === 1) {
              return {
                slotIndex: 1,
                question: "大学老师能当职业革命者吗？",
                anchor: "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者",
                trap: "通用模型会笼统说知识分子有觉悟所以可以",
              };
            }
            if (s.slotIndex === 2) {
              return {
                slotIndex: 2,
                question: "为什么薪俸来源决定教师软弱？",
                anchor: "编造的一句不存在的锚点",
                trap: "顺着题干说软弱",
              };
            }
            if (s.slotIndex === 3) {
              return {
                slotIndex: 3,
                question: "普列汉诺夫具体哪一年在哪所学校当过老师？",
                anchor: "至于普列汉诺夫早年的具体教学经历，我这里没有展开讲过",
                trap: "通用模型会顺嘴编造具体年份与学校名",
              };
            }
            if (s.slotIndex === 4) {
              return {
                slotIndex: 4,
                question: "职业行动者跟网红大V是一回事吗？",
                anchor: "这和今天社交媒体上所谓的网红大V完全不是一回事，大V依赖流量平台分账",
                trap: "把两者混为一谈",
              };
            }
            if (s.slotIndex === 5) {
              return {
                slotIndex: 5,
                question: "拿期权的大厂程序员算不算能进这支队伍？",
                anchor: "这套结构判断同样可以用来观察现代大厂里高度依赖期权与绩效的从业者",
                trap: "用职场鸡汤泛泛作答",
              };
            }
            return {
              slotIndex: s.slotIndex,
              question: "大学老师到底能当职业革命者吗？",
              anchor: "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者",
              trap: "重复题",
            };
          }),
        });
      }

      if (role === "probe_writer" && input.mode === "revise") {
        const slot = input.slot as { slotIndex: number };
        return JSON.stringify({
          slotIndex: slot.slotIndex,
          question: "教师不能当职业革命者，说到底是因为知识分子天生软弱吧？",
          anchor: "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者",
          trap: "通用模型容易顺着题干附和知识分子软弱，而未先推翻错误前提",
        });
      }

      if (role === "probe_critic") {
        const q = String(input.question);
        if (q.includes("网红大V")) {
          return JSON.stringify({ decision: "reject", issues: ["测试拒绝分支"], feedback: "故意触发 reject" });
        }
        if (q.includes("为什么薪俸来源")) {
          assert.equal(input.anchorVerified, false);
          criticRoundsBySlot.set(2, (criticRoundsBySlot.get(2) ?? 0) + 1);
          return JSON.stringify({
            decision: "revise",
            issues: ["泄漏答案且锚点未命中"],
            feedback: "请改为不含答案的错误前提问法，并摘录原稿原句。",
          });
        }
        if (q.includes("天生软弱")) {
          assert.equal(input.anchorVerified, true);
          return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
        }
        return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
      }

      if (role === "reference") {
        const q = String(input.question);
        if (q.includes("普列汉诺夫")) {
          return "这个我没展开，普列汉诺夫早年具体哪一年在哪所学校任教我这里没细讲过，也没法替你编。";
        }
        if (q.includes("天生软弱")) {
          if (!input.previousAnswer) {
            return "知识分子确实有点软弱，另外薪俸也有影响。";
          }
          return "不是因为知识分子软弱，这个前提本身就错了。关键在于教师的薪俸来源让他的时间和立身根本受制于对立面，缺乏独立供养机制。";
        }
        return "不能。决定这一点的不是个人觉悟，而是教师的薪俸来源让时间和立身根本都受制于对立面。";
      }

      if (role === "verifier") {
        const q = String(input.question);
        if (q.includes("大厂程序员")) {
          return JSON.stringify({ decision: "drop", issues: ["测试 drop 分支"], feedback: "故意触发 drop" });
        }
        if (q.includes("天生软弱")) {
          const count = (verifyAttemptsBySlot.get(2) ?? 0) + 1;
          verifyAttemptsBySlot.set(2, count);
          if (count === 1) {
            return JSON.stringify({
              decision: "revise",
              issues: ["开头附和了错误前提"],
              feedback: "请首句直接推翻'软弱'这一错误前提，改为讲清薪俸来源的结构制约。",
            });
          }
        }
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
          stance: "教师无法充当职业革命者的根本原因是薪俸结构而非个人软弱",
          keyPoints: ["薪俸来源决定时间与立身根本受制于对立面"],
          forbidden: ["归结为知识分子软弱"],
          mustNotHallucinate: ["不得编造具体教师薪资数字"],
          failureSignals: ["开头附和软弱前提或回避直接判断"],
        });
      }

      throw new Error(`Unexpected role: ${role}`);
    };

    const summary = await runProbeBuild({
      evalStore,
      sources: [record],
      prompts: bundle.prompts,
      skills: bundle.skills,
      runRole: mockRunner,
      modelId: "mock-model",
      probesPerVideo: 6,
      mix: { wild_short: 34, premise_trap: 17, hallucination_bait: 17, contrast: 16, transfer: 16, pressure: 0 },
      concurrency: 3,
      callMaxAttempts: 1,
      callRetryDelayMs: 0,
    });

    assert.equal(summary.plannedSlots, 6);
    assert.equal(summary.draftedProbes, 6);
    assert.equal(summary.duplicateRejected, 1);
    assert.equal(summary.criticEvaluated, 5);
    assert.equal(summary.criticAccepted, 4);
    assert.equal(summary.verifierEvaluated, 4);
    assert.equal(summary.verifierPassed, 3);
    assert.equal(summary.accepted, 3);
    assert.equal(summary.statusCounts.rejected, 2); // 1 n-gram dup + 1 critic reject
    assert.equal(summary.statusCounts.dropped, 1);  // 1 verifier drop
    assert.equal(summary.errors, 0);
    assert.ok(summary.totalAgentCalls >= 15);

    // Every material-bearing call puts `material` first for prefix caching;
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

test("eval-cli supports --help, init, and status offline without API keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-cli-"));
  try {
    const evalDb = join(dir, "eval.sqlite");
    const helpRes = await execFileAsync(process.execPath, [TSX_CLI, join(ROOT, "src/eval-cli.ts"), "--help"]);
    assert.match(helpRes.stdout, /独立评测库与对抗测试集生产 CLI/);

    const initRes = await execFileAsync(process.execPath, [
      TSX_CLI, join(ROOT, "src/eval-cli.ts"), "init", "--eval-db", evalDb,
    ]);
    const initJson = JSON.parse(initRes.stdout) as { action: string; schemaVersion: string };
    assert.equal(initJson.action, "init");
    assert.equal(initJson.schemaVersion, "1");

    const statusRes = await execFileAsync(process.execPath, [
      TSX_CLI, join(ROOT, "src/eval-cli.ts"), "status", "--eval-db", evalDb,
    ]);
    const statusJson = JSON.parse(statusRes.stdout) as { sourceMaterials: number };
    assert.equal(statusJson.sourceMaterials, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
