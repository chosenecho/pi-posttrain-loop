import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPiSearchRunner } from "../src/shared/pi-runner.js";
import { createSynthToolRunner } from "../src/synth/tool-runner.js";
import type { PiConfig } from "../src/shared/pi-runner.js";

const config: PiConfig = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", modelId: "fixture", maxTokens: 1024, contextWindow: 8192, timeoutMs: 2000 };

for (const profile of ["todo", "clarify"] as const) {
  test(`synth ${profile} runner assembles task tools, strips simulator metadata, and preserves call audit`, async (t) => {
    const bodies: Array<{ messages: Array<{ content: unknown }>; tools: Array<{ function: { name: string } }> }> = [];
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = bodies.length === 1 ? {
          role: "assistant", tool_calls: profile === "todo"
            ? [{ index: 0, id: "todo-call", type: "function", function: { name: "todo", arguments: '{"action":"add","text":"整理条件"}' } }]
            : [
                { index: 0, id: "question-call", type: "function", function: { name: "question", arguments: '{"question":"条件？","options":[{"label":"A"}]}' } },
                { index: 1, id: "questionnaire-call", type: "function", function: { name: "questionnaire", arguments: '{"questions":[{"id":"q","prompt":"条件？","options":[{"value":"a","label":"A"}]}]}' } },
              ],
        } : { role: "assistant", content: "最终回答" };
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let simulatorCalls = 0;
    const run = createSynthToolRunner({ ...config, baseUrl: `http://127.0.0.1:${address.port}/v1` }, undefined, {
      profile, maxClarifyCalls: 1, simulatorRunner: async (request) => {
        simulatorCalls++;
        assert.ok(request.signal);
        return '{"selected_index":1}';
      },
    });
    const result = await run({ role: "answer", systemPrompt: "回答", input: {
      question: "公开问题", material: "公开材料", _questionMode: profile === "todo" ? "todo_plan" : "clarify_question",
      _taskSpec: { hidden_user_persona: "隐藏角色", missing_slots: ["条件"] },
    } });
    assert.equal(result.answer, "最终回答");
    assert.equal(result.toolSteps.length, 1);
    assert.equal(result.toolAttempts?.filter((call) => call.status === "succeeded").length, 1);
    assert.equal(result.toolSteps[0]?.toolName, profile === "todo" ? "todo" : "question");
    assert.equal(simulatorCalls, profile === "clarify" ? 1 : 0);
    assert.deepEqual(bodies[0]?.tools.map((tool) => tool.function.name), profile === "todo" ? ["todo"] : ["question", "questionnaire"]);
    assert.equal(JSON.stringify(bodies[0]?.messages).includes("_taskSpec"), false);
    assert.equal(JSON.stringify(bodies[0]?.messages).includes("隐藏角色"), false);
  });
}

test("generic tool factory failure disposes its deadline before returning", async () => {
  let factorySignal: AbortSignal | undefined;
  const failure = new Error("factory fixture");
  const run = createPiSearchRunner({ ...config, timeoutMs: 20 }, undefined, { extraToolsFactory: ({ signal }) => { factorySignal = signal; throw failure; } });
  await assert.rejects(run({ role: "answer", systemPrompt: "回答", input: {} }), (error) => error === failure);
  await delay(40);
  assert.ok(factorySignal);
  assert.equal(factorySignal.aborted, false);
});
