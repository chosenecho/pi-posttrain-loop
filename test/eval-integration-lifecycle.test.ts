import assert from "node:assert/strict";
import test from "node:test";
import { runProbeCalibration } from "../src/eval/calibrate.js";
import { gradeEvalRun } from "../src/eval/eval-grader.js";
import { EvalStore, type ProbeRubric } from "../src/eval/store/index.js";
import { PublicError } from "../src/shared/public-error.js";

const rubric: ProbeRubric = { expectedBehavior: "answer", stance: "结构决定位置", keyPoints: ["结构"], forbidden: [], mustNotHallucinate: [], failureSignals: [] };
function seedProbe(store: EvalStore) {
  const source = store.insertSourceMaterial({ videoId: "BV_LIFECYCLE", content: "结构决定位置。", splitSnapshot: "test" }).record;
  const runId = store.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
  const probeId = store.createProbe({ runId, sourceMaterialId: source.id, slotIndex: 1, probeType: "answer", persona: "学生", targetTurns: 1, question: "如何理解结构？", anchor: "结构决定位置", trap: "泛化", anchorVerified: true });
  store.saveProbeTurn({ probeId, turnNo: 1, expectedBehavior: "answer", userContent: "如何理解结构？", referenceAnswer: "结构决定位置。", rubric, attempts: 1 });
  store.setProbeStatus(probeId, "accepted");
  store.finishRun(runId, "completed");
  return store.getProbe(probeId)!;
}

test("calibration propagates store cancellation and drains the role before finishing its run", async () => {
  const store = new EvalStore(":memory:");
  try {
    const probe = seedProbe(store);
    let roleSignal: AbortSignal | undefined;
    let release!: () => void;
    const drained = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const running = runProbeCalibration({
      evalStore: store, probes: [probe], prompts: { bareAnswer: "bare", evalGrader: "grade" }, skills: [],
      bareModelId: "bare", graderModelId: "grader", callMaxAttempts: 3, callRetryDelayMs: 0,
      runBareModel: async ({ signal }) => {
        calls++;
        roleSignal = signal;
        entered();
        await drained;
        throw new PublicError("operation_aborted");
      },
      runGrader: async () => { throw new Error("grader should not start"); },
    });
    const rejected = assert.rejects(running, /operation_aborted/);
    await started;
    store.abort();
    assert.equal(roleSignal?.aborted, true);
    assert.equal(store.getLatestRun("calibrate")?.status, "running", "the run stays running until the actual role settles");
    release();
    await rejected;
    assert.equal(calls, 1);
    assert.equal(store.getLatestRun("calibrate")?.status, "failed");
    assert.equal(store.getProbe(probe.id)?.difficulty, null);
  } finally { store.close(); }
});

test("legacy grading and regrading validate before starting any call or changing records", async () => {
  const store = new EvalStore(":memory:");
  try {
    const suite = store.freezeSuite({ name: "legacy", sha256: "f".repeat(64), manifest: {}, items: [{ itemKey: "legacy:1", videoKey: "BV", probeType: "answer", messages: [{ role: "user", content: "问题" }, { role: "assistant", content: "参考" }], rubrics: [{ turnNo: 1, expectedBehavior: "answer", tactic: null, rubric }] }] }).suite;
    const runId = store.createEvalRun({ suiteId: suite.id, candidate: "legacy", model: "old", historyMode: "gold", systemPrompt: null, config: {} });
    const before = store.getEvalRun(runId);
    let calls = 0;
    for (const regrade of [false, true]) {
      await assert.rejects(gradeEvalRun({ evalStore: store, evalRunId: runId, graderPrompt: "grade", graderModelId: "judge", regrade, runGrader: async () => { calls++; return "{}"; } }), /legacy_spec_incomplete/);
    }
    assert.equal(calls, 0);
    assert.equal(store.countAgentCalls(`eval_run:${runId}`), 0);
    assert.deepEqual(store.getEvalRun(runId), before);
  } finally { store.close(); }
});
