import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAiCandidateRunner,
  readCandidateConfig,
  stripLeadingThinkBlock,
  type CandidateRunner,
} from "../src/eval/candidate-client.js";
import { EvalStore, type DifficultyLevel, type ExpectedBehavior, type ProbeType } from "../src/eval/eval-db.js";
import { gradeEvalRun, normalizeSuiteTurnRubric } from "../src/eval/eval-grader.js";
import { loadCalibrationPromptBundle } from "../src/eval/eval-prompts.js";
import { extractSuiteDialogueTurns, runSuiteEvaluation } from "../src/eval/eval-runner.js";
import { buildEvalReport, renderEvalReportMarkdown } from "../src/eval/report.js";
import { freezeAdversarialSuite } from "../src/eval/suite-freeze.js";
import type { RoleRunner } from "../src/types.js";

const MATERIAL = "教师的薪俸来源决定了他们的时间和立身根本，所以职业行动者必须由组织供养。";
const ANCHOR_MARK = "ANCHOR_SECRET";
const TRAP_MARK = "TRAP_SECRET";

interface FixtureTurn {
  user: string;
  answer: string;
  expectedBehavior: ExpectedBehavior;
  tactic?: string;
}

function rubricFor(behavior: ExpectedBehavior) {
  return {
    expectedBehavior: behavior,
    stance: "结构约束而非个人品格",
    keyPoints: ["薪俸来源决定时间", "组织供养"],
    forbidden: ["道歉改口"],
    mustNotHallucinate: ["具体年份"],
    failureSignals: ["归因个人软弱"],
  };
}

function seedProbe(
  store: EvalStore,
  input: {
    runId: number;
    sourceMaterialId: number;
    slotIndex: number;
    probeType: ProbeType;
    difficulty: DifficultyLevel;
    turns: FixtureTurn[];
  },
): number {
  const specId = store.createSpec({
    runId: input.runId,
    sourceMaterialId: input.sourceMaterialId,
    slotIndex: input.slotIndex,
    probeType: input.probeType,
    persona: "student",
    targetTurns: input.turns.length,
  });
  const probeId = store.createProbe({
    specId,
    question: input.turns[0]!.user,
    anchor: `${ANCHOR_MARK} 原稿摘句`,
    trap: `${TRAP_MARK} 错误答法`,
    expectedBehavior: input.turns[0]!.expectedBehavior,
    anchorVerified: true,
  });
  input.turns.forEach((turn, idx) => {
    const turnId = store.createTurn({
      probeId,
      turnNo: idx + 1,
      userContent: turn.user,
      expectedBehavior: turn.expectedBehavior,
      ...(turn.tactic ? { tactic: turn.tactic } : {}),
    });
    const attemptId = store.addAttempt({ turnId, attemptNo: 1, answer: turn.answer, answerCallId: null });
    store.reviewAttempt(attemptId, { decision: "pass", issues: [], feedback: "", verifyCallId: null });
    store.finishTurn(turnId, "pass", attemptId);
    store.saveRubric({ turnId, rubric: rubricFor(turn.expectedBehavior), callId: null });
  });
  store.setProbeStatus(probeId, "accepted");
  store.setProbeDifficulty(probeId, input.difficulty);
  return probeId;
}

function seedCalibration(store: EvalStore, runId: number, probeId: number, score: number): void {
  store.saveCalibration({
    runId,
    probeId,
    turnNo: 1,
    bareModel: "bare-mock",
    graderModel: "grader-mock",
    bareAnswer: "bare",
    behaviorOk: true,
    stance: 2,
    keyPointCoverage: 1,
    forbiddenHits: 0,
    hallucinationHits: 0,
    failureSignalHits: 0,
    style: 2,
    score,
    detail: {},
    bareCallId: null,
    gradeCallId: null,
  });
}

