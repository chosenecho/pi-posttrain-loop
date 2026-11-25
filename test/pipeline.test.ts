import assert from "node:assert/strict";
import test from "node:test";
import { runMaterial } from "../src/pipeline.js";
import type { RoleRequest, RoleRunner, RunMaterialOptions } from "../src/types.js";

const fixture = {
  material: { id: "source-1", text: "原始材料：项目在周五交付，验收需要两人签字。" },
  direction: "事实提取",
  rubric: { status: "ready", body: "检查问题与回答是否匹配。", sha256: "rubric-hash" },
} satisfies Omit<RunMaterialOptions, "runRole">;

function scripted(...outputs: Array<string | Error>) {
  const calls: RoleRequest[] = [];
  const runRole: RoleRunner = async (request) => {
    calls.push(request);
    assert.ok(outputs.length > 0, `unexpected ${request.role} call`);
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    return output!;
  };
  return { calls, runRole };
}

const pass = JSON.stringify({ decision: "pass", issues: [], feedback: "" });
const revise = JSON.stringify({ decision: "revise", issues: ["遗漏验收条件"], feedback: "补上两人签字。" });
const drop = JSON.stringify({ decision: "drop", issues: ["材料缺少依据"], feedback: "跳过该问题。" });

test("zero questions produces no results and never invokes answer or judge", async () => {
  const runner = scripted('{"questions":[]}');
  const result = await runMaterial({ ...fixture, runRole: runner.runRole });

  assert.deepEqual(result, { results: [], outcomes: [] });
  assert.deepEqual(runner.calls.map(({ role }) => role), ["question"]);
});

for (const [name, output] of [
  ["malformed JSON", '{"questions":'],
  ["too many questions", '{"questions":["一","二","三","四"]}'],
  ["duplicate questions", '{"questions":["重复？"," 重复？ "]}'],
]) {
  test(`invalid question output (${name}) stops before answering`, async () => {
    const runner = scripted(output);

    await assert.rejects(runMaterial({ ...fixture, runRole: runner.runRole }));
    assert.deepEqual(runner.calls.map(({ role }) => role), ["question"]);
  });
}

test("revise then pass sends only approved role inputs and emits pure user/assistant messages without material", async () => {
  const runner = scripted(
    '{"questions":["何时交付？","验收有什么条件？"]}',
    "周五交付。", revise,
    "周五交付，验收需两人签字。", pass,
    "验收需两人签字。", pass,
  );
  const result = await runMaterial({ ...fixture, runRole: runner.runRole, mode: "demo" });

  assert.deepEqual(runner.calls.filter(({ role }) => role === "answer").map(({ input }) => input), [
    { material: fixture.material.text, question: "何时交付？" },
    { material: fixture.material.text, question: "何时交付？", previousAnswer: "周五交付。", feedback: "补上两人签字。" },
    { material: fixture.material.text, question: "验收有什么条件？" },
  ]);
  const judgeCalls = runner.calls.filter(({ role }) => role === "judge");
  assert.equal(judgeCalls.length, 3);
  assert.deepEqual(runner.calls[0].input, { material: fixture.material, direction: fixture.direction });
  for (const request of judgeCalls) {
    assert.ok(request.systemPrompt.includes(fixture.rubric.body));
  }
  assert.deepEqual(judgeCalls.map(({ input }) => input), [
    { material: fixture.material.text, question: "何时交付？", answer: "周五交付。" },
    { material: fixture.material.text, question: "何时交付？", answer: "周五交付，验收需两人签字。" },
    { material: fixture.material.text, question: "验收有什么条件？", answer: "验收需两人签字。" },
  ]);
  assert.deepEqual(result.outcomes.map(({ status, attempts }) => ({ status, attempts })), [
    { status: "pass", attempts: 2 }, { status: "pass", attempts: 1 },
  ]);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0].messages, [
    { role: "user", content: "何时交付？" },
    { role: "assistant", content: "周五交付，验收需两人签字。" },
  ]);
  assert.equal(result.results[0].attempts, 2);
  assert.deepEqual(result.results[1].messages, [
    { role: "user", content: "验收有什么条件？" },
    { role: "assistant", content: "验收需两人签字。" },
  ]);
});

