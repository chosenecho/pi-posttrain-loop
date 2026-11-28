import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runProbeBuildLoop } from "../src/eval/probe-loop.js";
import { EvalStore, type ProbeRubric } from "../src/eval/store/index.js";
import type { RoleRunner } from "../src/shared/types.js";

const prompts = { probeWriter: "writer snapshot", probeCritic: "critic snapshot", reference: "reference snapshot", verifier: "verifier snapshot", adversary: "adversary snapshot" };
const rubric = (expectedBehavior: ProbeRubric["expectedBehavior"]): ProbeRubric => ({ expectedBehavior, stance: "结构决定位置", keyPoints: ["结构"], forbidden: [], mustNotHallucinate: [], failureSignals: [] });
const draft = (question: string, multi = false) => ({ probeType: multi ? "hold_position" : "answer", persona: "学生", targetTurns: multi ? 2 : 1, question, anchor: "结构决定位置", trap: "泛化" });
function fixture() {
  const store = new EvalStore(":memory:");
  const source = store.insertSourceMaterial({ videoId: "BV_RESUME", content: "结构决定位置，位置决定立场。" }).record;
  const run = (runRole: RoleRunner, extra: Partial<Parameters<typeof runProbeBuildLoop>[0]> = {}) => runProbeBuildLoop({ evalStore: store, sources: [source], prompts, skills: [], modelId: "build-model", runRole, concurrency: 1, callMaxAttempts: 1, callRetryDelayMs: 0, ...extra });
  return { store, source, run };
}

test("writer batch is fully persisted before first critic and failed slots resume with stable identities", async () => {
  const { store, source, run } = fixture();
  let fail = true;
  let writerCalls = 0;
  const runner: RoleRunner = async ({ role, input }) => {
    if (role === "probe_writer") { writerCalls++; return JSON.stringify({ probes: [draft("问题一？"), draft("问题二？")] }); }
    if (role === "probe_critic") {
      assert.equal(store.listProbes().length, 2, "all drafts exist before critic starts");
      if (fail) throw new Error("transport interrupted");
      return JSON.stringify({ decision: "accept" });
    }
    if (role === "reference") return "原始参考答案";
    if (role === "verifier") return JSON.stringify({ decision: "pass", rubric: rubric(input.expectedBehavior as ProbeRubric["expectedBehavior"]) });
    throw new Error(`unexpected ${role}`);
  };
  try {
    const first = await run(runner);
    assert.equal(first.probesCreated, 2);
    assert.equal(store.getRun(first.runId)?.status, "failed");
    assert.deepEqual(store.listUnbuiltSourceMaterials().map(s => s.id), [source.id]);
    const ids = store.listProbes().map(p => p.id);
    fail = false;
    const second = await run(runner);
    assert.equal(writerCalls, 1);
    assert.deepEqual(store.listProbes().map(p => p.id), ids);
    assert.equal(second.accepted, 2);
    assert.ok(store.listProbes().every(p => p.runId === first.runId));
    assert.deepEqual(store.listProbes({ executionRunId: second.runId }).map(p => p.id), ids);
    assert.equal(store.listUnbuiltSourceMaterials().length, 0);
  } finally { store.close(); }
});

test("reference answer and a passed turn survive verifier failure; next history and tactics use the saved prefix", async () => {
  const { store, run } = fixture();
  let failVerifier = true;
  let refs = 0;
  let adversaries = 0;
  const runner: RoleRunner = async ({ role, input }) => {
    if (role === "probe_writer") return JSON.stringify({ probes: [draft("多轮问题？", true)] });
    if (role === "probe_critic") return JSON.stringify({ decision: "accept" });
    if (role === "adversary") {
      adversaries++;
      assert.deepEqual(input.history, [{ role: "user", content: "多轮问题？" }, { role: "assistant", content: "参考答案1" }]);
      return JSON.stringify({ tactic: "label", userContent: "第二轮追问？", trap: "第二轮陷阱" });
    }
    if (role === "reference") { refs++; return `参考答案${refs}`; }
    if (role === "verifier") {
      if (input.expectedBehavior === "hold_position" && failVerifier) throw new Error("verifier disconnected");
      return JSON.stringify({ decision: "pass", rubric: rubric(input.expectedBehavior as ProbeRubric["expectedBehavior"]) });
    }
    throw new Error(`unexpected ${role}`);
  };
  try {
    const first = await run(runner);
    assert.equal(first.errorSlots, 1);
    const probe = store.listProbes()[0]!;
    const turn = store.listProbeTurns(probe.id)[0]!;
    store.saveCalibration({ probeId: probe.id, turnNo: 1, bareModel: "bare", graderModel: "grader", bareAnswer: "原标定", behaviorOk: true, score: 80, detail: {} });
    const calibration = store.listCalibrationsForProbe(probe.id);
    failVerifier = false;
    const second = await run(runner);
    assert.equal(second.accepted, 1);
    assert.equal(refs, 2, "committed reference is reused for verifier");
    assert.equal(adversaries, 1, "committed adversary is reused");
    assert.deepEqual(store.listProbeTurns(probe.id)[0], turn);
    assert.deepEqual(store.listCalibrationsForProbe(probe.id), calibration);
    assert.equal(store.listProbeTurns(probe.id)[1]?.referenceAnswer, "参考答案2");
  } finally { store.close(); }
});

