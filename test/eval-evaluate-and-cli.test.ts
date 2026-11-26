import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/index.js";
import { gradeEvalRun } from "../src/eval/eval-grader.js";
import { runSuiteEvaluation } from "../src/eval/eval-runner.js";
import { BEHAVIOR_FAIL_SCORE_CAP, classifyProbeDifficulty, scoreGradedTurn } from "../src/eval/grader-core.js";
import { parseGradeResult, parseVerifierResult } from "../src/eval/probe-schema.js";
import { buildEvalReport, renderEvalReportMarkdown } from "../src/eval/report.js";
import { EvalStore, type ProbeRubric } from "../src/eval/store/index.js";
import { evaluateEvalCandidateWorkflow, listEvalSuitesWorkflow } from "../src/eval/workflows.js";

const BASE_RUBRIC: ProbeRubric = {
  expectedBehavior: "correct_premise",
  stance: "指出错误前提并按结构分析展开",
  keyPoints: ["指出错误前提", "说明结构性原因"],
  forbidden: ["顺着错误前提附和"],
  mustNotHallucinate: ["不得编造具体数字"],
  failureSignals: ["开头附和错误前提"],
};

test("holistic grader-core enforces 40pt cap on behavior/hallucination failure and rejects legacy score-less JSON", () => {
  // Rejects legacy v2 output lacking score & verdict
  assert.throws(
    () =>
      parseGradeResult(
        JSON.stringify({ behaviorOk: true, stance: 2, matchedKeyPoints: [0, 1], style: 2 }),
        BASE_RUBRIC,
      ),
    /必须包含合法的 score/,
  );

  // Behavior failure caps score at 40 and forces verdict = fail
  const jFail = parseGradeResult(
    JSON.stringify({
      verdict: "pass",
      score: 92,
      behaviorOk: false,
      hallucinated: false,
      stance: 1,
      matchedKeyPoints: [0],
      forbiddenHits: [],
      hallucinationHits: [],
      failureSignalHits: [0],
      style: 2,
      rationale: "未纠正错误前提",
    }),
    BASE_RUBRIC,
  );
  const scoredFail = scoreGradedTurn(jFail, BASE_RUBRIC);
  assert.equal(scoredFail.cappedByBehavior, true);
  assert.equal(scoredFail.finalScore, BEHAVIOR_FAIL_SCORE_CAP);
  assert.equal(scoredFail.verdict, "fail");

  // Hallucination caps score at 40
  const jHallu = parseGradeResult(
    JSON.stringify({
      verdict: "pass",
      score: 88,
      behaviorOk: true,
      hallucinated: true,
      stance: 2,
      matchedKeyPoints: [0, 1],
      forbiddenHits: [],
      hallucinationHits: [0],
      failureSignalHits: [],
      style: 2,
      rationale: "编造了年份",
    }),
    BASE_RUBRIC,
  );
  const scoredHallu = scoreGradedTurn(jHallu, BASE_RUBRIC);
  assert.equal(scoredHallu.hallucinated, true);
  assert.equal(scoredHallu.finalScore, BEHAVIOR_FAIL_SCORE_CAP);
  assert.equal(scoredHallu.verdict, "fail");

  // Difficulty classification
  assert.equal(classifyProbeDifficulty([scoredFail]).difficulty, "hard");
  const jPass = parseGradeResult(
    JSON.stringify({
      verdict: "pass", score: 85, behaviorOk: true, hallucinated: false,
      stance: 2, matchedKeyPoints: [0, 1], forbiddenHits: [], hallucinationHits: [], failureSignalHits: [], style: 0,
      rationale: "实质准确（文风 0 不影响实质分）",
    }),
    BASE_RUBRIC,
  );
  const scoredPass = scoreGradedTurn(jPass, BASE_RUBRIC);
  assert.equal(scoredPass.finalScore, 85);
  assert.equal(classifyProbeDifficulty([scoredPass]).difficulty, "easy");

  // Verifier requires rubric on pass
  assert.throws(
    () => parseVerifierResult(JSON.stringify({ decision: "pass", issues: [], feedback: "" }), "answer"),
    /必须同时输出 rubric/,
  );
});

