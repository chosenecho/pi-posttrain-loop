import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { createPiSearchRunner } from "../src/shared/pi-runner.js";
import { DataMakerStore } from "../src/synth/store/index.js";

function send(response: ServerResponse, calls?: Array<{ id: string; arguments: unknown }>) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = calls ? { role: "assistant", reasoning_content: "fixture thought", tool_calls: calls.map((call, index) => ({
    index, id: call.id, type: "function", function: { name: "web_search", arguments: JSON.stringify(call.arguments) },
  })) } : { role: "assistant", content: "final" };
  response.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function fixture(t: test.TestContext, calls: Array<{ id: string; arguments: unknown }>) {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  const runId = store.createRun({ kind: "answer_judge", maxAttempts: 1, config: {}, prompts: {}, skills: [], exportPolicy: {} });
  const material = store.upsertMaterial({ videoId: "audit", content: "fixture material" });
  const question = store.insertQuestion({ materialId: material.id, question: "fixture question" }).record;
  const runItemId = store.createRunItems(runId, [question.id]).get(question.id)!;
  store.startRunItem(runItemId);
  const turnId = store.createTurn({ runItemId, turnNo: 1 });
  const attemptId = store.startAttempt({ turnId, attemptNo: 1 });
  const modelCallId = store.startModelCall({ runId, role: "answer", turnId, attemptId, inputRefs: {} });
  let requests = 0;
  const server = createServer((_request, response) => { send(response, ++requests === 1 ? calls : undefined); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  const config = { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture", modelId: "fixture", contextWindow: 4096, maxTokens: 128, timeoutMs: 5000 };
  return { store, runId, runItemId, turnId, attemptId, modelCallId, config };
}

test("real Pi parallel tool attempts persist cap rejections separately from training projections", async (t) => {
  const { store, runId, runItemId, turnId, attemptId, modelCallId, config } = await fixture(t, ["a", "b", "c"].map((id) => ({ id, arguments: { query: id } })));
  const run = createPiSearchRunner(config, async ({ query }) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { query, text: query, isError: false };
  }, { maxSearchCalls: 1 });
  const result = await run({ role: "answer", systemPrompt: "x", input: {},
    onToolAttempt: (attempt) => store.recordToolAttemptAudit(modelCallId, attempt),
  });
  assert.deepEqual(store.listToolAttemptAudit(modelCallId).map((attempt) => [attempt.toolCallId, attempt.status]), [
    ["a", "succeeded"], ["b", "limit_reached"], ["c", "limit_reached"],
  ]);
  assert.equal(result.toolSteps.length, 1);
  store.finishModelCall(modelCallId, result.answer);
  store.recordAttemptAnswer(attemptId, result.answer);
  store.recordAttemptToolSteps(attemptId, result.toolSteps);
  const judgeCallId = store.startModelCall({ runId, role: "judge", turnId, attemptId, inputRefs: {} });
  store.commitJudgeOutcome({ runItemId, turnId, turnNo: 1, attemptId, judgeCallId,
    judgeOutputText: "pass", review: { decision: "pass", issues: [], feedback: "" },
    isFinalTurn: true, exhaustedBudget: false,
  });
  store.finishRun(runId, "completed");
  const samples = store.exportRunSamples(runId);
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.messages.filter((message) => message.role === "tool").length, 1);
  assert.doesNotMatch(JSON.stringify(samples), /limit_reached|toolAttempts|tool_attempt_audit/);
});


test("SDK validation failures are durable attempts without consuming executable allowance", async (t) => {
  const { store, modelCallId, config } = await fixture(t, [
    { id: "bad", arguments: {} }, { id: "good", arguments: { query: "good" } },
  ]);
  let executions = 0;
  const run = createPiSearchRunner(config, async ({ query }) => {
    executions++;
    return { query, text: query, isError: false };
  }, { maxSearchCalls: 1 });
  const events: string[] = [];
  const result = await run({ role: "answer", systemPrompt: "x", input: {}, onToolAttempt: (attempt) => {
    events.push(attempt.status);
    store.recordToolAttemptAudit(modelCallId, attempt);
  } });
  assert.equal(executions, 1);
  assert.equal(result.toolSteps.length, 1);
  assert.equal(events.filter((status) => status === "attempted").length, 2);
  assert.deepEqual(store.listToolAttemptAudit(modelCallId).map((attempt) => [attempt.toolCallId, attempt.status]), [
    ["bad", "invalid_arguments"], ["good", "succeeded"],
  ]);
});

test("cancelled Pi tools persist final audit during drain and produce no training steps", async (t) => {
  const { store, modelCallId, attemptId, config } = await fixture(t, [{ id: "cancelled", arguments: { query: "cancel" } }]);
  const controller = new AbortController();
  let cleaned = false;
  const run = createPiSearchRunner(config, async ({ query, signal }) => {
    assert.ok(signal);
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    cleaned = true;
    return { query, text: "late success", isError: false };
  });
  await assert.rejects(run({ role: "answer", systemPrompt: "x", input: {}, signal: controller.signal,
    onToolAttempt: (attempt) => store.recordToolAttemptAudit(modelCallId, attempt),
  }), /operation_aborted/);
  assert.equal(cleaned, true);
  const rows = store.listToolAttemptAudit(modelCallId);
  assert.deepEqual(rows.map((attempt) => attempt.status), ["cancelled"]);
  assert.equal(rows[0]?.errorCode, "operation_aborted");
  assert.equal(store.queryAttemptToolStepsMap([attemptId]).get(attemptId)?.length ?? 0, 0);
});

test("an audit sink failure remains primary and stops new tool executions", async (t) => {
  const { config } = await fixture(t, [{ id: "a", arguments: { query: "a" } }]);
  const sentinel = new Error("audit write fixture");
  let executions = 0;
  const run = createPiSearchRunner(config, async ({ query }) => {
    executions++;
    return { query, text: "unexpected", isError: false };
  });
  await assert.rejects(run({ role: "answer", systemPrompt: "x", input: {}, onToolAttempt: () => { throw sentinel; } }),
    (error: unknown) => error === sentinel);
  assert.equal(executions, 0);
});

test("audit upserts retain retry and batch identities and a terminal state survives duplicate attempted events", async (t) => {
  const { store, modelCallId } = await fixture(t, []);
  const first = { attemptId: "invocation-1", batchId: 1, toolCallId: "provider-id", sourceIndex: 0,
    toolName: "web_search", arguments: { query: "a" }, status: "attempted" as const };
  store.recordToolAttemptAudit(modelCallId, first);
  store.recordToolAttemptAudit(modelCallId, { ...first, status: "failed", errorCode: "tool_execution_failed" });
  store.recordToolAttemptAudit(modelCallId, first);
  store.recordToolAttemptAudit(modelCallId, { ...first, batchId: 2, status: "succeeded" });
  store.recordToolAttemptAudit(modelCallId, { ...first, attemptId: "invocation-2", status: "cancelled" });
  assert.deepEqual(store.listToolAttemptAudit(modelCallId).map((row) => [row.attemptId, row.batchId, row.status]), [
    ["invocation-1", 1, "failed"], ["invocation-1", 2, "succeeded"], ["invocation-2", 1, "cancelled"],
  ]);
  assert.throws(() => store.recordToolAttemptAudit(999999, first), /FOREIGN KEY/);
  assert.equal(store.listToolAttemptAudit(modelCallId).length, 3);
});