test("legacy full writer batch restores missing slots and preserves accepted probes, calibration and draft turns", async () => {
  const { store, source, run } = fixture();
  try {
    const origin = store.createRun({ kind: "probe_build", config: { modelId: "build-model", maxProbesPerVideo: 5, maxRevisions: 2, maxAnswerAttempts: 2 }, prompts, skills: [] });
    const drafts = [draft("已通过的问题？"), draft("旧的多轮问题？", true), draft("未落库的问题？")];
    const writer = store.startCall({ runRef: `probe_build:${origin}`, role: "probe_writer", model: "build-model", inputRefs: { source_material_id: source.id, mode: "draft" } });
    store.finishCall(writer, { output: JSON.stringify({ probes: drafts }) });
    const accepted = store.createProbe({ ...drafts[0]!, probeType: "answer", runId: origin, sourceMaterialId: source.id, slotIndex: 1, anchorVerified: true });
    store.saveProbeTurn({ probeId: accepted, turnNo: 1, expectedBehavior: "answer", userContent: drafts[0]!.question, referenceAnswer: "旧的已通过答案", rubric: rubric("answer") });
    store.setProbeStatus(accepted, "accepted");
    store.saveCalibration({ probeId: accepted, turnNo: 1, bareModel: "bare", graderModel: "grader", bareAnswer: "旧标定", behaviorOk: true, score: 82, detail: {} });
    const pending = store.createProbe({ ...drafts[1]!, probeType: "hold_position", runId: origin, sourceMaterialId: source.id, slotIndex: 2, anchorVerified: true });
    store.appendReview(pending, { roundNo: 1, decision: "accept", issues: [], feedback: "", callId: null });
    store.saveProbeTurn({ probeId: pending, turnNo: 1, expectedBehavior: "answer", userContent: drafts[1]!.question, referenceAnswer: "旧的第一轮答案", rubric: rubric("answer") });
    const before = store.listProbeTurns(pending);
    const calibration = store.listCalibrationsForProbe(accepted);
    const migrated = store.migrateLegacyBuildPlans();
    assert.equal(migrated.createdPlans, 1);
    assert.equal(store.listBuildSlots(store.listBuildPlans()[0]!.id).length, 3);
    let writerCalls = 0;
    const result = await run(async ({ role, input }) => {
      if (role === "probe_writer") { writerCalls++; throw new Error("writer must be reused"); }
      if (role === "probe_critic") return JSON.stringify({ decision: "accept" });
      if (role === "adversary") return JSON.stringify({ tactic: "pushback", userContent: "旧题第二轮？" });
      if (role === "reference") return "补齐答案";
      return JSON.stringify({ decision: "pass", rubric: rubric(input.expectedBehavior as ProbeRubric["expectedBehavior"]) });
    });
    assert.equal(writerCalls, 0);
    assert.equal(result.accepted, 2);
    assert.equal(result.newProbes, 1);
    assert.deepEqual(store.listProbeTurns(pending)[0], before[0]);
    assert.deepEqual(store.listCalibrationsForProbe(accepted), calibration);
    assert.equal(store.getProbe(accepted)?.runId, origin);
    assert.equal(store.listProbes().at(-1)?.runId, result.runId);
    assert.equal(store.migrateLegacyBuildPlans().createdPlans, 0);
  } finally { store.close(); }
});