test("drop immediately terminates a question without saving a result", async () => {
  const runner = scripted('{"questions":["材料外的问题？"]}', "缺少依据。", drop);
  const result = await runMaterial({ ...fixture, runRole: runner.runRole });

  assert.deepEqual(result.results, []);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].question, "材料外的问题？");
  assert.equal(result.outcomes[0].status, "drop");
  assert.equal(result.outcomes[0].attempts, 1);
  assert.deepEqual(result.outcomes[0].review, { decision: "drop", issues: ["材料缺少依据"], feedback: "跳过该问题。" });
  assert.deepEqual(runner.calls.map(({ role }) => role), ["question", "answer", "judge"]);
});

test("three revise rounds exhaust the default budget without saving a result", async () => {
  const runner = scripted('{"questions":["何时交付？"]}', "第一版", revise, "第二版", revise, "第三版", revise);
  const result = await runMaterial({ ...fixture, runRole: runner.runRole });

  assert.deepEqual(result.results, []);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].status, "exhausted");
  assert.equal(result.outcomes[0].attempts, 3);
  assert.deepEqual(runner.calls.filter(({ role }) => role === "answer").map(({ input }) => input.previousAnswer), [undefined, "第一版", "第二版"]);
  assert.equal(runner.calls.filter(({ role }) => role === "judge").length, 3);
});

const failures: Array<{ name: string; outputs: Array<string | Error>; attempts: number; error: RegExp }> = [
  { name: "malformed review after revision", outputs: ["第一版", revise, "第二版", "not JSON"], attempts: 2, error: /JSON/ },
  { name: "invalid review structure", outputs: ["错误答案", '{"decision":"pass","issues":["仍有错误"],"feedback":""}'], attempts: 1, error: /issues/ },
  { name: "answer model failure", outputs: [new Error("answer unavailable")], attempts: 1, error: /answer unavailable/ },
  { name: "judge model failure", outputs: ["待审答案", new Error("judge unavailable")], attempts: 1, error: /judge unavailable/ },
  { name: "empty answer", outputs: ["   "], attempts: 1, error: /非空字符串/ },
];

for (const scenario of failures) {
  test(`${scenario.name} never saves a bad result and the next question starts clean`, async () => {
    const runner = scripted('{"questions":["失败的问题？","下一题？"]}', ...scenario.outputs, "下一题的正确答案。", pass);
    const result = await runMaterial({ ...fixture, runRole: runner.runRole });

    assert.equal(result.results.length, 1);
    assert.deepEqual(result.results[0].messages, [
      { role: "user", content: "下一题？" },
      { role: "assistant", content: "下一题的正确答案。" },
    ]);
    assert.equal(result.outcomes.length, 2);
    assert.equal(result.outcomes[0].status, "error");
    assert.equal(result.outcomes[0].attempts, scenario.attempts);
    assert.match(result.outcomes[0].error ?? "", scenario.error);
    assert.equal(result.outcomes[1].status, "pass");
    assert.equal(result.outcomes[1].attempts, 1);
    const nextAnswer = runner.calls.find(({ role, input }) => role === "answer" && input.question === "下一题？");
    assert.deepEqual(nextAnswer?.input, {
      material: fixture.material.text, question: "下一题？",
    });
  });
}

test("maxAttempts is validated before role calls and counts the first answer", async () => {
  const invalid = scripted();
  await assert.rejects(runMaterial({ ...fixture, runRole: invalid.runRole, maxAttempts: 0 }), /max-attempts/);
  assert.deepEqual(invalid.calls, []);

  const runner = scripted('{"questions":["何时交付？"]}', "第一版", revise);
  const result = await runMaterial({ ...fixture, runRole: runner.runRole, maxAttempts: 1 });
  assert.deepEqual(result.results, []);
  assert.equal(result.outcomes[0].status, "exhausted");
  assert.equal(result.outcomes[0].attempts, 1);
  assert.deepEqual(runner.calls.map(({ role }) => role), ["question", "answer", "judge"]);
});
