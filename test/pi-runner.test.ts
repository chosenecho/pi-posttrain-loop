import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { createPiRunner, readPiConfig, type PiConfig } from "../src/pi-runner.js";

async function localApi(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}/v1`;
}

function config(baseUrl: string, timeoutMs = 5000): PiConfig {
  return { baseUrl, modelId: "local-fixture", apiKey: "fixture-test-key", maxTokens: 128, contextWindow: 32768, timeoutMs };
}

function sendText(response: ServerResponse, text: string, finish = "stop"): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "local-fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "local-fixture", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

test("real Pi Agent calls a local Chat Completions stream and isolates every invocation", async (t) => {
  const requests: { path?: string; auth?: string; body: Record<string, unknown> }[] = [];
  const baseUrl = await localApi(t, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(body) as Record<string, unknown> });
      sendText(response, requests.length === 1 ? '{"questions":[]}' : "第二次独立调用");
    });
  });
  const run = createPiRunner(config(baseUrl));
  assert.equal(await run({ role: "question", systemPrompt: "出题指令", input: { material: "资料A" } }), '{"questions":[]}');
  assert.equal(await run({ role: "answer", systemPrompt: "回答指令", input: { question: "问题B" } }), "第二次独立调用");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.path, "/v1/chat/completions");
    assert.equal(request.auth, "Bearer fixture-test-key");
    assert.equal(request.body.model, "local-fixture");
    assert.equal(request.body.stream, true);
    assert.equal(request.body.max_tokens, 128);
    assert.equal(request.body.reasoning_effort, "high");
  }
  assert.deepEqual(requests[1].body.messages, [
    { role: "system", content: "回答指令" },
    { role: "user", content: [{ type: "text", text: '{"question":"问题B"}' }] },
  ]);
});

test("an explicit off override omits reasoning effort from the wire request", async (t) => {
  let payload: Record<string, unknown> = {};
  const baseUrl = await localApi(t, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      payload = JSON.parse(body) as Record<string, unknown>;
      sendText(response, "直接回答");
    });
  });
  const result = await createPiRunner({ ...config(baseUrl), thinkingLevel: "off" })({ role: "answer", systemPrompt: "回答", input: { question: "问题" } });
  assert.equal(result, "直接回答");
  assert.equal(Object.hasOwn(payload, "reasoning_effort"), false);
});

test("model configuration defaults to high reasoning and a 1M context window", () => {
  const env = { LLM_API_KEY: "fixture-key", LLM_MODEL: "fixture", LLM_BASE_URL: "http://127.0.0.1:3425/v1" };
  const actual = readPiConfig(env);
  assert.equal(actual.thinkingLevel, "high");
  assert.equal(actual.contextWindow, 1048576);
  assert.equal(readPiConfig({ ...env, LLM_THINKING_LEVEL: "off", LLM_CONTEXT_WINDOW: "32768" }).thinkingLevel, "off");
  assert.equal(readPiConfig({ ...env, LLM_THINKING_LEVEL: "low" }).thinkingLevel, "low");
  assert.throws(() => readPiConfig({ ...env, LLM_THINKING_LEVEL: "extreme" }), /LLM_THINKING_LEVEL/);

  const withRoles = readPiConfig({
    ...env,
    LLM_THINKING_LEVEL: "high",
    LLM_JUDGE_THINKING_LEVEL: "low",
    LLM_FOLLOWUP_THINKING_LEVEL: "off",
  });
  assert.deepEqual(withRoles.roleThinkingLevels, { judge: "low", followup: "off" });
  assert.throws(() => readPiConfig({ ...env, LLM_JUDGE_THINKING_LEVEL: "ultra" }), /LLM_JUDGE_THINKING_LEVEL/);
});

test("Pi runner applies per-role thinkingLevel overrides and falls back to global thinkingLevel", async (t) => {
  const seenEfforts: Array<unknown> = [];
  const baseUrl = await localApi(t, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      seenEfforts.push(Object.hasOwn(parsed, "reasoning_effort") ? parsed.reasoning_effort : undefined);
      sendText(response, "ok");
    });
  });

  const run = createPiRunner({
    ...config(baseUrl),
    thinkingLevel: "high",
    roleThinkingLevels: { judge: "low", followup: "off" },
  });
  await run({ role: "question", systemPrompt: "q", input: {} });
  await run({ role: "answer", systemPrompt: "a", input: {} });
  await run({ role: "judge", systemPrompt: "j", input: {} });
  await run({ role: "followup", systemPrompt: "f", input: {} });

  assert.deepEqual(seenEfforts, ["high", "high", "low", undefined]);
});

test("Pi adapter surfaces HTTP errors, redacts project API key, and avoids retries", async (t) => {
  let calls = 0;
  const baseUrl = await localApi(t, (_request, response) => {
    calls++;
    response.writeHead(503, { "Content-Type": "application/json", "Retry-After": "0" });
    response.end(JSON.stringify({ error: { message: "bad fixture-test-key", type: "invalid_request_error" } }));
  });
  await assert.rejects(createPiRunner(config(baseUrl))({ role: "answer", systemPrompt: "x", input: {} }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("fixture-test-key"));
    assert.match(error.message, /REDACTED/);
    return true;
  });
  assert.equal(calls, 1);
});

test("Pi adapter rejects truncated responses instead of exporting a partial answer", async (t) => {
  const baseUrl = await localApi(t, (_request, response) => sendText(response, "partial answer", "length"));
  await assert.rejects(createPiRunner(config(baseUrl))({ role: "answer", systemPrompt: "x", input: {} }), /length/);
});

test("Pi adapter rejects empty assistant text", async (t) => {
  const baseUrl = await localApi(t, (_request, response) => sendText(response, ""));
  await assert.rejects(createPiRunner(config(baseUrl))({ role: "answer", systemPrompt: "x", input: {} }), /空正文/);
});

test("unexpected tool calls end the role instead of creating a hidden provider loop", async (t) => {
  let calls = 0;
  const baseUrl = await localApi(t, (_request, response) => {
    calls++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: "local-fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "unexpected_tool", arguments: "{}" } }] }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await assert.rejects(createPiRunner(config(baseUrl))({ role: "answer", systemPrompt: "x", input: {} }), /toolUse/);
  assert.equal(calls, 1);
});

test("Pi runner executes a declared tool and returns its receipt without a second model request", async (t) => {
  let calls = 0;
  let executed = 0;
  const baseUrl = await localApi(t, (request, response) => {
    calls++;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      assert.equal(JSON.parse(body).tools[0].function.name, "save_questions");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = { role: "assistant", tool_calls: [{ index: 0, id: "call-save", type: "function", function: {
        name: "save_questions", arguments: JSON.stringify({ video_id: "BV-test/P001", questions: ["问题？"] }),
      } }] };
      response.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  const receipt = JSON.stringify({ video_id: "BV-test/P001", saved_count: 1, skipped_count: 0 });
  const run = createPiRunner(config(baseUrl), [{
    name: "save_questions", label: "save", description: "save questions",
    parameters: { type: "object", properties: { video_id: { type: "string" }, questions: { type: "array", items: { type: "string" } } }, required: ["video_id", "questions"] },
    async execute(_id, input) {
      executed++;
      assert.deepEqual(input, { video_id: "BV-test/P001", questions: ["问题？"] });
      return { content: [{ type: "text", text: receipt }], details: undefined };
    },
  }]);
  assert.equal(await run({ role: "question", systemPrompt: "save", input: {} }), receipt);
  assert.equal(calls, 1);
  assert.equal(executed, 1);
});

test("Pi adapter bounds a stalled stream with a whole-call timeout", async (t) => {
  const baseUrl = await localApi(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
  });
  await assert.rejects(createPiRunner(config(baseUrl, 150))({ role: "answer", systemPrompt: "x", input: {} }));
});