test("empty valid plan is terminal and explicit rebuild creates a new generation", async () => {
  const { store, source, run } = fixture();
  let calls = 0;
  try {
    const runner: RoleRunner = async () => { calls++; return JSON.stringify({ probes: [], skipReason: "材料信息不足" }); };
    const first = await run(runner);
    const second = await run(runner);
    assert.equal(calls, 1);
    assert.equal(first.sourcesSkipped, 1);
    assert.equal(second.totalAgentCalls, 0);
    assert.equal(store.listUnbuiltSourceMaterials().length, 0);
    const plan = store.listBuildPlans({ sourceMaterialId: source.id })[0]!;
    assert.equal(plan.status, "skipped");
    assert.equal(plan.skipReason, "材料信息不足");
    assert.equal(store.listBuildExecutions(second.runId)[0]?.planId, plan.id);
    await run(runner, { rebuild: true });
    assert.equal(calls, 2);
    assert.deepEqual(store.listBuildPlans().map(p => p.generation), [1, 2]);
  } finally { store.close(); }
});

test("critic revisions and answer attempts remain consumed across technical failures", async () => {
  const { store, run } = fixture();
  let interrupt = "critic";
  let criticCalls = 0;
  let revisions = 0;
  let answers = 0;
  const runner: RoleRunner = async ({ role, input }) => {
    if (role === "probe_writer") {
      if (input.mode === "revise") { revisions++; return JSON.stringify({ question: "改写后的问题？" }); }
      return JSON.stringify({ probes: [draft("原始问题？")] });
    }
    if (role === "probe_critic") {
      criticCalls++;
      if (interrupt === "critic" && criticCalls === 2) throw new Error("interrupt after revision");
      return JSON.stringify({ decision: criticCalls === 1 ? "revise" : "accept", feedback: "请收紧问题" });
    }
    if (role === "reference") {
      if (interrupt === "reference" && input.previousAnswer) throw new Error("interrupt after failed answer");
      answers++;
      return `answer ${answers}`;
    }
    if (role === "verifier") return JSON.stringify({ decision: "revise", feedback: "重写答案", issues: ["缺论点"] });
    throw new Error(`unexpected ${role}`);
  };
  try {
    const first = await run(runner, { maxRevisions: 1, maxAnswerAttempts: 2 });
    assert.equal(first.errorSlots, 1);
    assert.equal(store.listProbes()[0]?.revisions, 1);
    interrupt = "reference";
    const second = await run(runner, { maxRevisions: 1, maxAnswerAttempts: 2 });
    assert.equal(second.errorSlots, 1);
    assert.equal(answers, 1);
    interrupt = "none";
    const third = await run(runner, { maxRevisions: 1, maxAnswerAttempts: 2 });
    assert.equal(third.dropped, 1);
    assert.equal(answers, 2);
    assert.equal(revisions, 1);
    assert.equal(third.plansComplete, true);
    const before = criticCalls;
    const reused = await run(runner, { maxRevisions: 1, maxAnswerAttempts: 2 });
    assert.equal(criticCalls, before);
    assert.equal(reused.reusedTerminal, 1);
  } finally { store.close(); }
});

test("unfinished build rejects changed semantics before mutation and explicit resume uses the saved prompts", async () => {
  const { store, run } = fixture();
  let fail = true;
  const seen: string[] = [];
  const runner: RoleRunner = async ({ role, input, systemPrompt }) => {
    seen.push(systemPrompt);
    if (role === "probe_writer") return JSON.stringify({ probes: [draft("配置问题？")] });
    if (role === "probe_critic") { if (fail) throw new Error("interrupt"); return JSON.stringify({ decision: "accept" }); }
    if (role === "reference") return "参考答案";
    return JSON.stringify({ decision: "pass", rubric: rubric(input.expectedBehavior as ProbeRubric["expectedBehavior"]) });
  };
  try {
    const first = await run(runner);
    const before = store.listBuildPlans();
    const count = seen.length;
    await assert.rejects(run(runner, { prompts: { ...prompts, reference: "changed" } }), /build_config_conflict/);
    assert.equal(seen.length, count);
    assert.deepEqual(store.listBuildPlans(), before);
    assert.equal(store.getLatestRun("probe_build")?.id, first.runId);
    fail = false;
    const resumed = await run(runner, { modelId: "different", prompts: { ...prompts, reference: "changed" }, resumeBuildRunId: first.runId, concurrency: 2 });
    assert.equal(resumed.accepted, 1);
    assert.equal(store.getRun(resumed.runId)?.config.modelId, "build-model");
    assert.equal(store.getRun(resumed.runId)?.prompts.reference, prompts.reference);
    assert.ok(seen.includes(prompts.reference));
    assert.ok(!seen.includes("changed"));
  } finally { store.close(); }
});

