import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSuiteEvaluation } from "../src/eval/eval-runner.js";
import { bindCandidate, createOpenAiCandidateRunner } from "../src/eval/candidate-client.js";
import { gradeEvalRun } from "../src/eval/eval-grader.js";
import { storeConnection } from "./fixtures/store-connection.js";
import { resolveEvaluationSpec } from "../src/eval/evaluation-spec.js";
import { EvalStore } from "../src/eval/store/index.js";
import { PublicError } from "../src/shared/public-error.js";

async function httpFixture(t: test.TestContext, options: { status?: number } = {}) {
  const requests: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      path: req.url!,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(options.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "<think>internal</think>final answer" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/candidate/v1`, requests };
}

function suiteFixture(t: test.TestContext) {
  const store = new EvalStore(":memory:");
  t.after(() => store.close());
  const { suite } = store.freezeSuite({
    name: "immutable-v1",
    sha256: "a".repeat(64),
    manifest: {},
    items: [
      {
        itemKey: "probe:1", videoKey: "video-1", probeType: "hold_position", messages: [
          { role: "user", content: "question one" },
          { role: "assistant", content: "reference one" },
          { role: "user", content: "question two" },
          { role: "assistant", content: "reference two" },
        ], rubrics: [],
      },
      {
        itemKey: "probe:2", videoKey: "video-2", probeType: "answer", messages: [
          { role: "user", content: "other question" },
          { role: "assistant", content: "other reference" },
        ], rubrics: [],
      },
    ],
  });
  return { store, suite };
}

test("new evaluation binds real HTTP requests and stored identity to one immutable specification", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  const summary = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "candidate-A", modelId: "model-A",
    baseUrl: `${baseUrl}/`, apiKey: "fixture-key", temperature: 0.35, maxTokens: 713,
    historyMode: "self", systemPrompt: "system A", limit: 1, stripThinkTags: true,
    timeoutMs: 2_000, concurrency: 1, callMaxAttempts: 1, environment: {},
  });
  assert.equal(summary.completedTurns, 2);
  assert.deepEqual(requests.map(({ path, body }) => ({ path, body })), [
    { path: "/candidate/v1/chat/completions", body: {
      model: "model-A", temperature: 0.35, max_tokens: 713, stream: false,
      messages: [{ role: "system", content: "system A" }, { role: "user", content: "question one" }],
    } },
    { path: "/candidate/v1/chat/completions", body: {
      model: "model-A", temperature: 0.35, max_tokens: 713, stream: false,
      messages: [
        { role: "system", content: "system A" }, { role: "user", content: "question one" },
        { role: "assistant", content: "final answer" }, { role: "user", content: "question two" },
      ],
    } },
  ]);
  const run = store.getEvalRun(summary.evalRunId)!;
  const spec = run.config.evaluationSpec as Record<string, unknown>;
  assert.equal(spec.endpoint, baseUrl);
  assert.equal(spec.modelId, "model-A");
  assert.equal(spec.temperature, 0.35);
  assert.equal(spec.maxTokens, 713);
  assert.deepEqual(spec.itemIds, [store.listSuiteItems(suite.id)[0]!.id]);
  assert.equal(spec.systemPrompt, "system A");
  assert.equal(spec.stripThinkTags, true);
  assert.equal(summary.specHash, spec.hash);
  assert.equal(JSON.stringify(run.config).includes("fixture-key"), false);
});

test("resume ignores current identity defaults and reuses self history, selection, prompt and sampling", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  const first = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "candidate-A", modelId: "model-A", baseUrl,
    temperature: 0.35, maxTokens: 713, historyMode: "self", systemPrompt: "system A", limit: 1,
    callMaxAttempts: 1, environment: {},
  });
  const item = store.listSuiteItems(suite.id)[0]!;
  store.saveEvalPrediction({ evalRunId: first.evalRunId, suiteItemId: item.id, turnNo: 2, input: {}, error: "interrupted" });
  store.finishEvalRun(first.evalRunId, "interrupted", "fixture interruption");
  requests.length = 0;
  const resumed = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "candidate-A", resumeRunId: first.evalRunId,
    apiKey: "rotated-key", timeoutMs: 1_000, concurrency: 2, callMaxAttempts: 2, callRetryDelayMs: 1,
    environment: { CANDIDATE_LLM_MODEL: "model-B", CANDIDATE_LLM_BASE_URL: "http://127.0.0.1:1/other", CANDIDATE_LLM_MAX_TOKENS: "99" },
  });
  assert.equal(resumed.specHash, first.specHash);
  assert.equal(resumed.historyMode, "self");
  assert.equal(resumed.totalItems, 1);
  assert.equal(resumed.skippedExistingTurns, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.body, {
    model: "model-A", temperature: 0.35, max_tokens: 713, stream: false,
    messages: [
      { role: "system", content: "system A" }, { role: "user", content: "question one" },
      { role: "assistant", content: "final answer" }, { role: "user", content: "question two" },
    ],
  });
  assert.equal(requests[0]!.authorization, "Bearer rotated-key");
  const operational = store.getEvalRun(first.evalRunId)!.config.operationalExecutions as Array<Record<string, unknown>>;
  assert.equal(operational.length, 2);
  assert.deepEqual({
    timeoutMs: operational[1]!.timeoutMs, concurrency: operational[1]!.concurrency,
    callMaxAttempts: operational[1]!.callMaxAttempts, callRetryDelayMs: operational[1]!.callRetryDelayMs,
  }, { timeoutMs: 1_000, concurrency: 2, callMaxAttempts: 2, callRetryDelayMs: 1 });
  assert.equal(JSON.stringify(operational).includes("rotated-key"), false);
});

test("explicit resume conflicts fail before HTTP, recovery or run state changes", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  const initial = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "candidate-A", modelId: "model-A", baseUrl,
    temperature: 0.35, maxTokens: 713, historyMode: "self", systemPrompt: "system A", limit: 1,
    callMaxAttempts: 1, environment: {},
  });
  store.finishEvalRun(initial.evalRunId, "interrupted", "keep this evidence");
  const before = store.getEvalRun(initial.evalRunId);
  const predictions = store.listEvalPredictions(initial.evalRunId);
  requests.length = 0;
  for (const conflict of [
    { modelId: "model-B" }, { baseUrl: `${baseUrl}/other` }, { historyMode: "gold" as const },
    { systemPrompt: null }, { systemPrompt: "system B" }, { temperature: 0 }, { maxTokens: 99 },
    { stripThinkTags: false }, { limit: 2 }, { itemIds: [store.listSuiteItems(suite.id)[1]!.id] },
    { adapterContractVersion: "other/v1" },
  ]) {
    await assert.rejects(runSuiteEvaluation({
      evalStore: store, suiteName: suite.name, candidate: "candidate-A", resumeRunId: initial.evalRunId,
      ...conflict, environment: {},
    }), /resume_config_conflict/);
    assert.deepEqual(store.getEvalRun(initial.evalRunId), before);
    assert.deepEqual(store.listEvalPredictions(initial.evalRunId), predictions);
  }
  assert.equal(requests.length, 0);
});

test("conflicting orphan resume leaves its running state untouched before recovery", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const directory = await mkdtemp(join(tmpdir(), "eval-spec-orphan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "eval.sqlite");
  const oldStore = new EvalStore(path);
  let id: number;
  try {
    const { suite } = oldStore.freezeSuite({
      name: "orphan-v1", sha256: "c".repeat(64), manifest: {}, items: [{
        itemKey: "orphan:1", videoKey: "orphan-video", probeType: "answer", rubrics: [],
        messages: [{ role: "user", content: "question" }, { role: "assistant", content: "reference" }],
      }],
    });
    const result = await runSuiteEvaluation({
      evalStore: oldStore, suiteName: suite.name, candidate: "orphan", modelId: "model-A", baseUrl,
      callMaxAttempts: 1, environment: {},
    });
    id = result.evalRunId;
    oldStore.reopenEvalRun(id);
  } finally { oldStore.close(); }
  const store = new EvalStore(path);
  try {
    const before = store.getEvalRun(id!)!;
    assert.equal(before.status, "running");
    requests.length = 0;
    await assert.rejects(runSuiteEvaluation({
      evalStore: store, suiteName: "orphan-v1", candidate: "orphan", resumeRunId: id!, modelId: "model-B", environment: {},
    }), /resume_config_conflict/);
    assert.deepEqual(store.getEvalRun(id!), before);
    assert.equal(requests.length, 0);
  } finally { store.close(); }
});

test("new spec parsing ignores unrelated environment credentials and operational defaults", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  const summary = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "candidate-A", modelId: "model-A", baseUrl,
    apiKey: "explicit-key", timeoutMs: 1_000, limit: 1, callMaxAttempts: 1,
    environment: { LLM_BASE_URL: "http://127.0.0.1:1/other", LLM_API_KEY: "other-key", LLM_TIMEOUT_MS: "invalid" },
  });
  assert.equal(summary.completedTurns, 2);
  assert.equal(requests[0]!.authorization, "Bearer explicit-key");
});

test("task cancellation closes active candidate HTTP, skips retries and commits no prediction", { timeout: 5_000 }, async (t) => {
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  let responseClosed!: () => void;
  const closed = new Promise<void>((resolve) => { responseClosed = resolve; });
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.once("close", responseClosed);
    requestStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { store, suite } = suiteFixture(t);
  const controller = new AbortController();
  const work = runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "cancelled", modelId: "model-A",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, signal: controller.signal,
    timeoutMs: 300, concurrency: 1, callMaxAttempts: 2, callRetryDelayMs: 1, limit: 1, environment: {},
  });
  await started;
  controller.abort();
  await assert.rejects(work, /operation_aborted/);
  await closed;
  assert.equal(requests, 1);
  const run = store.getLatestEvalRun({ candidate: "cancelled" })!;
  assert.equal(run.status, "failed");
  assert.equal(store.listEvalPredictions(run.id).length, 0);
});

test("store task cancellation reaches the candidate and blocks its late result", async (t) => {
  const { store, suite } = suiteFixture(t);
  let seenSignal: AbortSignal | undefined;
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "session-cancel", modelId: "fixture", baseUrl: "http://fixture.invalid/v1",
    callMaxAttempts: 2, environment: {}, candidateFactory: (spec) => bindCandidate(spec, async ({ signal }) => {
      seenSignal = signal;
      store.abort();
      return "late answer";
    }),
  }), /operation_aborted/);
  assert.equal(seenSignal?.aborted, true);
  const run = store.getLatestEvalRun({ candidate: "session-cancel" })!;
  assert.equal(store.listEvalPredictions(run.id).length, 0);
  assert.equal(store.countAgentCalls(`eval_run:${run.id}`, "candidate"), 1);
});

test("injected candidate receives an attempt deadline and is drained before a retry starts", { timeout: 5_000 }, async (t) => {
  const { store, suite } = suiteFixture(t);
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const summary = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "injected-timeout", modelId: "fixture", baseUrl: "http://fixture.invalid/v1",
    limit: 1, timeoutMs: 20, callMaxAttempts: 2, callRetryDelayMs: 0, environment: {},
    candidateFactory: (spec) => bindCandidate(spec, async ({ signal }) => {
      calls++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (calls === 1) {
          assert.ok(signal);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          assert.equal(signal.reason.code, "model_timeout");
          return "late result";
        }
        return "answer after timeout";
      } finally { active--; }
    }),
  });
  assert.equal(summary.completedTurns, 2);
  assert.equal(summary.totalAgentCalls, 3);
  assert.equal(calls, 3);
  assert.equal(maximumActive, 1);
  assert.equal(store.listEvalPredictions(summary.evalRunId)[0]!.outputText, "answer after timeout");
});

test("cleanup failure stays task-fatal after an injected candidate deadline", { timeout: 3000 }, async (t) => {
  const { store, suite } = suiteFixture(t);
  let attempts = 0;
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "cleanup-fatal", modelId: "model-A", baseUrl: "http://fixture.invalid/v1",
    timeoutMs: 5, callMaxAttempts: 2, callRetryDelayMs: 0, concurrency: 1, environment: {},
    candidateFactory: (spec) => ({
      specHash: spec.hash,
      run: async ({ signal }) => {
        attempts++;
        await new Promise<void>((resolve) => {
          signal!.addEventListener("abort", () => resolve(), { once: true });
          if (signal!.aborted) resolve();
        });
        throw new PublicError("adapter_cleanup_failed");
      },
    }),
  }), /adapter_cleanup_failed/);
  assert.equal(attempts, 1);
  const run = store.getLatestEvalRun({ candidate: "cleanup-fatal" })!;
  assert.equal(run.status, "failed");
  assert.deepEqual(store.listEvalPredictions(run.id), []);
  assert.equal(store.countAgentCalls(`eval_run:${run.id}`, "candidate"), 1);
});

test("legacy identity stays read-only and continuation creates an independent associated run", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  const legacyId = store.createEvalRun({
    suiteId: suite.id, candidate: "legacy", model: "historical-model", historyMode: "self",
    systemPrompt: null, config: { temperature: 0.2 },
  });
  const before = store.getEvalRun(legacyId);
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "legacy", resumeRunId: legacyId,
    modelId: "new-model", baseUrl, temperature: 0.5, maxTokens: 800, environment: {},
  }), /legacy_spec_incomplete/);
  assert.deepEqual(store.getEvalRun(legacyId), before);
  assert.equal(requests.length, 0);
  const continued = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "new-candidate", parentRunId: legacyId,
    modelId: "new-model", baseUrl, temperature: 0.5, maxTokens: 800,
    limit: 1, callMaxAttempts: 1, environment: {},
  });
  assert.notEqual(continued.evalRunId, legacyId);
  assert.equal(continued.resumed, false);
  assert.equal(store.getEvalRun(continued.evalRunId)!.config.parentRunId, legacyId);
  assert.deepEqual(store.getEvalRun(legacyId), before);
  assert.equal(store.listEvalPredictions(legacyId).length, 0);
  assert.equal(store.listEvalPredictions(continued.evalRunId).length, 2);
});

test("explicit null system prompt resumes as disabled and output processing remains bound", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  const first = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "no-prompt", modelId: "model-A", baseUrl,
    systemPrompt: null, stripThinkTags: false, historyMode: "self", limit: 1, callMaxAttempts: 1, environment: {},
  });
  const item = store.listSuiteItems(suite.id)[0]!;
  store.saveEvalPrediction({ evalRunId: first.evalRunId, suiteItemId: item.id, turnNo: 2, input: {}, error: "retry" });
  requests.length = 0;
  await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "no-prompt", resumeRunId: first.evalRunId,
    systemPrompt: null, callMaxAttempts: 1, environment: {},
  });
  assert.deepEqual(requests[0]!.body.messages, [
    { role: "user", content: "question one" },
    { role: "assistant", content: "<think>internal</think>final answer" },
    { role: "user", content: "question two" },
  ]);
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "no-prompt", resumeRunId: first.evalRunId,
    systemPrompt: "enabled", environment: {},
  }), /resume_config_conflict/);
});

test("candidate factory identity mismatch produces no HTTP and no run while explicit binding is supported", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "identity", modelId: "model-A", baseUrl,
    candidateFactory: () => ({ specHash: "wrong", run: async () => "answer" }), environment: {},
  }), /candidate_identity_mismatch/);
  assert.equal(store.listEvalRuns().length, 0);
  assert.equal(requests.length, 0);
  const bound = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "identity", modelId: "model-A", baseUrl,
    candidateFactory: (spec) => {
      assert.ok(Object.isFrozen(spec));
      assert.ok(Object.isFrozen(spec.itemIds));
      return bindCandidate(spec, async ({ temperature, maxTokens }) => `bound ${temperature}/${maxTokens}`);
    },
    temperature: 0.4, maxTokens: 400, callMaxAttempts: 1, environment: {},
  });
  assert.equal(bound.completedTurns, 3);
  assert.equal(store.listEvalPredictions(bound.evalRunId)[0]!.outputText, "bound 0.4/400");
});

test("production adapter validates its contract version before changing evaluation state", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "contract", modelId: "model-A", baseUrl,
    adapterContractVersion: "unknown/v2", environment: {},
  }), /candidate_identity_mismatch/);
  assert.equal(store.listEvalRuns().length, 0);
  assert.equal(requests.length, 0);
});

test("associated continuation validates its parent before creating or changing a run", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "child", modelId: "model-A", baseUrl,
    parentRunId: 999, callMaxAttempts: 1, environment: {},
  }), /parent_run_missing/);
  assert.equal(store.listEvalRuns().length, 0);
  assert.equal(requests.length, 0);
});

test("stored snapshot hash and frozen suite fingerprint are verified before creating an adapter", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  const fields = { candidate: "snapshot", modelId: "model-A", baseUrl };
  const oldSuiteSpec = resolveEvaluationSpec({
    suite: { ...suite, sha256: "b".repeat(64) }, items: store.listSuiteItems(suite.id), requested: fields, environment: {},
  });
  let factoryCalls = 0;
  for (const [snapshot, expectedError] of [
    [oldSuiteSpec, /resume_config_conflict/],
    [{ ...oldSuiteSpec, suiteSha256: suite.sha256 }, /evaluation_spec_invalid/],
  ] as const) {
    const id = store.createEvalRun({
      suiteId: suite.id, candidate: fields.candidate, model: fields.modelId, historyMode: "gold",
      config: { evaluationSpec: snapshot },
    });
    const before = store.getEvalRun(id);
    await assert.rejects(runSuiteEvaluation({
      evalStore: store, suiteName: suite.name, candidate: fields.candidate, resumeRunId: id, environment: {},
      candidateFactory: (spec) => { factoryCalls++; return bindCandidate(spec, async () => "answer"); },
    }), expectedError);
    assert.deepEqual(store.getEvalRun(id), before);
  }
  assert.equal(factoryCalls, 0);
  assert.equal(requests.length, 0);
});

test("ordered item IDs drive requests and a different order conflicts even when the set matches", async (t) => {
  const { baseUrl, requests } = await httpFixture(t);
  const { store, suite } = suiteFixture(t);
  const [first, second] = store.listSuiteItems(suite.id);
  const initial = await runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "ordered", modelId: "model-A", baseUrl,
    itemIds: [second!.id, first!.id], concurrency: 1, callMaxAttempts: 1, environment: {},
  });
  assert.deepEqual(requests.map(({ body }) => (body.messages as Array<{ content: string }>).at(-1)!.content), [
    "other question", "question one", "question two",
  ]);
  requests.length = 0;
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "ordered", resumeRunId: initial.evalRunId,
    itemIds: [first!.id, second!.id], environment: {},
  }), /resume_config_conflict/);
  assert.equal(requests.length, 0);
});

test("cancelling retry delay issues no further candidate requests and preserves cancellation identity", async (t) => {
  const { baseUrl, requests } = await httpFixture(t, { status: 503 });
  const { store, suite } = suiteFixture(t);
  const controller = new AbortController();
  await assert.rejects(runSuiteEvaluation({
    evalStore: store, suiteName: suite.name, candidate: "retry-cancel", modelId: "model-A", baseUrl,
    signal: controller.signal, concurrency: 1, callMaxAttempts: 3, callRetryDelayMs: 1_000,
    environment: {}, onProgress: (message) => { if (message.includes("重试")) controller.abort(); },
  }), /operation_aborted/);
  assert.equal(requests.length, 1);
  const run = store.getLatestEvalRun({ candidate: "retry-cancel" })!;
  assert.equal(store.listEvalPredictions(run.id).length, 0);
});

for (const invalidIdentity of ["incomplete-v2", "bad-hash", "row-model-conflict", "suite-fingerprint-conflict"] as const) {
  test(`store primitives preserve historical evidence for ${invalidIdentity}`, (t) => {
    const { store, suite } = suiteFixture(t);
    const spec = resolveEvaluationSpec({
      suite, items: store.listSuiteItems(suite.id), environment: {},
      requested: { candidate: "guarded", modelId: "fixture-model", baseUrl: "http://fixture.invalid/v1" },
    });
    const savedSpec = invalidIdentity === "incomplete-v2" ? { version: 2, hash: "a".repeat(64) }
      : invalidIdentity === "bad-hash" ? { ...spec, hash: "0".repeat(64) }
      : invalidIdentity === "suite-fingerprint-conflict" ? resolveEvaluationSpec({
        suite: { ...suite, sha256: "b".repeat(64) }, items: store.listSuiteItems(suite.id), environment: {},
        requested: { candidate: "guarded", modelId: "fixture-model", baseUrl: "http://fixture.invalid/v1" },
      }) : spec;
    const id = store.createEvalRun({
      suiteId: suite.id, candidate: "guarded", model: invalidIdentity === "row-model-conflict" ? "other-model" : spec.modelId,
      historyMode: spec.historyMode, systemPrompt: spec.systemPrompt, config: { evaluationSpec: savedSpec },
    });
    const before = store.getEvalRun(id);
    const itemId = store.listSuiteItems(suite.id)[0]!.id;
    const expectedError = /evaluation_spec_invalid/;
    for (const mutate of [
      () => store.saveEvalPrediction({ evalRunId: id, suiteItemId: itemId, turnNo: 1, input: {}, outputText: "new answer" }),
      () => store.finishEvalRun(id, "completed"),
      () => store.reopenEvalRun(id),
      () => store.recordEvaluationExecution(id, { timeoutMs: 200, concurrency: 1, callMaxAttempts: 1, callRetryDelayMs: 0 }),
    ]) {
      assert.throws(mutate, expectedError);
      assert.deepEqual(store.getEvalRun(id), before);
      assert.deepEqual(store.listEvalPredictions(id), []);
      assert.deepEqual(store.listEvalScores(id), []);
    }

    // Seed pre-existing historical evidence directly: the current guarded interface correctly disallows its creation.
    const inserted = storeConnection(store).prepare(`INSERT INTO eval_predictions
      (eval_run_id, suite_item_id, turn_no, input_json, output_text, error, call_id, created_at)
      VALUES (?, ?, 1, '{}', 'historical answer', NULL, NULL, '2026-01-01T00:00:00.000Z')`).run(id, itemId);
    const predictionId = Number(inserted.lastInsertRowid);
    const historicalPredictions = store.listEvalPredictions(id);
    assert.throws(() => store.saveEvalScore({
      predictionId, graderModel: "grader", behaviorOk: true, stance: 2, keyPointCoverage: 1,
      forbiddenHits: 0, hallucinationHits: 0, failureSignalHits: 0, style: 2, score: 90, detail: {},
    }), expectedError);
    assert.deepEqual(store.listEvalScores(id), []);
    assert.deepEqual(store.listEvalPredictions(id), historicalPredictions);
    assert.deepEqual(store.getEvalRun(id), before);
  });
}

test("store prediction writes honor the immutable selected item IDs", (t) => {
  const { store, suite } = suiteFixture(t);
  const [selectedItem, excludedItem] = store.listSuiteItems(suite.id);
  const spec = resolveEvaluationSpec({
    suite, items: store.listSuiteItems(suite.id), environment: {},
    requested: { candidate: "selected-only", modelId: "fixture-model", baseUrl: "http://fixture.invalid/v1", itemIds: [selectedItem!.id] },
  });
  const id = store.createEvalRun({
    suiteId: suite.id, candidate: spec.candidate, model: spec.modelId, historyMode: spec.historyMode,
    systemPrompt: spec.systemPrompt, config: { evaluationSpec: spec },
  });
  const before = store.getEvalRun(id);
  assert.throws(() => store.saveEvalPrediction({
    evalRunId: id, suiteItemId: excludedItem!.id, turnNo: 1,
    input: { specHash: spec.hash }, outputText: "answer for an excluded item",
  }), /evaluation_spec_invalid/);
  assert.deepEqual(store.listEvalPredictions(id), []);
  assert.deepEqual(store.getEvalRun(id), before);
});

test("store score writes reject a historical prediction outside the immutable selection", (t) => {
  const { store, suite } = suiteFixture(t);
  const [selectedItem, excludedItem] = store.listSuiteItems(suite.id);
  const spec = resolveEvaluationSpec({
    suite, items: store.listSuiteItems(suite.id), environment: {},
    requested: { candidate: "selected-score", modelId: "fixture-model", baseUrl: "http://fixture.invalid/v1", itemIds: [selectedItem!.id] },
  });
  const id = store.createEvalRun({
    suiteId: suite.id, candidate: spec.candidate, model: spec.modelId, historyMode: spec.historyMode,
    systemPrompt: spec.systemPrompt, config: { evaluationSpec: spec },
  });
  // Historical corruption fixture: a pre-existing prediction bypassed the selected item constraint.
  const inserted = storeConnection(store).prepare(`INSERT INTO eval_predictions
    (eval_run_id, suite_item_id, turn_no, input_json, output_text, error, call_id, created_at)
    VALUES (?, ?, 1, '{}', 'historical excluded answer', NULL, NULL, '2026-01-01T00:00:00.000Z')`).run(id, excludedItem!.id);
  const before = store.listEvalPredictions(id);
  assert.throws(() => store.saveEvalScore({
    predictionId: Number(inserted.lastInsertRowid), graderModel: "grader", behaviorOk: true,
    stance: 2, keyPointCoverage: 1, forbiddenHits: 0, hallucinationHits: 0,
    failureSignalHits: 0, style: 2, score: 90, detail: {},
  }), /evaluation_spec_invalid/);
  assert.deepEqual(store.listEvalScores(id), []);
  assert.deepEqual(store.listEvalPredictions(id), before);
});

for (const identityConflict of ["candidate", "history", "prompt", "excluded-item", "foreign-suite-item"] as const) {
  test(`grading rejects ${identityConflict} before HTTP or agent-call writes`, async (t) => {
    const { baseUrl, requests } = await httpFixture(t);
    const store = new EvalStore(":memory:");
    t.after(() => store.close());
    const rubric = {
      expectedBehavior: "answer" as const, stance: "answer clearly", keyPoints: ["answer"],
      forbidden: [], mustNotHallucinate: [], failureSignals: [],
    };
    const { suite } = store.freezeSuite({
      name: "grade-preflight-v1", sha256: "f".repeat(64), manifest: {},
      items: ["selected", "excluded"].map((label) => ({
        itemKey: `grade:${label}`, videoKey: `video-${label}`, probeType: "answer" as const,
        messages: [{ role: "user" as const, content: `question ${label}` }, { role: "assistant" as const, content: "reference" }],
        rubrics: [{ turnNo: 1, expectedBehavior: "answer" as const, rubric, tactic: null }],
      })),
    });
    const items = store.listSuiteItems(suite.id);
    let predictionItemId = identityConflict === "excluded-item" ? items[1]!.id : items[0]!.id;
    let specItems = items;
    if (identityConflict === "foreign-suite-item") {
      const foreign = store.freezeSuite({
        name: "grade-foreign-v1", sha256: "e".repeat(64), manifest: {}, items: [{
          itemKey: "foreign:1", videoKey: "foreign-video", probeType: "answer", rubrics: [],
          messages: [{ role: "user", content: "foreign question" }, { role: "assistant", content: "foreign reference" }],
        }],
      }).suite;
      specItems = store.listSuiteItems(foreign.id);
      predictionItemId = specItems[0]!.id;
    }
    const spec = resolveEvaluationSpec({
      suite, items: specItems, environment: {}, requested: {
        candidate: "candidate-A", modelId: "candidate-model", baseUrl, historyMode: "self", systemPrompt: "system-A",
        itemIds: [specItems[0]!.id],
      },
    });
    const id = store.createEvalRun({
      suiteId: suite.id, candidate: identityConflict === "candidate" ? "candidate-B" : spec.candidate,
      model: spec.modelId, historyMode: identityConflict === "history" ? "gold" : spec.historyMode,
      systemPrompt: identityConflict === "prompt" ? "system-B" : spec.systemPrompt, config: { evaluationSpec: spec },
    });
    // Emulate predictions persisted before the stricter identity checks existed.
    storeConnection(store).prepare(`INSERT INTO eval_predictions
      (eval_run_id, suite_item_id, turn_no, input_json, output_text, error, call_id, created_at)
      VALUES (?, ?, 1, '{}', 'historical answer', NULL, NULL, '2026-01-01T00:00:00.000Z')`).run(id, predictionItemId);
    const before = store.getEvalRun(id);
    const historicalPredictions = store.listEvalPredictions(id);
    const grader = createOpenAiCandidateRunner({
      baseUrl, apiKey: "", modelId: "judge-model", temperature: 0, maxTokens: 1024, timeoutMs: 1000, stripThinkTags: true,
    });
    await assert.rejects(gradeEvalRun({
      evalStore: store, evalRunId: id, graderPrompt: "grade answers", graderModelId: "judge-model", callMaxAttempts: 1,
      runGrader: ({ systemPrompt, input, signal }) => grader({
        signal, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify(input) }],
      }),
    }), /evaluation_spec_invalid/);
    assert.deepEqual(requests, []);
    assert.equal(store.countAgentCalls(`eval_run:${id}`, "eval_grader"), 0);
    assert.deepEqual(store.getEvalRun(id), before);
    assert.deepEqual(store.listEvalPredictions(id), historicalPredictions);
    assert.deepEqual(store.listEvalScores(id), []);
  });
}

test("recovery changes only fully verified running evaluations belonging to an older owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eval-spec-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "eval.sqlite");
  const oldStore = new EvalStore(path);
  const unchangedIds: number[] = [];
  let validOldId: number;
  let validUnownedId: number;
  try {
    const { suite } = oldStore.freezeSuite({
      name: "recovery-v1", sha256: "d".repeat(64), manifest: {}, items: [{
        itemKey: "recovery:1", videoKey: "recovery-video", probeType: "answer", rubrics: [],
        messages: [{ role: "user", content: "question" }, { role: "assistant", content: "reference" }],
      }],
    });
    const spec = resolveEvaluationSpec({
      suite, items: oldStore.listSuiteItems(suite.id), environment: {},
      requested: { candidate: "recovery", modelId: "fixture-model", baseUrl: "http://fixture.invalid/v1" },
    });
    const create = (snapshot: unknown, model = spec.modelId) => oldStore.createEvalRun({
      suiteId: suite.id, candidate: spec.candidate, model, historyMode: spec.historyMode,
      systemPrompt: spec.systemPrompt, config: snapshot === undefined ? {} : { evaluationSpec: snapshot },
    });
    validOldId = create(spec);
    validUnownedId = create(spec);
    // Emulate a verified pre-owner historical run from before owner_token was introduced.
    storeConnection(oldStore).prepare("UPDATE eval_runs SET owner_token = NULL WHERE id = ?").run(validUnownedId);
    unchangedIds.push(create(undefined), create({ version: 2, hash: "a".repeat(64) }), create({ ...spec, hash: "0".repeat(64) }), create(spec, "other-model"));
    const missingItemSpec = resolveEvaluationSpec({
      suite, items: oldStore.listSuiteItems(suite.id).map((item) => ({ ...item, id: 999_999 })), environment: {},
      requested: { candidate: spec.candidate, modelId: spec.modelId, baseUrl: spec.endpoint },
    });
    unchangedIds.push(create(missingItemSpec));
    const completed = create(spec);
    oldStore.finishEvalRun(completed, "completed");
    unchangedIds.push(completed);
  } finally { oldStore.close(); }

  const store = new EvalStore(path);
  try {
    const suite = store.getSuite("recovery-v1")!;
    const currentSpec = resolveEvaluationSpec({
      suite, items: store.listSuiteItems(suite.id), environment: {},
      requested: { candidate: "current", modelId: "fixture-model", baseUrl: "http://fixture.invalid/v1" },
    });
    const currentId = store.createEvalRun({
      suiteId: suite.id, candidate: currentSpec.candidate, model: currentSpec.modelId,
      historyMode: currentSpec.historyMode, systemPrompt: currentSpec.systemPrompt,
      config: { evaluationSpec: currentSpec },
    });
    unchangedIds.push(currentId);
    const before = unchangedIds.map((id) => store.getEvalRun(id));
    assert.equal(store.ensureRecovered(), 2);
    assert.equal(store.getEvalRun(validOldId!)!.status, "interrupted");
    assert.equal(store.getEvalRun(validUnownedId!)!.status, "interrupted");
    assert.deepEqual(unchangedIds.map((id) => store.getEvalRun(id)), before);
    const recoveredRuns = store.listEvalRuns();
    assert.equal(store.ensureRecovered(), 0);
    assert.deepEqual(store.listEvalRuns(), recoveredRuns);
  } finally { store.close(); }
});
