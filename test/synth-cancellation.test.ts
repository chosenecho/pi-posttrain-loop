import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PublicError } from "../src/shared/public-error.js";
import { runCorpusQuestionGeneration } from "../src/synth/corpus-questions.js";
import { runDialogueBatch } from "../src/synth/dialogue-loop.js";
import { DataMakerStore } from "../src/synth/store/index.js";
import { storeConnection } from "./fixtures/store-connection.js";
import type { RoleRequest } from "../src/shared/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function seedQuestions(store: DataMakerStore, count = 3): void {
  const material = store.upsertMaterial({ videoId: "cancel-fixture", content: "取消测试材料" });
  for (let i = 1; i <= count; i++) store.insertQuestion({ materialId: material.id, question: `问题${i}` });
}

function runStatus(store: DataMakerStore): unknown {
  return storeConnection(store).prepare("SELECT status FROM runs ORDER BY id DESC LIMIT 1").get()?.status;
}

test("already-aborted dialogue and corpus calls create no runs or invoke adapters", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  seedQuestions(store);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(runDialogueBatch({
    store,
    signal: controller.signal,
    runRole: async () => { calls++; return "late"; },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 1,
    maxTurns: 1,
    config: {},
  }), /operation_aborted/);
  await assert.rejects(runCorpusQuestionGeneration({
    store,
    signal: controller.signal,
    config: { baseUrl: "http://fixture.invalid/v1", apiKey: "fixture", modelId: "fixture", maxTokens: 256, contextWindow: 32768, timeoutMs: 1000 },
    systemPrompt: "出题",
    skills: [],
    candidates: [],
    concurrency: 1,
    createRunner: () => async () => { calls++; return "late"; },
  }), /operation_aborted/);
  assert.equal(calls, 0);
  assert.equal(storeConnection(store).prepare("SELECT COUNT(*) AS n FROM runs").get()?.n, 0);
});

test("dialogue cancellation does not retry a failed adapter or start the next question", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  seedQuestions(store);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runDialogueBatch({
    store,
    signal: controller.signal,
    runRole: async () => {
      calls++;
      controller.abort();
      throw new Error("transient adapter failure");
    },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 1,
    maxTurns: 1,
    callMaxAttempts: 3,
    callRetryDelayMs: 0,
    config: {},
  }), /operation_aborted/);
  assert.equal(calls, 1);
  assert.equal(runStatus(store), "interrupted");
});

test("cancelling after a passed question keeps its result and interrupts the undispatched questions in the same run", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  seedQuestions(store);
  const controller = new AbortController();
  const roles: string[] = [];
  await assert.rejects(runDialogueBatch({
    store,
    signal: controller.signal,
    runRole: async ({ role }) => {
      roles.push(role);
      return role === "answer" ? "已经通过的回答" : '{"decision":"pass","issues":[],"feedback":""}';
    },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 1,
    maxTurns: 1,
    config: {},
    onProgress: () => controller.abort(),
  }), /operation_aborted/);
  assert.deepEqual(roles, ["answer", "judge"]);
  assert.deepEqual(store.exportRunSamples(1), [{ messages: [
    { role: "user", content: "问题1" },
    { role: "assistant", content: "已经通过的回答" },
  ] }]);
  assert.deepEqual(store.queryOutcomeCounts(1), { pass: 1, interrupted: 2 });
  assert.equal(runStatus(store), "interrupted");
});