test("legacy unknown batch is reported after known draft completes and only rebuild supersedes it", async () => {
  const { store, source, run } = fixture();
  try {
    const origin = store.createRun({ kind: "probe_build", config: { modelId: "build-model", maxProbesPerVideo: 5, maxRevisions: 2, maxAnswerAttempts: 2 }, prompts, skills: [] });
    const old = store.createProbe({ ...draft("已知旧问题？"), probeType: "answer", runId: origin, sourceMaterialId: source.id, slotIndex: 1, anchorVerified: true });
    const migration = store.migrateLegacyBuildPlans();
    assert.equal(migration.incompletePlanIds.length, 1);
    let writerCalls = 0;
    const runner: RoleRunner = async ({ role, input }) => {
      if (role === "probe_writer") { writerCalls++; return JSON.stringify({ probes: [] }); }
      if (role === "probe_critic") return JSON.stringify({ decision: "accept" });
      if (role === "reference") return "已知题答案";
      return JSON.stringify({ decision: "pass", rubric: rubric(input.expectedBehavior as ProbeRubric["expectedBehavior"]) });
    };
    const result = await run(runner);
    assert.equal(store.getProbe(old)?.status, "accepted");
    assert.equal(writerCalls, 0);
    assert.equal(result.partial, true);
    assert.deepEqual(result.incompleteLegacyPlans, migration.incompletePlanIds);
    assert.equal(store.listUnbuiltSourceMaterials().length, 1);
    const rebuilt = await run(runner, { rebuild: true });
    assert.equal(rebuilt.plansComplete, true);
    assert.equal(writerCalls, 1);
    assert.equal(store.listUnbuiltSourceMaterials().length, 0);
    assert.equal(store.getProbe(old)?.status, "accepted");
  } finally { store.close(); }
});

test("checkpoint gap is diagnosed without overwriting passed turns or generating new answers", async () => {
  const { store, run } = fixture();
  let references = 0;
  try {
    const first = await run(async ({ role }) => {
      if (role === "probe_writer") return JSON.stringify({ probes: [draft("损坏检查点？", true)] });
      if (role === "probe_critic") return JSON.stringify({ decision: "accept" });
      throw new Error("stop before reference");
    });
    const probe = store.listProbes()[0]!;
    store.saveProbeTurn({ probeId: probe.id, turnNo: 2, expectedBehavior: "hold_position", tactic: "label", userContent: "错误断档轮次", referenceAnswer: "保留供核查", rubric: rubric("hold_position") });
    const before = store.listProbeTurns(probe.id);
    const result = await run(async () => { references++; return "should not run"; });
    assert.equal(result.partial, true);
    assert.equal(references, 0);
    assert.equal(store.listBuildSlots(first.planIds[0]!)[0]?.errorCode, "checkpoint_invalid");
    assert.deepEqual(store.listProbeTurns(probe.id), before);
  } finally { store.close(); }
});

test("oversized writer batch is a recoverable validation error instead of a truncated complete plan", async () => {
  const { store, run } = fixture();
  try {
    const result = await run(async () => JSON.stringify({ probes: [draft("一？"), draft("二？")] }), { maxProbesPerVideo: 1 });
    assert.equal(result.partial, true);
    assert.equal(store.listProbes().length, 0);
    assert.equal(store.listBuildPlans()[0]?.planComplete, false);
    assert.equal(store.listBuildPlans()[0]?.errorCode, "model_output_invalid");
  } finally { store.close(); }
});

test("legacy missing snapshot reports incomplete work and preserves terminal probes for explicit partial selection", async () => {
  const { store, source, run } = fixture();
  try {
    const origin = store.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
    const old = store.createProbe({ ...draft("历史已通过题？"), probeType: "answer", runId: origin, sourceMaterialId: source.id, slotIndex: 1, anchorVerified: true });
    store.setProbeStatus(old, "accepted");
    store.saveProbeTurn({ probeId: old, turnNo: 1, expectedBehavior: "answer", userContent: "历史已通过题？", referenceAnswer: "历史答案", rubric: rubric("answer") });
    const before = store.getProbe(old);
    const migration = store.migrateLegacyBuildPlans();
    const result = await run(async () => { throw new Error("legacy must not call model"); });
    assert.equal(result.partial, true);
    assert.deepEqual(result.incompleteLegacyPlans, migration.incompletePlanIds);
    assert.deepEqual(store.listProbes({ executionRunId: result.runId }).map(p => p.id), [old]);
    assert.deepEqual(store.getProbe(old), before);
    await assert.rejects(run(async () => "", { resumeBuildRunId: origin }), /build_snapshot_missing/);
  } finally { store.close(); }
});