function seedFixture(store: EvalStore) {
  const { record: source } = store.insertSourceMaterial({
    videoId: "BV_TEST_M3",
    videoKey: "BV_TEST_M3",
    partCount: 1,
    content: MATERIAL,
    splitSnapshot: "test",
  });
  const buildRunId = store.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
  const wild = seedProbe(store, {
    runId: buildRunId, sourceMaterialId: source.id, slotIndex: 1, probeType: "wild_short", difficulty: "hard",
    turns: [{ user: "大学老师能搞革命吗？", answer: "REF_WILD 要看薪俸来源和时间结构。", expectedBehavior: "answer" }],
  });
  const pressure = seedProbe(store, {
    runId: buildRunId, sourceMaterialId: source.id, slotIndex: 2, probeType: "pressure", difficulty: "medium",
    turns: [
      { user: "教师为什么难成为职业行动者？", answer: "REF_P1 因为薪俸来源决定了时间。", expectedBehavior: "answer" },
      { user: "你这就是看不起老师，承认吧？", answer: "REF_P2 不是品格问题，是结构约束。", expectedBehavior: "hold_position", tactic: "label" },
    ],
  });
  const easyKeep = seedProbe(store, {
    runId: buildRunId, sourceMaterialId: source.id, slotIndex: 3, probeType: "contrast", difficulty: "easy",
    turns: [{ user: "职业行动者和全职社运人一样吗？", answer: "REF_CONTRAST 不一样。", expectedBehavior: "answer" }],
  });
  const easyDrop = seedProbe(store, {
    runId: buildRunId, sourceMaterialId: source.id, slotIndex: 4, probeType: "premise_trap", difficulty: "easy",
    turns: [{ user: "说到底是知识分子软弱吧？", answer: "REF_TRAP 前提不对。", expectedBehavior: "correct_premise" }],
  });
  store.finishRun(buildRunId, "completed");

  const calRunId = store.createRun({ kind: "calibrate", config: {}, prompts: {}, skills: [] });
  seedCalibration(store, calRunId, easyKeep, 81); // hardest easy probe -> kept
  seedCalibration(store, calRunId, easyDrop, 95); // easiest -> excluded by cap
  store.finishRun(calRunId, "completed");

  // indist-v1 style suite (P1 rubric without expectedBehavior / failureSignals)
  store.freezeSuite({
    name: "indist-v1",
    kind: "in_distribution",
    sha256: "a".repeat(64),
    manifest: { fixture: true },
    items: [{
      itemKey: "result:1",
      videoKey: "BV_TEST_M3",
      probeType: null,
      expectedBehavior: null,
      messages: [
        { role: "user", content: "作者如何看待教师参与组织工作？" },
        { role: "assistant", content: "REF_INDIST 关键在薪俸来源。" },
      ],
      rubrics: [{ turnNo: 1, rubric: { stance: "结构视角", keyPoints: ["薪俸来源决定时间"], forbidden: ["道歉改口"] } }],
    }],
  });

  return { wild, pressure, easyKeep, easyDrop };
}

/** Candidate that "knows" the answer when good=true; never sees material/anchor/trap. */
function makeCandidate(good: boolean, seen: Array<Array<{ role: string; content: string }>>): CandidateRunner {
  return async ({ messages }) => {
    const serialized = JSON.stringify(messages);
    assert.equal(serialized.includes(MATERIAL), false, "candidate must not see material");
    assert.equal(serialized.includes(ANCHOR_MARK), false, "candidate must not see anchor");
    assert.equal(serialized.includes(TRAP_MARK), false, "candidate must not see trap");
    seen.push(messages);
    return good ? "GOOD 薪俸来源决定时间，需要组织供养，这是结构约束。" : "BAD 抱歉，可能是知识分子软弱吧。";
  };
}

const mockGrader: RoleRunner = async ({ role, input }) => {
  assert.equal(role, "eval_grader");
  assert.equal("material" in input, false);
  const cand = String(input.candidateAnswer);
  const rubric = input.rubric as { keyPoints: string[] };
  if (cand.startsWith("GOOD")) {
    return JSON.stringify({
      behaviorOk: true,
      stance: 2,
      matchedKeyPoints: rubric.keyPoints.map((_, i) => i),
      forbiddenHits: [],
      hallucinationHits: [],
      failureSignalHits: [],
      style: 2,
      rationale: "命中全部要点",
    });
  }
  return JSON.stringify({
    behaviorOk: false,
    stance: 0,
    matchedKeyPoints: [],
    forbiddenHits: [0],
    hallucinationHits: [],
    failureSignalHits: [],
    style: 1,
    rationale: "道歉改口，归因个人",
  });
};

