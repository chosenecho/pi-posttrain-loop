import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { importTestSources } from "../src/eval/source-import.js";
import { runEvalCli } from "../src/cli/eval.js";
import { makeEvalSuiteWorkflow, inspectEvalProbesWorkflow } from "../src/eval/workflows.js";
import { EvalStore, type ProbeRubric } from "../src/eval/store/index.js";
import { DataMakerStore } from "../src/synth/store/index.js";
import type { RoleRunner } from "../src/shared/types.js";

const rubric: ProbeRubric = { expectedBehavior: "answer", stance: "结构决定位置", keyPoints: ["结构"], forbidden: [], mustNotHallucinate: [], failureSignals: [] };
const grade = JSON.stringify({ verdict: "partial", score: 60, behaviorOk: true, hallucinated: false, stance: 2, matchedKeyPoints: [0], forbiddenHits: [], hallucinationHits: [], failureSignalHits: [], style: 1, rationale: "部分" });
function fixtureRole(failReference: () => boolean): RoleRunner {
  return async ({ role, input }) => {
    if (role === "probe_writer") return JSON.stringify({ probes: [{ probeType: "answer", persona: "学生", question: `如何理解${String(input.videoId)}的结构？`, anchor: "结构决定位置", trap: "泛化" }] });
    if (role === "probe_critic") return JSON.stringify({ decision: "accept", issues: [], feedback: "" });
    if (role === "reference") { if (failReference()) throw new Error("fixture interruption"); return "结构决定位置。"; }
    if (role === "verifier") return JSON.stringify({ decision: "pass", issues: [], feedback: "", rubric });
    throw new Error(`unexpected role ${role}`);
  };
}
async function mainFixture(path: string) {
  const main = new DataMakerStore(path);
  try {
    for (const key of ["BV_SCOPE_A", "BV_SCOPE_B"]) {
      main.upsertMaterial({ videoId: key, content: "结构决定位置，位置形成判断。" });
      main.assignVideoSplit({ videoKey: key, split: "test", method: "manual" });
    }
  } finally { main.close(); }
}

test("eval migrate CLI exposes explicit dry run without constructing a write store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-migrate-cli-"));
  const log = console.log;
  const logs: string[] = [];
  try {
    const path = join(dir, "eval.sqlite");
    new EvalStore(path).close();
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    await runEvalCli(["migrate", "--eval-db", path, "--dry-run"]);
    const report = JSON.parse(logs.join("\n"));
    assert.equal(report.dryRun, true);
    assert.equal(report.toVersion, "4");
    assert.equal(report.migrated, false);
  } finally { console.log = log; await rm(dir, { recursive: true, force: true }); }
});

