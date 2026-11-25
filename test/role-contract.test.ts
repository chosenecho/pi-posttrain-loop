import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { DataMakerStore } from "../src/db.js";
import { readAnswerStyle, readFollowupSkill, readQuestionSkill, readRubric } from "../src/io.js";
import { runMaterialsToStore } from "../src/pipeline.js";
import type { Role, RoleRequest, Skill, SystemPrompts } from "../src/types.js";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "data-maker-role-contract-")));
  assert.ok(isAbsolute(directory));
  t.after(async () => {
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("two revisions send only the latest answer and feedback while keeping role data, Skills, and SQLite input_refs isolated", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const material = { id: "contract-source", text: "仅供回答者的原始材料：周五交付，两人签字验收。" };
  const direction = "仅供出题者的方向：梳理交付条件";
  const question = "如何完成交付？";
  const questionSkill: Skill = {
    status: "ready", body: "出题规则全文：聚焦单一核心问题。", sha256: "question-skill-hash",
  };
  const answerStyle: Skill = {
    status: "ready", body: "回答风格全文第一行：简洁。\n回答风格全文第二行：先结论后条件。", sha256: "style-hash",
  };
  const rubric: Skill = {
    status: "ready", body: "判断规则全文第一行：检查答案完整性。\n判断规则全文第二行：给出具体修订意见。", sha256: "judge-hash",
  };
  const prompts: SystemPrompts = { question: "QUESTION BASE", answer: "ANSWER BASE", judge: "JUDGE BASE" };
  const expectedQuestionPrompt = `QUESTION BASE\n\n<question-design>\n${questionSkill.body}\n</question-design>`;
  const expectedAnswerPrompt = `ANSWER BASE\n\n<answer-style>\n${answerStyle.body}\n</answer-style>`;
  const expectedJudgePrompt = `JUDGE BASE\n\n<judging-skill>\n${rubric.body}\n</judging-skill>`;
  const replies: Array<[Role, string]> = [
    ["question", JSON.stringify({ questions: [question] })],
    ["answer", "第一版答案"],
    ["judge", JSON.stringify({ decision: "revise", issues: ["仅质检内部问题一"], feedback: "第一轮反馈：补充日期。" })],
    ["answer", "第二版答案"],
    ["judge", JSON.stringify({ decision: "revise", issues: ["仅质检内部问题二"], feedback: "第二轮反馈：补充签字条件。" })],
    ["answer", "第三版完整答案"],
    ["judge", JSON.stringify({ decision: "pass", issues: [], feedback: "" })],
  ];
  const calls: RoleRequest[] = [];
  const run = await runMaterialsToStore({
    store,
    materials: [material],
    direction,
    questionSkill,
    answerStyle,
    rubric,
    prompts,
    runRole: async (request) => {
      calls.push(request);
      const reply = replies.shift();
      assert.ok(reply, `unexpected ${request.role} call`);
      assert.equal(request.role, reply[0]);
      return reply[1];
    },
  });

  assert.equal(replies.length, 0);
  assert.equal(run.integrityOk, true);
  assert.deepEqual(run.dialogue?.outcomes, { pass: 1 });
  assert.equal(run.dialogue?.results, 1);
  assert.deepEqual(store.exportRunSamples(run.judgeRunId!), [{
    messages: [
      { role: "user", content: question },
      { role: "assistant", content: "第三版完整答案" },
    ],
  }]);

  assert.deepEqual(calls[0].input, { material, direction });
  assert.equal(calls[0].systemPrompt, expectedQuestionPrompt);
  assert.ok(!calls[0].systemPrompt.includes(answerStyle.body));
  assert.ok(!calls[0].systemPrompt.includes(rubric.body));

  const answers = calls.filter(({ role }) => role === "answer");
  assert.deepEqual(answers.map(({ input }) => Object.keys(input).sort()), [
    ["material", "question"],
    ["feedback", "material", "previousAnswer", "question"],
    ["feedback", "material", "previousAnswer", "question"],
  ]);
  assert.deepEqual(answers.map(({ input }) => input), [
    { material: material.text, question },
    { material: material.text, question, previousAnswer: "第一版答案", feedback: "第一轮反馈：补充日期。" },
    { material: material.text, question, previousAnswer: "第二版答案", feedback: "第二轮反馈：补充签字条件。" },
  ]);
  for (const request of answers) {
    assert.equal(request.systemPrompt, expectedAnswerPrompt);
    assert.ok(!request.systemPrompt.includes(rubric.body));
    assert.ok(!request.systemPrompt.includes(questionSkill.body));
  }

  const judges = calls.filter(({ role }) => role === "judge");
  assert.deepEqual(judges.map(({ input }) => Object.keys(input).sort()), [
    ["answer", "material", "question"],
    ["answer", "material", "question"],
    ["answer", "material", "question"],
  ]);
  assert.deepEqual(judges.map(({ input }) => input), [
    { material: material.text, question, answer: "第一版答案" },
    { material: material.text, question, answer: "第二版答案" },
    { material: material.text, question, answer: "第三版完整答案" },
  ]);
  for (const request of judges) {
    assert.equal(request.systemPrompt, expectedJudgePrompt);
    assert.ok(!request.systemPrompt.includes(answerStyle.body));
    assert.ok(!request.systemPrompt.includes(questionSkill.body));
    assert.ok(!request.systemPrompt.includes(material.text));
    assert.ok(!request.systemPrompt.includes(direction));
  }

  // Verify SQLite model_calls store reference-based input_refs_json without duplicating raw material text
  const dbCalls = store.db.prepare("SELECT role, input_refs_json FROM model_calls ORDER BY id").all() as Array<{
    role: string; input_refs_json: string;
  }>;
  assert.deepEqual(dbCalls.map((c) => c.role), ["question", "answer", "judge", "answer", "judge", "answer", "judge"]);
  for (const c of dbCalls) {
    assert.equal(c.input_refs_json.includes(material.text), false);
  }
});

test("all four default agent Skills load as ready with zero TODO placeholders", async () => {
  const skills = await Promise.all([
    readQuestionSkill(),
    readFollowupSkill(),
    readAnswerStyle(),
    readRubric(),
  ]);
  for (const skill of skills) {
    assert.equal(skill.status, "ready");
    assert.doesNotMatch(skill.body, /\bTODO\b|占位模式的输出/);
    assert.equal(skill.body, skill.body.trim());
    assert.match(skill.sha256, /^[a-f0-9]{64}$/);
  }
});

test("ready answer style trims its body and hashes canonical text identically for LF and BOM plus CRLF", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = "---\nname: contract-style\nstatus: ready\n---\n\n  简洁作答。\n逐条列出事实。  \n";
  const lfPath = join(directory, "lf.md");
  const crlfPath = join(directory, "bom-crlf.md");
  await writeFile(lfPath, canonical, "utf8");
  await writeFile(crlfPath, "\uFEFF" + canonical.replaceAll("\n", "\r\n"), "utf8");
  const expected = {
    status: "ready", body: "简洁作答。\n逐条列出事实。",
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };

  assert.deepEqual(await readAnswerStyle(lfPath), expected);
  assert.deepEqual(await readAnswerStyle(crlfPath), expected);
});

for (const scenario of [
  { name: "an empty file", text: "", error: /frontmatter/ },
  { name: "missing frontmatter", text: "简洁作答。", error: /frontmatter/ },
  { name: "a missing status", text: "---\nname: style\n---\n简洁作答。", error: /status/ },
  { name: "an invalid status", text: "---\nstatus: draft\n---\n简洁作答。", error: /status/ },
  { name: "duplicate statuses", text: "---\nstatus: ready\nstatus: placeholder\n---\n简洁作答。", error: /恰好设置一次/ },
  { name: "a blank body", text: "---\nstatus: ready\n---\n \t\n", error: /正文为空/ },
  { name: "TODO in a ready style", text: "---\nstatus: ready\n---\n风格规则：TODO", error: /TODO/ },
]) {
  test(`answer style rejects ${scenario.name}`, async (t) => {
    const directory = await temporaryDirectory(t);
    const path = join(directory, "invalid.md");
    await writeFile(path, scenario.text, "utf8");

    await assert.rejects(readAnswerStyle(path), scenario.error);
  });
}

test("answer style reports a missing file", async (t) => {
  const directory = await temporaryDirectory(t);
  await assert.rejects(readAnswerStyle(join(directory, "missing.md")), { code: "ENOENT" });
});