test("complete stored role output is replayed without another model request before checkpoint advancement", async () => {
  const { store, run } = fixture();
  try {
    const first = await run(async ({ role }) => {
      if (role === "probe_writer") return JSON.stringify({ probes: [draft("响应已保存的问题？")] });
      throw new Error("stop critic");
    });
    const plan = store.getBuildPlan(first.planIds[0]!)!;
    const slot = store.listBuildSlots(plan.id)[0]!;
    const callId = store.startBuildSlotCall(slot.id, first.runId, slot.checkpoint, { runRef: `probe_build:${first.runId}`, role: "probe_critic", model: "build-model", inputRefs: { plan_id: plan.id, slot_id: slot.id, probe_id: slot.probeId, stage: "critic", turn_no: 1, round_no: 1, attempt: 1 } });
    store.finishCall(callId, { output: JSON.stringify({ decision: "accept" }) });
    const result = await run(async ({ role, input }) => {
      if (role === "reference") return "原响应恢复后的答案";
      if (role === "verifier") return JSON.stringify({ decision: "pass", rubric: rubric(input.expectedBehavior as ProbeRubric["expectedBehavior"]) });
      throw new Error(`committed ${role} must be reused`);
    });
    assert.equal(result.accepted, 1);
    assert.equal(result.totalAgentCalls, 2);
    assert.equal(store.getAgentCall(callId)?.output, JSON.stringify({ decision: "accept" }));
  } finally { store.close(); }
});

test("cancelled in-flight build drains workers, leaves retryable checkpoints and stops queued sources", async () => {
  const { store, source, run } = fixture();
  const next = store.insertSourceMaterial({ videoId: "BV_QUEUED", content: "位置决定立场。" }).record;
  const controller = new AbortController();
  let calls = 0;
  let cleaned = false;
  try {
    await assert.rejects(run(async ({ signal }) => {
      calls++;
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => { cleaned = true; reject(new Error("cancelled")); }, { once: true });
        controller.abort();
      });
      return "";
    }, { sources: [source, next], concurrency: 1, signal: controller.signal }), /operation_aborted/);
    assert.equal(calls, 1);
    assert.equal(cleaned, true);
    assert.equal(store.listBuildPlans({ sourceMaterialId: next.id }).length, 0);
    assert.equal(store.listBuildPlans({ sourceMaterialId: source.id })[0]?.status, "retryable");
    assert.equal(store.getLatestRun("probe_build")?.status, "failed");
  } finally { store.close(); }
});

for (const stage of ["writer", "critic", "revision", "adversary", "reference", "verifier", "turn"]) {
  test(`process exit after ${stage} retains committed work and resumes at the next stage`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "probe-checkpoint-exit-"));
    const dbPath = join(directory, "fixture.sqlite");
    const trace = join(directory, "calls.jsonl");
    const result = join(directory, "result.json");
    const launch = (stopAt: string) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/probe-build-process.ts", import.meta.url)), dbPath, trace, result, stopAt], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    try {
      assert.equal(await launch(stage), 17);
      let ids: number[];
      let passed: ReturnType<EvalStore["listProbeTurns"]>;
      let origin: number;
      const interrupted = new EvalStore(dbPath);
      try {
        ids = interrupted.listProbes().map(p => p.id);
        origin = interrupted.getLatestRun("probe_build")!.id;
        passed = interrupted.listProbeTurns(ids[0]!);
        assert.equal(ids.length, 2);
      } finally { interrupted.close(); }
      assert.equal(await launch("none"), 0);
      const summary = JSON.parse(await readFile(result, "utf8"));
      const store = new EvalStore(dbPath);
      try {
        assert.deepEqual(store.listProbes().map(p => p.id), ids);
        assert.ok(store.listProbes().every(p => p.runId === origin));
        assert.deepEqual(store.listProbeTurns(ids[0]!).slice(0, passed.length), passed);
        assert.equal(store.getProbe(ids[0]!)?.status, "accepted");
        assert.equal(store.getProbe(ids[1]!)?.status, "rejected");
        assert.equal(summary.plansComplete, true);
        assert.equal(store.getRun(origin)?.status, "interrupted");
        const log = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        for (const key of ["writer", "revision", "adversary", "reference", "reference-after-verifier", "reference-after-adversary"]) assert.equal(log.filter(e => e.key === key && !e.crashed).length, 1, `${key} completes once`);
      } finally { store.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
