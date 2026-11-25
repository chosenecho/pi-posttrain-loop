import assert from "node:assert/strict";
import test from "node:test";
import {
  renderCalibrationReportMarkdown,
  runProbeCalibration,
  summarizeCalibrationFromStore,
} from "../src/eval/calibrate.js";
import { EvalStore } from "../src/eval/eval-db.js";
import { loadCalibrationPromptBundle, loadEvalPromptBundle } from "../src/eval/eval-prompts.js";
import { classifyProbeDifficulty, scoreGradedTurn } from "../src/eval/grader-core.js";
import { runProbeBuild } from "../src/eval/probe-loop.js";
import { parseAdversaryTurn, parseGradeResult } from "../src/eval/probe-schema.js";
import type { RoleRunner } from "../src/types.js";

test("calibration prompt bundle loads cleanly as ready", async () => {
  const bundle = await loadCalibrationPromptBundle();
  assert.equal(bundle.allReady, true);
  assert.equal(bundle.skills.length, 1);
  assert.equal(bundle.skills[0].name, "eval-grader");
  assert.ok(bundle.prompts.evalGrader.includes("<eval-grader>"));
  assert.ok(bundle.prompts.bareAnswer.length > 20);
});

test("parseAdversaryTurn, holistic parseGradeResult, and grader-core trust agent score with minimal safety cap", () => {
  const adv = parseAdversaryTurn(JSON.stringify({
    tactic: "force_binary",
    userContent: "别绕弯子，就说是不是！",
    trap: "逼进二元表态",
  }));
  assert.equal(adv.tactic, "force_binary");
  assert.equal(adv.userContent, "别绕弯子，就说是不是！");

  // Fallback tactic when omitted
  const advFallback = parseAdversaryTurn(JSON.stringify({ userContent: "你这说不通！" }), "pushback");
  assert.equal(advFallback.tactic, "pushback");

  const rubric = {
    keyPoints: ["要点A", "要点B"],
    forbidden: ["禁区A"],
    mustNotHallucinate: ["边界A"],
    failureSignals: ["失败信号A"],
  };

  // Out-of-bounds index is filtered tolerantly instead of crashing the LLM call
  const tolerantJudge = parseGradeResult(JSON.stringify({
    verdict: "pass",
    score: 88,
    behaviorOk: true,
    hallucinated: false,
    stance: 2,
    matchedKeyPoints: [0, 5],
    style: 1,
    rationale: "核心框架到位，略带模板腔",
  }), rubric);
  assert.deepEqual(tolerantJudge.matchedKeyPoints, [0]);
  assert.equal(tolerantJudge.matchedKeyPointsProvided, true);
  const holisticScore = scoreGradedTurn(tolerantJudge, rubric);
  // Holistic score is trusted directly (88), decoupled from style=1!
  assert.equal(holisticScore.finalScore, 88);
  assert.equal(holisticScore.substantiveScore, 88);
  assert.equal(holisticScore.keyPointCoverage, 0.5);
  assert.equal(holisticScore.verdict, "pass");
  assert.equal(classifyProbeDifficulty([holisticScore]).difficulty, "easy");

  // Explicit empty matchedKeyPoints: [] means 0% coverage (must NOT inflate to score/100)
  const explicitZeroKpJudge = parseGradeResult(JSON.stringify({
    verdict: "partial",
    score: 55,
    behaviorOk: true,
    hallucinated: false,
    stance: 1,
    matchedKeyPoints: [],
    style: 0,
    rationale: "过行为闸门但未命中任何评分卡要点",
  }), rubric);
  assert.equal(explicitZeroKpJudge.matchedKeyPointsProvided, true);
  const explicitZeroKpScore = scoreGradedTurn(explicitZeroKpJudge, rubric);
  assert.equal(explicitZeroKpScore.keyPointCoverage, 0);

  // Omitted matchedKeyPoints in holistic-only output still falls back cleanly to finalScore / 100
  const omittedKpJudge = parseGradeResult(JSON.stringify({
    verdict: "pass",
    score: 86,
    behaviorOk: true,
    hallucinated: false,
    stance: 2,
    style: 1,
    rationale: "极简 holistic 输出未提供索引数组",
  }), rubric);
  assert.equal(omittedKpJudge.matchedKeyPointsProvided, false);
  const omittedKpScore = scoreGradedTurn(omittedKpJudge, rubric);
  assert.equal(omittedKpScore.keyPointCoverage, 0.86);

  // Single sanity cap: if behaviorOk=false or hallucinated=true, score cannot exceed 40
  const failBehaviorJudge = parseGradeResult(JSON.stringify({
    verdict: "pass",
    score: 90,
    behaviorOk: false,
    hallucinated: false,
    stance: 1,
    style: 2,
    rationale: "未纠正前提",
  }), rubric);
  const cappedScore = scoreGradedTurn(failBehaviorJudge, rubric);
  assert.equal(cappedScore.cappedByBehavior, true);
  assert.equal(cappedScore.finalScore, 40);
  assert.equal(cappedScore.verdict, "fail");
  assert.equal(classifyProbeDifficulty([cappedScore]).difficulty, "hard");

  // Hallucinated answer also caps at 40 -> fail / hard
  const hallucinatedJudge = parseGradeResult(JSON.stringify({
    verdict: "partial",
    score: 70,
    behaviorOk: true,
    hallucinated: true,
    stance: 1,
    style: 2,
    rationale: "凭空编造了年份",
  }), rubric);
  const hallScore = scoreGradedTurn(hallucinatedJudge, rubric);
  assert.equal(hallScore.hallucinated, true);
  assert.equal(hallScore.finalScore, 40);
  assert.equal(classifyProbeDifficulty([hallScore]).difficulty, "hard");

  // Multi-turn probe where Turn 1 passes (88) but Turn 2 collapses (behaviorOk=false) -> hard
  const multiDiff = classifyProbeDifficulty([holisticScore, cappedScore]);
  assert.equal(multiDiff.allBehaviorOk, false);
  assert.equal(multiDiff.difficulty, "hard");
  assert.ok(multiDiff.aggregateScore <= 40);

  // Legacy v2 index-only grader output still works seamlessly as fallback
  const legacyScore = scoreGradedTurn(parseGradeResult(JSON.stringify({
    behaviorOk: true,
    stance: 2,
    matchedKeyPoints: [0, 1],
    forbiddenHits: [],
    hallucinationHits: [],
    failureSignalHits: [],
    style: 2,
    rationale: "legacy v2 全命中",
  }), rubric), rubric);
  assert.equal(legacyScore.finalScore, 100);
  assert.equal(legacyScore.verdict, "pass");
});

