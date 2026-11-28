import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchAgentTool } from "../src/shared/web-search.js";
import { createWarmupGate, runConcurrentPool } from "../src/shared/concurrency.js";
import { setImmediate as nextTick } from "node:timers/promises";
import { runWithRetry } from "../src/shared/retry.js";
import { rethrowIfAborted } from "../src/shared/cancellation.js";
import { PublicError } from "../src/shared/public-error.js";
import { createCallBudget } from "../src/shared/call-budget.js";
import { createQuestionAgentTool, createQuestionnaireAgentTool, createTodoAgentTool } from "../src/shared/pi-tools.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a concurrent search batch claims its cap before awaiting the runner and keeps failed claims", async () => {
  const release = deferred();
  let calls = 0;
  const tool = createWebSearchAgentTool(async () => {
    calls++;
    await release.promise;
    throw new Error("fixture failure");
  }, { maxCalls: 1 });
  const batch = ["a", "b", "c"].map((id) => tool.execute(id, { query: id }));
  assert.equal(calls, 1);
  release.resolve();
  await Promise.allSettled(batch);
  await tool.execute("d", { query: "d" });
  assert.equal(calls, 1);
});

test("question and questionnaire share one non-refundable clarification allowance", async () => {
  const release = deferred();
  let calls = 0;
  const options = {
    budget: createCallBudget(1),
    context: {
      hiddenUserPersona: "fixture persona",
      runRole: async () => { calls++; await release.promise; return '{"selected_index":1}'; },
    },
  };
  const question = createQuestionAgentTool(options);
  const questionnaire = createQuestionnaireAgentTool(options);
  const first = question.execute("q", { question: "Q?", options: [{ label: "A" }] });
  const second = questionnaire.execute("qn", { questions: [{ id: "q1", prompt: "Q?", options: [{ value: "a", label: "A" }] }] });
  const actual = calls;
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(actual, 1);
});

test("already aborted tool execution does not claim, while cancellation after execution claims never refunds", async () => {
  const budget = createCallBudget(1);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const steps: unknown[] = [];
  const live = new AbortController();
  const tool = createWebSearchAgentTool(async ({ query }) => {
    calls++;
    live.abort();
    return { query, text: "late response", isError: false };
  }, { budget, onStep: (step) => steps.push(step) });
  await assert.rejects(tool.execute("already", { query: "a" }, controller.signal), /operation_aborted/);
  await assert.rejects(tool.execute("in-flight", { query: "b" }, live.signal), /operation_aborted/);
  const limited = await tool.execute("after", { query: "c" });
  assert.equal(calls, 1);
  assert.equal(limited.isError, true);
  assert.deepEqual(steps, []);
});

test("retry rejects an already cancelled request before executing an attempt", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runWithRetry({
    maxAttempts: 3, delayMs: 0, signal: controller.signal,
    run: async () => { calls++; return "unexpected"; },
  }), (error: unknown) => error instanceof PublicError && error.code === "operation_aborted");
  assert.equal(calls, 0);
});

test("retry delay cancellation starts no further attempt, while ordinary model timeouts remain retryable", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runWithRetry({
    maxAttempts: 3, delayMs: 60000, signal: controller.signal,
    run: async () => { calls++; throw new Error("fixture failure"); },
    onRetry: () => { controller.abort(); },
  }), (error: unknown) => error instanceof PublicError && error.code === "operation_aborted");
  assert.equal(calls, 1);
  assert.equal(await runWithRetry({ maxAttempts: 2, delayMs: 0, run: async (attempt) => {
    if (attempt === 1) throw new PublicError("model_timeout");
    return "recovered";
  } }), "recovered");
});

test("adapter cleanup failures bypass retries and item-level catches", async () => {
  const failure = new PublicError("adapter_cleanup_failed");
  let calls = 0;
  await assert.rejects(runWithRetry({ maxAttempts: 3, delayMs: 0,
    run: async () => { calls++; throw failure; },
  }), (error: unknown) => error === failure);
  assert.equal(calls, 1);
  assert.throws(() => rethrowIfAborted(failure), (error: unknown) => error === failure);
});

test("a fatal pool worker stops dispatch and drains actual in-flight cleanup before rejection", async () => {
  const started = deferred();
  const cleanup = deferred();
  const fatal = new Error("fatal fixture");
  const dispatched: number[] = [];
  let settled = false;
  let aborted = false;
  let drained = false;
  const run = runConcurrentPool([0, 1, 2, 3], 2, async (item, _index, signal) => {
    dispatched.push(item);
    if (item === 0) { await started.promise; throw fatal; }
    signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    started.resolve();
    await cleanup.promise;
    drained = true;
  });
  const observed = run.then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
  await started.promise;
  await nextTick();
  const prematurelySettled = settled;
  cleanup.resolve();
  assert.equal(await observed, fatal);
  assert.equal(prematurelySettled, false);
  assert.equal(aborted, true);
  assert.equal(drained, true);
  assert.deepEqual(dispatched, [0, 1]);
});

test("invalid todo arguments do not claim execution allowance", async () => {
  const steps: unknown[] = [];
  const todo = createTodoAgentTool({ maxCalls: 1, onStep: (step) => steps.push(step) });
  await assert.rejects(todo.execute("invalid", { action: "add", text: " " }));
  const result = await todo.execute("valid", { action: "add", text: "first" });
  assert.equal(result.content[0]?.type === "text" && result.content[0].text, "Added #1 [ ] first");
  assert.equal(steps.length, 1);
});

test("clarification simulator context cancellation never becomes a deterministic fallback", async () => {
  const controller = new AbortController();
  let calls = 0;
  const steps: unknown[] = [];
  const tool = createQuestionAgentTool({
    context: { signal: controller.signal, hiddenUserPersona: "persona", runRole: async (request) => {
      calls++;
      assert.ok(request.signal);
      controller.abort();
      throw new Error("aborted simulator");
    } },
    onStep: (step) => steps.push(step),
  });
  await assert.rejects(tool.execute("q", { question: "Q?", options: [{ label: "A" }] }),
    (error: unknown) => error instanceof PublicError && error.code === "operation_aborted");
  assert.equal(calls, 1);
  assert.deepEqual(steps, []);
});

test("a cancelled warmup waiter exits without waiting for or executing the warmup owner", async () => {
  const gate = createWarmupGate();
  const release = deferred();
  const first = gate.run("key", true, () => release.promise);
  const controller = new AbortController();
  let calls = 0;
  const waiting = gate.run("key", true, async () => { calls++; }, controller.signal);
  const outcome = waiting.then(() => "resolved", (error: unknown) => error);
  controller.abort();
  await nextTick();
  // Release before assertions so an old implementation's pending promise is still cleaned up.
  release.resolve();
  await first;
  const error = await outcome;
  assert.ok(error instanceof PublicError && error.code === "operation_aborted");
  assert.equal(calls, 0);
});