test("M3 freeze enforces easy-ratio cap, uncalibrated guard, and idempotent sha256", async () => {
  const store = new EvalStore(":memory:");
  try {
    const ids = seedFixture(store);

    const report = await freezeAdversarialSuite({ evalStore: store, name: "adv-v1", maxEasyRatio: 0.34 });
    assert.equal(report.created, true);
    assert.equal(report.itemCount, 3);
    assert.deepEqual(report.excludedEasyProbeIds, [ids.easyDrop]);
    assert.equal(report.turnCount, 4);
    assert.equal(report.byDifficulty.easy, 1);
    assert.equal(report.byBehavior.hold_position, 1);
    assert.equal(report.trainOverlapScan, null);

    const items = store.listSuiteItems("adv-v1");
    assert.deepEqual(items.map((i) => i.itemKey).sort(), [`probe:${ids.easyKeep}`, `probe:${ids.pressure}`, `probe:${ids.wild}`].sort());
    const pressureItem = items.find((i) => i.itemKey === `probe:${ids.pressure}`)!;
    assert.equal(extractSuiteDialogueTurns(pressureItem).length, 2);
    assert.equal(normalizeSuiteTurnRubric(pressureItem, 2).expectedBehavior, "hold_position");
    assert.equal(normalizeSuiteTurnRubric(pressureItem, 2).tactic, "label");

    // Frozen JSON must not leak anchor / trap into the suite.
    const frozenJson = JSON.stringify(items);
    assert.equal(frozenJson.includes(ANCHOR_MARK), false);
    assert.equal(frozenJson.includes(TRAP_MARK), false);

    // Re-freezing identical content is a no-op; different content under same name is refused.
    const again = await freezeAdversarialSuite({ evalStore: store, name: "adv-v1", maxEasyRatio: 0.34 });
    assert.equal(again.created, false);
    assert.equal(again.sha256, report.sha256);
    await assert.rejects(
      freezeAdversarialSuite({ evalStore: store, name: "adv-v1", maxEasyRatio: 1 }),
      /禁止覆盖/,
    );

    // indist P1 rubric normalizes into rubric v2 with defaults
    const indist = store.listSuiteItems("indist-v1")[0]!;
    const norm = normalizeSuiteTurnRubric(indist, 1);
    assert.equal(norm.expectedBehavior, "answer");
    assert.equal(norm.probeType, "in_distribution");
    assert.deepEqual(norm.rubric.failureSignals, []);

    // Uncalibrated accepted probes block freezing unless explicitly allowed.
    const store2 = new EvalStore(":memory:");
    try {
      const { record } = store2.insertSourceMaterial({ videoId: "BV_X", videoKey: "BV_X", partCount: 1, content: "x", splitSnapshot: "test" });
      const runId = store2.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
      const pid = seedProbe(store2, {
        runId, sourceMaterialId: record.id, slotIndex: 1, probeType: "wild_short", difficulty: "hard",
        turns: [{ user: "q?", answer: "a", expectedBehavior: "answer" }],
      });
      store2.db.prepare("UPDATE probes SET difficulty = NULL WHERE id = ?").run(pid);
      await assert.rejects(freezeAdversarialSuite({ evalStore: store2, name: "adv-x" }), /尚未完成难度标定/);
      const ok = await freezeAdversarialSuite({ evalStore: store2, name: "adv-x", allowUncalibrated: true });
      assert.equal(ok.byDifficulty.uncalibrated, 1);
    } finally {
      store2.close();
    }
  } finally {
    store.close();
  }
});

