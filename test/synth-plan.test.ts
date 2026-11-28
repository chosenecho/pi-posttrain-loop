import assert from "node:assert/strict";
import test from "node:test";
import { resolveSynthPlan } from "../src/synth/plan.js";
import type { PiConfig } from "../src/shared/pi-runner.js";

const config: PiConfig = {
  baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture", apiKey: "fixture-only",
  maxTokens: 2048, contextWindow: 8192, timeoutMs: 1000, roleThinkingLevels: { answer: "off" },
};

test("resolved synth plan owns immutable profile defaults, skill snapshots, tool and export policies", async () => {
  const input = structuredClone(config);
  const plan = await resolveSynthPlan({ mode: "batch", profile: "todo", config: input });
  assert.equal(plan.maxTurns, 2);
  assert.equal(plan.maxQuestionsPerVideo, 2);
  assert.equal(plan.maxAttempts, 4);
  assert.equal(plan.tools.enableSearch, true);
  assert.equal(plan.tools.useToolRunner, true);
  assert.equal(plan.bundle.dialogueSkills[0]?.status, "ready");
  assert.deepEqual(plan.exportPolicy, { format: "messages_jsonl", split: "train", training_enabled: true });
  input.modelId = "changed-after-resolution";
  input.roleThinkingLevels!.answer = "high";
  assert.equal(plan.config.modelId, "fixture");
  assert.equal(plan.config.roleThinkingLevels?.answer, "off");
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.bundle.dialogueSkills[0]), true);
  assert.equal(Object.isFrozen(plan.config.roleThinkingLevels), true);
  assert.throws(() => { Reflect.apply(Array.prototype.push, plan.bundle.dialogueSkills, [{}]); }, TypeError);
});

test("resolved judge plan preserves omitted split and explicit runner/search overrides", async () => {
  const customRunner = async () => "fixture";
  const plan = await resolveSynthPlan({ mode: "judge", profile: "long", config, runRole: customRunner });
  assert.equal(plan.split, undefined);
  assert.equal(plan.effectiveSplit, "train");
  assert.equal(plan.maxTurns, 3);
  assert.deepEqual(plan.exportPolicy, { format: "messages_jsonl", training_enabled: true });
  assert.equal(plan.tools.useToolRunner, false);
  const search = await resolveSynthPlan({ mode: "judge", profile: "search", config, enableSearch: false });
  assert.equal(search.tools.enableSearch, true);
  assert.equal(search.tools.useToolRunner, true);
  await assert.rejects(resolveSynthPlan({ mode: "batch", split: "test", config }), /test 分区仅供 eval/);
  await assert.rejects(resolveSynthPlan({ mode: "batch", sort: "core-first", shuffle: true, config }), /--sort core-first/);
});