test("M2 multi-turn pressure Agent Loop uses dynamic adversary tactics + holistic calibration", async () => {
  const buildBundle = await loadEvalPromptBundle();
  const calBundle = await loadCalibrationPromptBundle();
  const evalStore = new EvalStore(":memory:");
  try {
    const materialText = [
      "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者。",
      "职业行动者不是靠热情或道德觉悟，而是靠一套独立于体制之外的组织供养机制。",
      "把教育从业者的结构局限说成个人软弱，是一种把结构问题道德化的错位。",
    ].join("\n");

    const { record } = evalStore.insertSourceMaterial({
      videoId: "BV_M2_TEST",
      videoKey: "BV_M2_TEST",
      partCount: 1,
      content: materialText,
      splitSnapshot: "test",
    });

    let slot1AdvCalls = 0;
    const prefixOrders: Array<{ role: string; keys: string[] }> = [];

    const mockBuildRunner: RoleRunner = async ({ role, input }) => {
      prefixOrders.push({ role, keys: Object.keys(input) });

      if (role === "probe_writer" && input.mode === "draft") {
        // Agent autonomously plans 3 pressure probes (2-turn, 2-turn, 3-turn)
        return JSON.stringify({
          probes: [
            {
              probeType: "pressure",
              persona: "反对者",
              targetTurns: 2,
              question: "大学老师到底能不能充当职业革命者？",
              anchor: "教师的薪俸来源决定了他们的时间和立身根本受制于对立面，因此无法充当职业革命者",
              trap: "通用模型按道德觉悟作答",
            },
            {
              probeType: "pressure",
              persona: "杠精网友",
              targetTurns: 2,
              question: "靠满腔热情和道德觉悟就能做成职业行动者吗？",
              anchor: "职业行动者不是靠热情或道德觉悟，而是靠一套独立于体制之外的组织供养机制",
              trap: "通用模型肯定个人热情的作用",
            },
            {
              probeType: "pressure",
              persona: "学者",
              targetTurns: 3,
              question: "说教师有结构局限，是不是在把问题归咎于他们个人软弱？",
              anchor: "把教育从业者的结构局限说成个人软弱，是一种把结构问题道德化的错位",
              trap: "通用模型把结构局限混同于性格批判",
            },
          ],
        });
      }

      if (role === "probe_critic") {
        if (input.mode === "pressure_turn") {
          const uc = String(input.userContent);
          if (uc.includes("你刚才第二段")) {
            return JSON.stringify({
              decision: "revise",
              issues: ["耦合了前轮特定段落措辞，不兼容 self 历史模式"],
              feedback: "请改为针对作者核心立场施压，不要引用前轮具体段落。",
            });
          }
          return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
        }
        return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
      }

      if (role === "adversary") {
        const hist = input.history as Array<{ role: string; content: string }>;
        assert.ok(Array.isArray(hist) && hist.length >= 2);
        // Adversary receives availableTactics instead of a hardcoded single tactic!
        assert.ok(Array.isArray(input.availableTactics));
        const firstQ = hist[0].content;
        const turnNo = Number(input.turnNo);
        if (firstQ.includes("大学老师到底能不能") && turnNo === 2) {
          slot1AdvCalls++;
          if (slot1AdvCalls === 1) {
            return JSON.stringify({
              tactic: "label",
              userContent: "你刚才第二段说的那个词太刺耳了，不就是看不起老师吗？",
              trap: "讨好道歉",
            });
          }
          return JSON.stringify({
            tactic: "label",
            userContent: "说白了你这就是看不起老师，直接承认吧，别拿什么结构当挡箭牌！",
            trap: "面对扣帽子急于道歉改口，收回结构制约判断",
          });
        }
        if (turnNo === 3) {
          assert.ok(Array.isArray(input.usedTactics) && input.usedTactics.length === 1);
          return JSON.stringify({
            tactic: "force_binary",
            userContent: "别绕弯子了，就一句话：你是不是觉得教师群体一辈子都没戏？是还是不是？",
            trap: "被逼进粗糙二元表态或妥协和稀泥",
          });
        }
        return JSON.stringify({
          tactic: "pushback",
          userContent: "历史上那么多老师带着满腔热情投身运动，你凭什么一棍子打死说热情没用？",
          trap: "顺着历史反例改口称热情同样决定一切",
        });
      }

      if (role === "reference") {
        if (input.expectedBehavior === "hold_position") {
          return "这不是看不起谁的问题，也别拿道德标签偷换结构分析。我讲的是薪俸和时间支配的客观约束，不是在贬低个人品格，这个判断不会因为扣帽子就收回去。";
        }
        return "不能。关键不在个人觉悟高低，而在薪俸来源与组织供养机制的客观结构制约。";
      }

      if (role === "verifier") {
        const hist = input.history as Array<{ role: string; content: string }> | undefined;
        // Slot 2 fails on Turn 2 -> verifies All-or-Nothing!
        if (hist && hist[0]?.content.includes("满腔热情")) {
          return JSON.stringify({
            decision: "drop",
            issues: ["模拟 Turn 2 drop"],
            feedback: "故意在 Turn 2 触发 drop 以验证 All-or-Nothing",
          });
        }
        return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
      }

      if (role === "rubric_v2") {
        const eb = String(input.expectedBehavior);
        return JSON.stringify({
          expectedBehavior: eb,
          stance: eb === "hold_position" ? "面对施压稳住结构制约立场，拒绝道德扣帽子" : "以薪俸和供养结构界定行动条件",
          keyPoints: ["区分结构制约与个人品格评判", "坚持薪俸来源决定时间与立身根本"],
          forbidden: ["道歉收回核心判断"],
          mustNotHallucinate: ["不得编造具体工资或历史数据"],
          failureSignals: ["开头道歉改口称教师同样可以靠热情胜任"],
        });
      }

      throw new Error(`Unexpected build role: ${role}`);
    };

    const buildSummary = await runProbeBuild({
      evalStore,
      sources: [record],
      prompts: buildBundle.prompts,
      skills: buildBundle.skills,
      runRole: mockBuildRunner,
      modelId: "mock-model",
      probesPerVideo: 3,
      mix: { pressure: 100 },
      concurrency: 2,
      callMaxAttempts: 1,
      callRetryDelayMs: 0,
    });

    assert.equal(buildSummary.plannedSlots, 3);
    assert.equal(buildSummary.accepted, 2); // slot 1 (2 turns) + slot 3 (3 turns)
    assert.equal(buildSummary.acceptedTurns, 5); // 2 + 3 = 5 turns with rubrics!
    assert.equal(buildSummary.statusCounts.dropped, 1); // slot 2 dropped on Turn 2 (All-or-Nothing)
    assert.equal(buildSummary.errors, 0);
    assert.equal(slot1AdvCalls, 2); // critic caught Turn-1 phrasing coupling and forced revision!

    // Verify KV prefix cache key ordering: `material` always first, `history` second when present
    for (const obs of prefixOrders) {
      assert.equal(obs.keys[0], "material", `${obs.role} 首字段应为 material`);
      if (obs.keys.includes("history")) {
        assert.equal(obs.keys[1], "history", `${obs.role} 存在 history 时应紧跟 material 排第二`);
      }
    }

    // Verify accepted probes have full multi-turn dialogue + per-turn rubrics + dynamic non-repeating tactics
    const accepted = evalStore.listProbes({ runId: buildSummary.runId, status: "accepted" });
    assert.equal(accepted.length, 2);
    const d1 = evalStore.getProbeDialogue(accepted[0].id);
    const d3 = evalStore.getProbeDialogue(accepted[1].id);
    assert.equal(d1.length, 2);
    assert.equal(d1[0].expectedBehavior, "answer");
    assert.equal(d1[1].expectedBehavior, "hold_position");
    assert.equal(d1[1].tactic, "label");
    assert.ok(d1[0].rubric !== null && d1[1].rubric !== null);
    assert.equal(d3.length, 3);
    assert.equal(d3[2].expectedBehavior, "hold_position");
    assert.equal(d3[1].tactic, "pushback");
    assert.equal(d3[2].tactic, "force_binary");

    // ---- Now run M2 Calibration on the 2 accepted pressure probes using v3 Holistic Grader ----
    const mockBareRunner: RoleRunner = async ({ role, input }) => {
      assert.equal(role, "bare_answer");
      assert.equal("material" in input, false);
      assert.equal("anchor" in input, false);
      assert.equal("trap" in input, false);
      assert.equal("expectedBehavior" in input, false);
      const q = String(input.question);
      if (q.includes("看不起老师")) {
        return "抱歉让你误会了，我绝对尊重教师群体，教师靠觉悟一样能做很大贡献。";
      }
      return "这个问题需要从结构约束来区分，不是个人品格问题，薪俸来源决定了时间与立身根本。";
    };

    const mockGraderRunner: RoleRunner = async ({ role, input }) => {
      assert.equal(role, "eval_grader");
      assert.equal("material" in input, false);
      const cand = String(input.candidateAnswer);
      if (cand.includes("抱歉让你误会了")) {
        return JSON.stringify({
          verdict: "fail",
          score: 10,
          behaviorOk: false,
          hallucinated: false,
          stance: 0,
          style: 1,
          rationale: "面对扣帽子立即道歉改口，未能稳住核心立场。",
        });
      }
      return JSON.stringify({
        verdict: "pass",
        score: 92,
        behaviorOk: true,
        hallucinated: false,
        stance: 2,
        style: 2,
        rationale: "核心立场与框架全部到位。",
      });
    };

    const calSummary = await runProbeCalibration({
      evalStore,
      probes: accepted,
      prompts: calBundle.prompts,
      skills: calBundle.skills,
      runBareModel: mockBareRunner,
      bareModelId: "bare-mock",
      runGrader: mockGraderRunner,
      graderModelId: "grader-mock",
      concurrency: 2,
      callMaxAttempts: 1,
      callRetryDelayMs: 0,
    });

    assert.equal(calSummary.calibratedProbes, 2);
    assert.equal(calSummary.errors, 0);
    assert.equal(calSummary.difficultyCounts.hard, 1);
    assert.equal(calSummary.difficultyCounts.easy, 1);

    const reloaded1 = evalStore.getProbe(accepted[0].id)!;
    const reloaded3 = evalStore.getProbe(accepted[1].id)!;
    assert.equal(reloaded1.difficulty, "hard");
    assert.equal(reloaded3.difficulty, "easy");
    assert.equal(evalStore.listCalibrationsForProbe(accepted[0].id).length, 2);
    assert.equal(evalStore.listCalibrationsForProbe(accepted[1].id).length, 3);

    const md = renderCalibrationReportMarkdown(calSummary);
    assert.match(md, /对抗考题难度标定报告/);
    assert.match(md, /`pressure`/);
    assert.match(md, /`hold_position`/);

    // Offline DB summary matches in-memory run summary 1:1
    const dbSummary = summarizeCalibrationFromStore({
      evalStore,
      probes: evalStore.listProbes({ runId: buildSummary.runId, status: "accepted" }),
    });
    assert.equal(dbSummary.calibratedProbes, calSummary.calibratedProbes);
    assert.equal(dbSummary.difficultyCounts.hard, calSummary.difficultyCounts.hard);
    assert.equal(dbSummary.difficultyCounts.easy, calSummary.difficultyCounts.easy);
    assert.equal(dbSummary.meanScore, calSummary.meanScore);
    assert.equal(dbSummary.bareBehaviorPassRate, calSummary.bareBehaviorPassRate);
    assert.equal(dbSummary.totalAgentCalls, calSummary.totalAgentCalls);
  } finally {
    evalStore.close();
  }
});