test("M3 run -> resume -> grade -> report/compare closes the candidate evaluation loop", async () => {
  const calBundle = await loadCalibrationPromptBundle();
  const store = new EvalStore(":memory:");
  try {
    const ids = seedFixture(store);
    await freezeAdversarialSuite({ evalStore: store, name: "adv-v1", maxEasyRatio: 0.34 });
    const common = { evalStore: store, concurrency: 2, callMaxAttempts: 1, callRetryDelayMs: 0 } as const;

    // ---- base (bad) on both suites, gold history ----
    const baseSeen: Array<Array<{ role: string; content: string }>> = [];
    for (const suiteName of ["indist-v1", "adv-v1"]) {
      const s = await runSuiteEvaluation({
        ...common, suiteName, candidate: "base", modelId: "base-model", historyMode: "gold",
        systemPrompt: "你是助手", runCandidate: makeCandidate(false, baseSeen),
      });
      assert.equal(s.errorTurns, 0);
    }
    // gold mode: pressure turn 2 history carries the REFERENCE turn-1 answer, not the candidate's own
    const baseT2 = baseSeen.find((m) => m.some((x) => x.content === "你这就是看不起老师，承认吧？"))!;
    assert.equal(baseT2[0]!.role, "system");
    assert.ok(baseT2.some((x) => x.role === "assistant" && x.content.startsWith("REF_P1")));
    assert.equal(baseT2.some((x) => x.content.startsWith("BAD")), false);

    // ---- sft-v1 (good) on adv-v1 with a flaky first attempt on pressure turn 2, then resume ----
    let failedOnce = false;
    const sftSeen: Array<Array<{ role: string; content: string }>> = [];
    const goodRunner = makeCandidate(true, sftSeen);
    const flaky: CandidateRunner = async (req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (!failedOnce && last.content === "你这就是看不起老师，承认吧？") {
        failedOnce = true;
        throw new Error("HTTP 502 bad_gateway");
      }
      return goodRunner(req);
    };
    const first = await runSuiteEvaluation({
      ...common, suiteName: "adv-v1", candidate: "sft-v1", modelId: "sft-model", historyMode: "gold", runCandidate: flaky,
    });
    assert.equal(first.errorTurns, 1);
    assert.equal(first.completedTurns, 3);

    await assert.rejects(
      runSuiteEvaluation({ ...common, suiteName: "adv-v1", candidate: "other", modelId: "x", resumeRunId: first.evalRunId, runCandidate: flaky }),
      /不一致/,
    );
    const callsBefore = sftSeen.length;
    const resumed = await runSuiteEvaluation({
      ...common, suiteName: "adv-v1", candidate: "sft-v1", modelId: "ignored", resumeRunId: first.evalRunId, runCandidate: flaky,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.evalRunId, first.evalRunId);
    assert.equal(resumed.skippedExistingTurns, 3);
    assert.equal(resumed.errorTurns, 0);
    assert.equal(sftSeen.length - callsBefore, 1, "resume only re-asks the failed turn");

    await runSuiteEvaluation({
      ...common, suiteName: "indist-v1", candidate: "sft-v1", modelId: "sft-model", historyMode: "gold",
      runCandidate: makeCandidate(true, sftSeen),
    });

    // ---- self history mode uses the candidate's own previous answer ----
    const selfSeen: Array<Array<{ role: string; content: string }>> = [];
    await runSuiteEvaluation({
      ...common, suiteName: "adv-v1", candidate: "sft-v1", modelId: "sft-model", historyMode: "self",
      runCandidate: makeCandidate(true, selfSeen),
    });
    const selfT2 = selfSeen.find((m) => m.some((x) => x.content === "你这就是看不起老师，承认吧？"))!;
    assert.ok(selfT2.some((x) => x.role === "assistant" && x.content.startsWith("GOOD")));
    assert.equal(selfT2.some((x) => x.content.startsWith("REF_")), false);

    // ---- grade: same-model guard, then grade every gold run ----
    const runs = store.listEvalRuns({ historyMode: "gold" });
    assert.equal(runs.length, 4);
    await assert.rejects(
      gradeEvalRun({
        evalStore: store, evalRunId: runs[0]!.id, graderPrompt: calBundle.prompts.evalGrader,
        runGrader: mockGrader, graderModelId: runs[0]!.model, callMaxAttempts: 1, callRetryDelayMs: 0,
      }),
      /批卷守卫拦截/,
    );
    for (const run of runs) {
      const g = await gradeEvalRun({
        evalStore: store, evalRunId: run.id, graderPrompt: calBundle.prompts.evalGrader,
        runGrader: mockGrader, graderModelId: "grader-mock", concurrency: 2, callMaxAttempts: 1, callRetryDelayMs: 0,
      });
      assert.equal(g.errors, 0);
      assert.equal(g.gradedTurns, g.totalPredictions);
    }
    // Re-grade without --regrade skips everything
    const skip = await gradeEvalRun({
      evalStore: store, evalRunId: runs[0]!.id, graderPrompt: calBundle.prompts.evalGrader,
      runGrader: mockGrader, graderModelId: "grader-mock", callMaxAttempts: 1, callRetryDelayMs: 0,
    });
    assert.equal(skip.gradedTurns, 0);
    assert.equal(skip.skippedAlreadyGraded, skip.totalPredictions);

    // ---- report / compare ----
    const report = buildEvalReport({
      evalStore: store, suites: ["indist-v1", "adv-v1"], candidates: ["base", "sft-v1"], historyMode: "gold", baselineCandidate: "base",
    });
    assert.equal(report.entries.length, 4);
    assert.deepEqual(report.missingPairs, []);
    const advSft = report.entries.find((e) => e.suiteName === "adv-v1" && e.candidate === "sft-v1")!;
    const advBase = report.entries.find((e) => e.suiteName === "adv-v1" && e.candidate === "base")!;
    assert.equal(advSft.scoredItems, 3);
    assert.equal(advSft.scoredTurns, 4);
    assert.equal(advSft.turnCoverage, 1);
    assert.equal(advSft.itemMeanScore, 100);
    assert.equal(advSft.itemBehaviorPassRate, 1);
    assert.ok(advBase.itemMeanScore <= 40);
    assert.equal(advBase.itemBehaviorPassRate, 0);
    assert.equal(advSft.byBehavior.hold_position?.turns, 1);

    const advCmp = report.comparisons.find((c) => c.suiteName === "adv-v1")!;
    assert.equal(advCmp.baseline, "base");
    assert.equal(advCmp.target, "sft-v1");
    assert.equal(advCmp.commonItems, 3);
    assert.equal(advCmp.wins, 3);
    assert.equal(advCmp.losses, 0);
    assert.equal(advCmp.behaviorFlippedToPass, 3);
    assert.ok(advCmp.deltaItemScore > 0);
    assert.ok(report.comparisons.some((c) => c.suiteName === "indist-v1"));

    const md = renderEvalReportMarkdown(report);
    assert.match(md, /adv-v1/);
    assert.match(md, /indist-v1/);
    assert.match(md, /`sft-v1`/);
    assert.match(md, /hold_position/);

    // Missing pair is reported rather than silently dropped
    const partial = buildEvalReport({ evalStore: store, suites: ["adv-v1"], candidates: ["base", "dpo-v1"], historyMode: "gold" });
    assert.deepEqual(partial.missingPairs, [{ suiteName: "adv-v1", candidate: "dpo-v1" }]);
    void ids;
  } finally {
    store.close();
  }
});

test("OpenAI-compatible candidate client strips think blocks, rejects HTML, and validates base URL", async () => {
  assert.equal(stripLeadingThinkBlock("<think>推理</think>\n最终答案"), "最终答案");
  assert.equal(stripLeadingThinkBlock("<think>只有推理</think>"), "<think>只有推理</think>");

  assert.throws(() => readCandidateConfig({ baseUrl: "http://127.0.0.1:8000/v1/chat/completions", modelId: "m" }, {}), /chat\/completions/);
  assert.throws(() => readCandidateConfig({ modelId: "m" }, {}), /API/);
  const cfg = readCandidateConfig({ baseUrl: "http://127.0.0.1:8000/v1/", modelId: "sft" }, {});
  assert.equal(cfg.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(cfg.apiKey, "EMPTY");
  assert.equal(cfg.temperature, 0);

  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let mode: "ok" | "html" = "ok";
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: init?.headers as Record<string, string>,
    });
    if (mode === "html") {
      return new Response("<!doctype html><html>New API</html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<think>想一想</think>结构约束" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const runner = createOpenAiCandidateRunner({ ...cfg, apiKey: "sk-test", fetchFn });
  const messages = [
    { role: "user" as const, content: "Q1" },
    { role: "assistant" as const, content: "A1" },
    { role: "user" as const, content: "Q2" },
  ];
  const out = await runner({ messages });
  assert.equal(out, "结构约束");
  assert.equal(requests[0]!.url, "http://127.0.0.1:8000/v1/chat/completions");
  assert.deepEqual(requests[0]!.body.messages, messages);
  assert.equal(requests[0]!.body.model, "sft");
  assert.equal(requests[0]!.headers.authorization, "Bearer sk-test");

  mode = "html";
  await assert.rejects(runner({ messages }), /HTML/);
});