test("store cancellation stops search warmup waiters while preserving already passed results", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  seedQuestions(store);
  const baseline = await runDialogueBatch({
    store,
    runRole: async ({ role }) => role === "answer" ? "已通过的回答" : '{"decision":"pass","issues":[],"feedback":""}',
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 1,
    maxTurns: 1,
    questionIds: [1],
    config: {},
  });
  const before = store.exportRunSamples(baseline.runId);
  const started = deferred<RoleRequest>();
  const release = deferred<void>();
  const controller = new AbortController();
  let searches = 0;
  let judges = 0;
  const operation = runDialogueBatch({
    store,
    signal: controller.signal,
    runSearchAnswer: async (request) => {
      searches++;
      started.resolve(request);
      await release.promise;
      return { answer: "迟到搜索回答", toolSteps: [] };
    },
    runRole: async () => { judges++; return '{"decision":"pass","issues":[],"feedback":""}'; },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 1,
    maxTurns: 1,
    concurrency: 2,
    callMaxAttempts: 3,
    callRetryDelayMs: 0,
    config: {},
  });
  const rejected = assert.rejects(operation, /operation_aborted/);
  const request = await started.promise;
  store.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const statusBeforeDrain = runStatus(store);
  const signalAborted = request.signal?.aborted;
  release.resolve();
  await rejected;
  assert.equal(statusBeforeDrain, "running");
  assert.equal(signalAborted, true);
  assert.equal(searches, 1, "waiting warmup peers never call the search adapter");
  assert.equal(judges, 0);
  assert.deepEqual(store.exportRunSamples(baseline.runId), before);
  assert.equal(store.exportRunSamples(2).length, 0);
  assert.equal(runStatus(store), "interrupted");
});

