import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runReasoningBackfill } from "../src/reasoning/engine.js";
import { ReasoningStore } from "../src/reasoning/store.js";
import type { RoleRequest, Skill } from "../src/shared/types.js";
import { runDialogueBatch } from "../src/synth/dialogue-loop.js";
import { DataMakerStore } from "../src/synth/store/index.js";
import { storeConnection } from "./fixtures/store-connection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const skill: Skill = { body: "fixture", status: "ready", sha256: "fixture" };

test("already-aborted reasoning creates no run and invokes no writer", async (t) => {
  const store = new ReasoningStore(":memory:");
  t.after(() => store.close());
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(runReasoningBackfill({
    store,
    signal: controller.signal,
    candidates: [],
    writerPrompt: "补写",
    writerSkill: skill,
    writerSkillPath: "fixture",
    writerModel: "fixture",
    runWriter: async () => { calls++; return "late"; },
  }), /operation_aborted/);
  assert.equal(calls, 0);
  assert.equal(store.getLatestReasoningRunId(), undefined);
});

test("reasoning store cancellation drains a late writer without judging, retrying, rewriting, or dispatching another turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "data-maker-reasoning-cancel-"));
  const dbPath = join(directory, "fixture.sqlite");
  const source = new DataMakerStore(dbPath);
  let runId: number;
  try {
    const material = source.upsertMaterial({ videoId: "fixture", content: "测试材料" });
    for (let i = 1; i <= 2; i++) source.insertQuestion({ materialId: material.id, question: `问题${i}` });
    const summary = await runDialogueBatch({
      store: source,
      prompts: { answer: "回答", judge: "质检" },
      runRole: async ({ role }) => role === "answer" ? "一段已通过的回答。" : '{"decision":"pass","issues":[],"feedback":""}',
      maxAttempts: 1,
      maxTurns: 1,
      config: {},
    });
    runId = summary.runId;
  } finally { source.close(); }
  const store = new ReasoningStore(dbPath);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const candidates = store.queryCandidateTurns({ allFormal: false, runIds: [runId] });
  assert.equal(candidates.length, 2);
  const controller = new AbortController();
  const started = deferred<RoleRequest>();
  const release = deferred<string>();
  let writerCalls = 0;
  let judgeCalls = 0;
  let progressCalls = 0;
  const operation = runReasoningBackfill({
    store,
    signal: controller.signal,
    candidates,
    writerPrompt: "补写",
    writerSkill: skill,
    writerSkillPath: "fixture",
    judgePrompt: "质检",
    judgeSkill: skill,
    writerModel: "fixture",
    concurrency: 1,
    callMaxAttempts: 3,
    callRetryDelayMs: 0,
    maxRewrites: 2,
    runWriter: async (request) => { writerCalls++; started.resolve(request); return release.promise; },
    runJudge: async () => { judgeCalls++; return '{"decision":"pass","issues":[],"feedback":""}'; },
    onProgress: () => { progressCalls++; },
  });
  const rejected = assert.rejects(operation, /operation_aborted/);
  const request = await started.promise;
  store.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const statusBeforeDrain = store.getReasoningRun(1)?.status;
  const signalAborted = request.signal?.aborted;
  release.resolve("先识别提问的核心关系，拆开前提和推论，再沿着具体条件逐步检查，最后给出明确落点。");
  await rejected;
  assert.equal(statusBeforeDrain, "running");
  assert.equal(signalAborted, true);
  assert.equal(writerCalls, 1);
  assert.equal(judgeCalls, 0);
  assert.equal(progressCalls, 0);
  assert.equal(store.getReasoningRun(1)?.status, "interrupted");
  assert.equal(store.getPassedReasoningMap(1).size, 0);
  assert.equal(storeConnection(store).prepare("SELECT COUNT(*) AS n FROM reasoning_traces WHERE status = 'running'").get()?.n, 0);
});
