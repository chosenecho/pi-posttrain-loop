import assert from "node:assert/strict";
import test from "node:test";
import { readCandidateConfig, createOpenAiCandidateRunner } from "../src/eval/candidate-client.js";
import { readEvalPiConfig } from "../src/pi-runner.js";
import { readReasoningPiConfigs } from "../src/reasoning-engine.js";
import { normalizeApiBaseUrl } from "../src/shared/api-config.js";

const mainEnv = {
  LLM_BASE_URL: "https://primary.invalid/v1",
  LLM_MODEL: "fixture-model",
  LLM_API_KEY: "main-fixture-key",
};

function assertPrivateConfigError(run: () => unknown, variable: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(variable));
    assert.ok(!error.message.includes(mainEnv.LLM_API_KEY));
    assert.ok(!error.message.includes("secondary.invalid"));
    return true;
  });
}

test("credential inheritance canonicalizes hosts, default ports, and trailing slashes", () => {
  const config = readCandidateConfig({ baseUrl: "https://PRIMARY.invalid:443/v1/" }, mainEnv);
  assert.equal(config.baseUrl, mainEnv.LLM_BASE_URL);
  assert.equal(config.apiKey, mainEnv.LLM_API_KEY);
  assert.equal(readEvalPiConfig({ ...mainEnv, EVAL_LLM_BASE_URL: "https://PRIMARY.invalid:443/v1/" }).apiKey, mainEnv.LLM_API_KEY);
  const configs = readReasoningPiConfigs({ ...mainEnv, REASONING_BASE_URL: `${mainEnv.LLM_BASE_URL}/` });
  assert.equal(configs.writer.apiKey, mainEnv.LLM_API_KEY);
  assert.equal(configs.judge.apiKey, mainEnv.LLM_API_KEY);
});

test("candidate keys stay bound to protocol, host, port, and API path", () => {
  for (const baseUrl of [
    "http://primary.invalid/v1", "https://secondary.invalid/v1",
    "https://primary.invalid:8443/v1", "https://primary.invalid/other/v1",
  ]) {
    assertPrivateConfigError(() => readCandidateConfig({ baseUrl }, mainEnv), "CANDIDATE_LLM_API_KEY");
  }
});

test("explicit candidate credentials override fallback credentials at a new endpoint", async () => {
  const config = readCandidateConfig({ baseUrl: "https://secondary.invalid/v1", apiKey: "candidate-fixture-key" }, mainEnv);
  let calls = 0;
  const runner = createOpenAiCandidateRunner({ ...config, fetchFn: async (input, init) => {
    calls++;
    assert.equal(input, "https://secondary.invalid/v1/chat/completions");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer candidate-fixture-key");
    assert.ok(!JSON.stringify(init).includes(mainEnv.LLM_API_KEY));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
      headers: { "content-type": "application/json" },
    });
  } });
  assert.equal(await runner({ messages: [{ role: "user", content: "fixture" }] }), "ok");
  assert.equal(calls, 1);
});

test("explicit empty candidate credentials and EMPTY omit Authorization at a new endpoint", async () => {
  for (const apiKey of ["", "  ", "EMPTY"]) {
    const config = readCandidateConfig({ baseUrl: "http://127.0.0.1:8000/v1", apiKey }, mainEnv);
    const runner = createOpenAiCandidateRunner({ ...config, fetchFn: async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).authorization, undefined);
      assert.ok(!JSON.stringify(init).includes(mainEnv.LLM_API_KEY));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
    } });
    assert.equal(await runner({ messages: [{ role: "user", content: "fixture" }] }), "ok");
  }
  assert.equal(readCandidateConfig({ baseUrl: "http://127.0.0.1:8000/v1", modelId: "fixture" }, {}).apiKey, "EMPTY");
  assert.equal(readCandidateConfig({}, { ...mainEnv, CANDIDATE_LLM_API_KEY: "" }).apiKey, "EMPTY");
});

test("reasoning writer and judge require dedicated keys when moving away from their donor", () => {
  assertPrivateConfigError(() => readReasoningPiConfigs({ ...mainEnv, REASONING_BASE_URL: "https://secondary.invalid/v1" }), "REASONING_API_KEY");
  assertPrivateConfigError(() => readReasoningPiConfigs({ ...mainEnv, REASONING_JUDGE_BASE_URL: "https://secondary.invalid/v1" }), "REASONING_JUDGE_API_KEY");
  const configs = readReasoningPiConfigs({
    ...mainEnv,
    REASONING_BASE_URL: "http://127.0.0.1:8000/v1",
    REASONING_API_KEY: "EMPTY",
    REASONING_JUDGE_BASE_URL: "https://judge.invalid/v1",
    REASONING_JUDGE_API_KEY: "judge-fixture-key",
  });
  assert.equal(configs.writer.apiKey, "EMPTY");
  assert.equal(configs.judge.apiKey, "judge-fixture-key");
});

test("reasoning judge can reuse writer credentials only at the writer's exact root", () => {
  const env = { REASONING_BASE_URL: "https://writer.invalid/v1", REASONING_API_KEY: "writer-fixture-key", REASONING_MODEL: "fixture" };
  const configs = readReasoningPiConfigs(env);
  assert.equal(configs.judge.baseUrl, configs.writer.baseUrl);
  assert.equal(configs.judge.apiKey, "writer-fixture-key");
  assertPrivateConfigError(() => readReasoningPiConfigs({ ...env, REASONING_JUDGE_BASE_URL: "https://secondary.invalid/v1" }), "REASONING_JUDGE_API_KEY");
});

test("evaluation roles require dedicated keys after endpoint overrides", () => {
  assertPrivateConfigError(() => readEvalPiConfig({ ...mainEnv, EVAL_LLM_BASE_URL: "https://secondary.invalid/v1" }), "EVAL_LLM_API_KEY");
  const config = readEvalPiConfig({ ...mainEnv, EVAL_LLM_BASE_URL: "https://secondary.invalid/v1", EVAL_LLM_API_KEY: "eval-fixture-key", EVAL_LLM_MODEL: "eval-fixture" });
  assert.equal(config.apiKey, "eval-fixture-key");
  assert.equal(config.modelId, "eval-fixture");
  assert.equal(config.baseUrl, "https://secondary.invalid/v1");
  assert.equal(readEvalPiConfig({ EVAL_LLM_BASE_URL: "http://127.0.0.1:8000/v1", EVAL_LLM_API_KEY: "EMPTY", EVAL_LLM_MODEL: "fixture" }).apiKey, "EMPTY");
  assertPrivateConfigError(() => readEvalPiConfig({ ...mainEnv, EVAL_LLM_API_KEY: " " }), "EVAL_LLM_API_KEY");
});

test("API roots reject embedded credentials and response endpoints without echoing values", () => {
  const marker = "url-fixture-sensitive";
  for (const url of [
    `https://user:${marker}@primary.invalid/v1`,
    `https://primary.invalid/v1?key=${marker}`,
    `https://primary.invalid/v1#${marker}`,
    "file:///v1", "https://primary.invalid/v1/chat/completions/",
  ]) {
    assert.throws(() => normalizeApiBaseUrl(url, "FIXTURE_URL"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("FIXTURE_URL"));
      assert.ok(!error.message.includes(marker));
      return true;
    });
  }
});