test("dialogue cancellation drains an ignoring runner before finishing and dispatches no next question or retry", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  seedQuestions(store);
  const controller = new AbortController();
  const started = deferred<RoleRequest>();
  const release = deferred<string>();
  const seen: RoleRequest[] = [];
  const operation = runDialogueBatch({
    store,
    signal: controller.signal,
    runRole: async (request) => {
      seen.push(request);
      started.resolve(request);
      return release.promise;
    },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 2,
    maxTurns: 1,
    callMaxAttempts: 3,
    callRetryDelayMs: 0,
    config: {},
  });
  const rejected = assert.rejects(operation, /operation_aborted/);
  const request = await started.promise;
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const signalAborted = request.signal?.aborted;
  const statusBeforeDrain = runStatus(store);
  const dispatchedBeforeDrain = seen.length;
  release.resolve("取消之后才返回的回答");
  await rejected;
  assert.equal(signalAborted, true);
  assert.equal(statusBeforeDrain, "running", "run remains open until adapter actually settles");
  assert.equal(dispatchedBeforeDrain, 1);
  assert.equal(seen.length, 1, "no judge, retry, or next question after cancellation");
  assert.equal(runStatus(store), "interrupted");
  assert.equal(store.exportRunSamples(1).length, 0);
  for (const table of ["runs", "run_items", "turns", "attempts", "model_calls"]) {
    assert.equal(storeConnection(store).prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'running'`).get()?.n, 0, table);
  }
});

test("fatal dialogue cancellation aborts peers and finishes the run only after every active adapter settles", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  for (let i = 1; i <= 3; i++) {
    const material = store.upsertMaterial({ videoId: `peer-${i}`, content: `材料${i}` });
    store.insertQuestion({ materialId: material.id, question: `问题${i}` });
  }
  const firstStarted = deferred<void>();
  const secondStarted = deferred<RoleRequest>();
  const cancelFirst = deferred<void>();
  const releasePeer = deferred<string>();
  let calls = 0;
  const operation = runDialogueBatch({
    store,
    runRole: async (request) => {
      calls++;
      if (request.input.question === "问题1") {
        firstStarted.resolve();
        await cancelFirst.promise;
        throw new PublicError("operation_aborted");
      }
      secondStarted.resolve(request);
      return releasePeer.promise;
    },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 1,
    maxTurns: 1,
    concurrency: 2,
    config: {},
  });
  const rejected = assert.rejects(operation, /operation_aborted/);
  await firstStarted.promise;
  const peer = await secondStarted.promise;
  cancelFirst.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const peerAborted = peer.signal?.aborted;
  const statusBeforeDrain = runStatus(store);
  releasePeer.resolve("peer late success");
  await rejected;
  assert.equal(peerAborted, true);
  assert.equal(statusBeforeDrain, "running");
  assert.equal(calls, 2, "third question is never dispatched");
  assert.equal(runStatus(store), "interrupted");
  assert.equal(store.exportRunSamples(1).length, 0);
});

test("search audit callbacks retain failed and cancelled tool attempts across call retries without creating training steps", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  seedQuestions(store, 1);
  const controller = new AbortController();
  let calls = 0;
  let callbackType: string | undefined;
  await assert.rejects(runDialogueBatch({
    store,
    signal: controller.signal,
    runRole: async () => { throw new Error("judge must not run"); },
    runSearchAnswer: async (request) => {
      calls++;
      callbackType = typeof request.onToolAttempt;
      const attempt = {
        attemptId: `audit-${calls}`,
        batchId: 1,
        toolCallId: `call-${calls}`,
        sourceIndex: 0,
        toolName: "web_search",
        arguments: { query: "fixture" },
      };
      request.onToolAttempt?.({ ...attempt, status: "attempted" });
      if (calls === 1) {
        request.onToolAttempt?.({ ...attempt, status: "failed", durationMs: 2, errorCode: "model_timeout" });
        throw new Error("retryable model timeout");
      }
      controller.abort();
      request.onToolAttempt?.({ ...attempt, status: "cancelled", durationMs: 1, errorCode: "operation_aborted" });
      return { answer: "late", toolSteps: [] };
    },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 1,
    maxTurns: 1,
    callMaxAttempts: 3,
    callRetryDelayMs: 0,
    config: {},
  }), /operation_aborted/);
  assert.equal(callbackType, "function");
  assert.equal(calls, 2);
  const audit = store.listToolAttemptAudit(1);
  assert.deepEqual(audit.map(({ attemptId, status }) => ({ attemptId, status })), [
    { attemptId: "audit-1", status: "failed" },
    { attemptId: "audit-2", status: "cancelled" },
  ]);
  assert.equal(storeConnection(store).prepare("SELECT COUNT(*) AS n FROM attempt_tool_steps").get()?.n, 0);
  assert.equal(store.exportRunSamples(1).length, 0);
});

test("corpus cancellation stops late save_questions and drains before finishing without a retry or next video", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "data-maker-corpus-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.md");
  await writeFile(file, "# 取消测试\n临时测试材料");
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  const controller = new AbortController();
  const started = deferred<RoleRequest>();
  const release = deferred<void>();
  let calls = 0;
  let lateSaveError: unknown;
  const operation = runCorpusQuestionGeneration({
    store,
    signal: controller.signal,
    config: { baseUrl: "http://fixture.invalid/v1", apiKey: "fixture", modelId: "fixture", maxTokens: 256, contextWindow: 32768, timeoutMs: 1000 },
    systemPrompt: "出题",
    skills: [],
    candidates: ["first", "second"].map((videoId) => ({ videoId, sourceGroup: "single", sourcePath: file, partPaths: [file] })),
    concurrency: 1,
    callMaxAttempts: 3,
    callRetryDelayMs: 0,
    createRunner: (tools: AgentTool[]) => async (request) => {
      calls++;
      started.resolve(request);
      await release.promise;
      try {
        await tools[0].execute("late", { video_id: request.input.video_id, questions: ["迟到的问题"] });
      } catch (error) { lateSaveError = error; }
      return "late output";
    },
  });
  const rejected = assert.rejects(operation, /operation_aborted/);
  const request = await started.promise;
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const statusBeforeDrain = runStatus(store);
  const signalAborted = request.signal?.aborted;
  release.resolve();
  await rejected;
  assert.equal(statusBeforeDrain, "running");
  assert.equal(signalAborted, true);
  assert.match(String(lateSaveError), /operation_aborted/);
  assert.equal(calls, 1);
  assert.equal(storeConnection(store).prepare("SELECT COUNT(*) AS n FROM questions").get()?.n, 0);
  assert.equal(runStatus(store), "interrupted");
  assert.equal(storeConnection(store).prepare("SELECT COUNT(*) AS n FROM model_calls WHERE status = 'running'").get()?.n, 0);
});