test("CLI reports incomplete legacy builds without model configuration and only explicit partial mode freezes known probes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-legacy-partial-cli-"));
  try {
    const evalDbPath = join(dir, "eval.sqlite"), mainDbPath = join(dir, "main.sqlite");
    await mainFixture(mainDbPath);
    const store = new EvalStore(evalDbPath);
    try {
      await importTestSources({ evalStore: store, mainDbPath, videoKeys: ["BV_SCOPE_A"] });
      const source = store.listSourceMaterials()[0]!;
      const origin = store.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
      const id = store.createProbe({ runId: origin, sourceMaterialId: source.id, slotIndex: 1, probeType: "answer", persona: "学生", targetTurns: 1, question: "旧问题？", anchor: "结构决定位置", trap: "泛化", anchorVerified: true });
      store.saveProbeTurn({ probeId: id, turnNo: 1, expectedBehavior: "answer", userContent: "旧问题？", referenceAnswer: "旧答案", rubric });
      store.setProbeStatus(id, "accepted");
      store.setProbeDifficulty(id, "medium");
      store.finishRun(origin, "completed");
      store.migrateLegacyBuildPlans();
    } finally { store.close(); }
    const args = ["--import", "tsx", "src/cli/index.ts", "eval", "make", "--eval-db", evalDbPath, "--main-db", mainDbPath, "--suite", "legacy-known", "--video", "BV_SCOPE_A"];
    const options = { cwd: process.cwd(), encoding: "utf8" as const, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } };
    const stopped = spawnSync(process.execPath, args, options);
    assert.equal(stopped.status, 1);
    assert.match(stopped.stdout, /build_partial/);
    assert.equal(JSON.parse(stopped.stdout).freeze.skipped, true);
    const partial = spawnSync(process.execPath, [...args, "--allow-partial-build"], options);
    assert.equal(partial.status, 0, partial.stderr);
    assert.equal(JSON.parse(partial.stdout).freeze.itemCount, 1);
    const read = new EvalStore(evalDbPath, { readOnly: true });
    try {
      const manifest = read.getSuite("legacy-known")!.manifest;
      assert.equal(manifest.partialBuild, true);
      assert.equal((manifest.buildOmissions as unknown[]).length, 1);
      assert.equal(read.getSummary().agentCalls, 0);
    } finally { read.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("make preserves all selected video chunks and excludes previously imported sources outside the scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-source-scope-"));
  try {
    const evalDbPath = join(dir, "eval.sqlite"), mainDbPath = join(dir, "main.sqlite");
    await mainFixture(mainDbPath);
    const main = new DataMakerStore(mainDbPath);
    try { main.upsertMaterial({ videoId: "BV_SCOPE_A/P002", content: "结构决定位置，位置形成判断。第二个分块。" }); }
    finally { main.close(); }
    const common = { evalDbPath, mainDbPath, modelId: "builder", bareModel: "bare", graderModel: "judge", callMaxAttempts: 1, concurrency: 1, runRole: fixtureRole(() => false), runBareModel: async () => "裸答", runGrader: async () => grade };
    await makeEvalSuiteWorkflow({ ...common, noFreeze: true, videoKeys: ["BV_SCOPE_B"] });
    const result = await makeEvalSuiteWorkflow({ ...common, suiteName: "chunks", videoKeys: ["BV_SCOPE_A"], limit: 1 });
    assert.ok(!("skipped" in result.build));
    assert.equal(result.build.sourcesProcessed, 2, "limit selects one video with both source chunks");
    assert.ok(!("skipped" in result.freeze));
    assert.equal(result.freeze.itemCount, 2);
    assert.deepEqual(result.freeze.byVideo, { BV_SCOPE_A: 2 });
    const read = new EvalStore(evalDbPath, { readOnly: true });
    try { assert.equal(read.listProbes({ executionRunId: result.build.runId }).every((probe) => read.getSourceMaterial(probe.sourceMaterialId)?.videoKey === "BV_SCOPE_A"), true); }
    finally { read.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("production build requests use the explicitly selected model recorded in the persisted build plan", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const outputs = ['{"probes":[]}', "结构决定位置。", JSON.stringify({ decision: "pass", rubric })];
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: outputs[requests.length - 1] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const env = { EVAL_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, EVAL_LLM_API_KEY: "fixture-key", EVAL_LLM_MODEL: "current-environment-model", LLM_THINKING_LEVEL: "off" };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const dir = await mkdtemp(join(tmpdir(), "eval-production-build-model-"));
  try {
    const evalDbPath = join(dir, "eval.sqlite"), mainDbPath = join(dir, "main.sqlite");
    await mainFixture(mainDbPath);
    const result = await makeEvalSuiteWorkflow({ evalDbPath, mainDbPath, videoKeys: ["BV_SCOPE_A"], modelId: "selected-build-model", noFreeze: true, callMaxAttempts: 1, concurrency: 1 });
    assert.equal(requests.length, 1);
    const store = new EvalStore(evalDbPath, { readOnly: true });
    try { assert.equal(requests[0]?.model, store.listBuildPlans()[0]?.spec?.modelId); }
    finally { store.close(); }
    assert.equal(requests[0]?.model, "selected-build-model");
    assert.ok(!("skipped" in result.build) && result.build.plansComplete);
    // An explicitly selected older generation must determine whether work remains.
    const common = { evalDbPath, mainDbPath, videoKeys: ["BV_SCOPE_A"], noFreeze: true, modelId: "selected-build-model", bareModel: "bare", graderModel: "judge", callMaxAttempts: 1, concurrency: 1, runBareModel: async () => "裸答", runGrader: async () => grade };
    const oldPartial = await makeEvalSuiteWorkflow({ ...common, rebuild: true, runRole: fixtureRole(() => true) });
    assert.ok(!("skipped" in oldPartial.build) && oldPartial.build.partial);
    await makeEvalSuiteWorkflow({ ...common, rebuild: true, runRole: fixtureRole(() => false) });
    const resumedOld = await makeEvalSuiteWorkflow({ ...common, resumeBuildRunId: oldPartial.build.runId });
    assert.ok(!("skipped" in resumedOld.build) && resumedOld.build.plansComplete);
    assert.equal(requests.length, 3, "resume contacts reference/verifier from the selected old generation");
    assert.equal(requests.every((request) => request.model === "selected-build-model"), true);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});

test("rebuild creates a new generation and an execution-scoped suite while preserving prior accepted probes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-workflow-rebuild-"));
  try {
    const evalDbPath = join(dir, "eval.sqlite"), mainDbPath = join(dir, "main.sqlite");
    await mainFixture(mainDbPath);
    const common = { evalDbPath, mainDbPath, videoKeys: ["BV_SCOPE_A"], modelId: "builder", bareModel: "bare", graderModel: "judge", callMaxAttempts: 1, concurrency: 1, runRole: fixtureRole(() => false), runBareModel: async () => "裸答", runGrader: async () => grade };
    const first = await makeEvalSuiteWorkflow({ ...common, noFreeze: true });
    const rebuilt = await makeEvalSuiteWorkflow({ ...common, rebuild: true, suiteName: "generation-2" });
    assert.ok(!("skipped" in first.build) && !("skipped" in rebuilt.build));
    assert.equal(rebuilt.build.newProbes, 1);
    assert.notDeepEqual(rebuilt.build.planIds, first.build.planIds);
    assert.ok(!("skipped" in rebuilt.freeze));
    assert.equal(rebuilt.freeze.itemCount, 1);
    const store = new EvalStore(evalDbPath, { readOnly: true });
    try {
      assert.equal(store.listBuildPlans().at(-1)?.generation, 2);
      assert.equal(store.getProbe(first.build.probeIds[0]!)?.status, "accepted");
      assert.deepEqual(store.getSuite("generation-2")!.manifest.probeIds, rebuilt.build.probeIds);
      assert.equal(store.listProbes({ status: "accepted" }).length, 2);
    } finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("make stops automatic freezing on a partial build and resumes the same probe through execution selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-workflow-resume-"));
  try {
    const evalDbPath = join(dir, "eval.sqlite"), mainDbPath = join(dir, "main.sqlite");
    await mainFixture(mainDbPath);
    let fail = true;
    const common = { evalDbPath, mainDbPath, suiteName: "scoped", videoKeys: ["BV_SCOPE_A"], modelId: "builder", bareModel: "bare", graderModel: "judge", callMaxAttempts: 1, concurrency: 1, runRole: fixtureRole(() => fail), runBareModel: async () => "裸答", runGrader: async () => grade };
    const first = await makeEvalSuiteWorkflow(common);
    assert.ok(!("skipped" in first.build));
    assert.equal(first.build.partial, true);
    assert.equal("skipped" in first.freeze, true, "a technical failure must stop automatic freezing");
    const originalId = first.build.probeIds[0]!;
    fail = false;
    const resumed = await makeEvalSuiteWorkflow({ ...common, resumeBuildRunId: first.build.runId });
    assert.ok(!("skipped" in resumed.build));
    assert.equal(resumed.build.partial, false);
    assert.equal(resumed.build.newProbes, 0);
    assert.equal(resumed.build.resumedSlots, 1);
    assert.ok(!("skipped" in resumed.calibrate));
    assert.equal(resumed.calibrate.calibrated, 1);
    assert.ok(!("skipped" in resumed.freeze));
    assert.equal(resumed.freeze.itemCount, 1);
    const read = new EvalStore(evalDbPath, { readOnly: true });
    try {
      assert.equal(read.listProbes({ executionRunId: resumed.build.runId })[0]?.id, originalId);
      const manifest = read.getSuite("scoped")!.manifest;
      assert.deepEqual(manifest.executionRunIds, [resumed.build.runId]);
      assert.deepEqual(manifest.buildPlanIds, resumed.build.planIds);
    } finally { read.close(); }
    const inspected = await inspectEvalProbesWorkflow({ evalDbPath, executionRunSpec: "latest" });
    assert.equal(inspected.summary.matched, 1);
    assert.match(inspected.markdown, /执行 Run ID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