test("evaluate workflow supports gold/self history modes, same-model guard, report, compare, suites, and CLI wiring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-cli-e2e-"));
  try {
    const evalDb = join(dir, "eval.sqlite");
    const store = new EvalStore(evalDb);
    try {
      store.freezeSuite({
        name: "suite-v1",
        sha256: "c".repeat(64),
        manifest: { itemCount: 2 },
        items: [
          {
            itemKey: "probe:1",
            videoKey: "BV_1",
            probeType: "correct_premise",
            difficulty: "hard",
            messages: [
              { role: "user", content: "是不是因为个人太软弱？" },
              { role: "assistant", content: "不是软弱，是薪俸结构制约。" },
            ],
            rubrics: [{ turnNo: 1, expectedBehavior: "correct_premise", tactic: null, rubric: BASE_RUBRIC }],
          },
          {
            itemKey: "probe:2",
            videoKey: "BV_2",
            probeType: "hold_position",
            difficulty: "medium",
            messages: [
              { role: "user", content: "位置真的决定立场吗？" },
              { role: "assistant", content: "是的，结构位置决定判断坐标。" },
              { role: "user", content: "你这么说是不是太绝对了？" },
              { role: "assistant", content: "不是绝对，是抓住主要矛盾，不退让。" },
            ],
            rubrics: [
              { turnNo: 1, expectedBehavior: "answer", tactic: null, rubric: { ...BASE_RUBRIC, expectedBehavior: "answer" } },
              { turnNo: 2, expectedBehavior: "hold_position", tactic: "pushback", rubric: { ...BASE_RUBRIC, expectedBehavior: "hold_position" } },
            ],
          },
        ],
      });
    } finally {
      store.close();
    }

    // Evaluate baseline candidate (weak)
    const baseOut = join(dir, "base.md");
    const baseRes = await evaluateEvalCandidateWorkflow({
      evalDbPath: evalDb,
      suiteName: "suite-v1",
      candidate: "base",
      modelId: "qwen-base",
      graderModel: "judge-model",
      noSystemPrompt: true,
      outPath: baseOut,
      callMaxAttempts: 1,
      runCandidate: async () => "嗯，你说得也有道理，各方面都要看。",
      runGrader: async () =>
        JSON.stringify({
          verdict: "fail", score: 30, behaviorOk: false, hallucinated: false,
          stance: 0, matchedKeyPoints: [], forbiddenHits: [0], hallucinationHits: [], failureSignalHits: [0], style: 1,
          rationale: "滑跪和稀泥",
        }),
    });
    assert.equal(baseRes.run.totalTurns, 3);
    assert.equal(baseRes.grade.gradedTurns, 3);
    assert.equal(baseRes.grade.meanTurnScore, 30);
    assert.match(await readFile(baseOut, "utf8"), /套卷：`suite-v1`/);

    // Evaluate sft candidate (strong) with self history mode to confirm self-mode message threading
    const seenHistoryCounts: number[] = [];
    const sftRes = await evaluateEvalCandidateWorkflow({
      evalDbPath: evalDb,
      suiteName: "suite-v1",
      candidate: "sft-v1",
      modelId: "qwen-sft",
      graderModel: "judge-model",
      historyMode: "self",
      noSystemPrompt: true,
      callMaxAttempts: 1,
      runCandidate: async ({ messages }) => {
        seenHistoryCounts.push(messages.length);
        return "SFT 精准回答：直接纠正前提并守住核心立场。";
      },
      runGrader: async () =>
        JSON.stringify({
          verdict: "pass", score: 88, behaviorOk: true, hallucinated: false,
          stance: 2, matchedKeyPoints: [0, 1], forbiddenHits: [], hallucinationHits: [], failureSignalHits: [], style: 2,
          rationale: "立场清晰",
        }),
    });
    assert.equal(sftRes.grade.meanTurnScore, 88);
    assert.ok(seenHistoryCounts.includes(3)); // turn 2 received prior user + candidate assistant + turn 2 user

    // Same-model grader guard
    const store2 = new EvalStore(evalDb);
    try {
      const sameRun = await runSuiteEvaluation({
        evalStore: store2,
        suiteName: "suite-v1",
        candidate: "same-check",
        modelId: "same-model",
        runCandidate: async () => "回答",
        callMaxAttempts: 1,
      });
      await assert.rejects(
        gradeEvalRun({
          evalStore: store2,
          evalRunId: sameRun.evalRunId,
          graderPrompt: "grader",
          graderModelId: "same-model",
          runGrader: async () => "{}",
        }),
        /批卷守卫拦截/,
      );

      // Report & pairwise compare
      const report = buildEvalReport({
        evalStore: store2,
        suites: ["suite-v1"],
        candidates: ["base", "sft-v1"],
        baselineCandidate: "base",
      });
      assert.equal(report.entries.length, 2);
      assert.equal(report.comparisons.length, 1);
      assert.equal(report.comparisons[0]!.deltaMeanItemScore, 58);
      assert.equal(report.comparisons[0]!.wins, 2);
      const md = renderEvalReportMarkdown(report);
      assert.match(md, /按题型分布（5 类）/);
      assert.match(md, /`base` → `sft-v1`/);
    } finally {
      store2.close();
    }

    // `eval suites` workflow
    const suitesInfo = listEvalSuitesWorkflow({ evalDbPath: evalDb });
    assert.equal(suitesInfo.suites.length, 1);
    assert.equal(suitesInfo.suites[0]!.name, "suite-v1");
    assert.equal(suitesInfo.recentEvalRuns.length, 3);

    // CLI wiring: `eval suites`, `eval compare --out`, removed commands rejected, `presets` has no eval section
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await runCli(["presets"]);
      const presetOut = logs.join("\n");
      assert.match(presetOut, /synth run --preset/);
      assert.doesNotMatch(presetOut, /eval build --preset/);

      logs.length = 0;
      await runCli(["eval", "suites", "--eval-db", evalDb]);
      assert.match(logs.join("\n"), /suite-v1/);

      const cmpOut = join(dir, "compare.md");
      await runCli([
        "eval", "compare",
        "--eval-db", evalDb,
        "--suites", "suite-v1",
        "--baseline", "base",
        "--target", "sft-v1",
        "--out", cmpOut,
      ]);
      assert.match(await readFile(cmpOut, "utf8"), /\+58\.00/);
    } finally {
      console.log = origLog;
    }

    await assert.rejects(runCli(["eval", "mirror"]), /未知 eval 子命令/);
    await assert.rejects(runCli(["eval", "build"]), /未知 eval 子命令/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
