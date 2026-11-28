import { storeConnection } from "./fixtures/store-connection.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { DialogueRole, RoleRequest, Skill } from "../src/shared/types.js";
import { runDialogueBatch } from "../src/synth/dialogue-loop.js";
import { answerPrompt, judgePrompt } from "../src/synth/prompts.js";
import { readAnswerStyle, readFollowupSkill, readQuestionSkill, readRubric } from "../src/synth/skills.js";
import { DataMakerStore } from "../src/synth/store/index.js";

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

  const materialText = "仅供回答者的原始材料：周五交付，两人签字验收。";
  const question = "如何完成交付？";
  const mat = store.upsertMaterial({ videoId: "contract-source", content: materialText });
  store.insertQuestion({ materialId: mat.id, question });

  const questionSkill: Skill = {
    status: "ready", body: "出题规则全文：聚焦单一核心问题。", sha256: "question-skill-hash",
  };
  const answerStyle: Skill = {
    status: "ready", body: "回答风格全文第一行：简洁。\n回答风格全文第二行：先结论后条件。", sha256: "style-hash",
  };
  const rubric: Skill = {
    status: "ready", body: "判断规则全文第一行：检查答案完整性。\n判断规则全文第二行：给出具体修订意见。", sha256: "judge-hash",
  };
  const expectedAnswerPrompt = answerPrompt("ANSWER BASE", answerStyle.body);
  const expectedJudgePrompt = judgePrompt("JUDGE BASE", rubric.body);

  const replies: Array<[DialogueRole, string]> = [
    ["answer", "第一版答案"],
    ["judge", JSON.stringify({ decision: "revise", issues: ["仅质检内部问题一"], feedback: "第一轮反馈：补充日期。" })],
    ["answer", "第二版答案"],
    ["judge", JSON.stringify({ decision: "revise", issues: ["仅质检内部问题二"], feedback: "第二轮反馈：补充签字条件。" })],
    ["answer", "第三版完整答案"],
    ["judge", JSON.stringify({ decision: "pass", issues: [], feedback: "" })],
  ];
  const calls: RoleRequest[] = [];
  const summary = await runDialogueBatch({
    store,
    prompts: { answer: expectedAnswerPrompt, judge: expectedJudgePrompt },
    maxAttempts: 3,
    maxTurns: 1,
    concurrency: 1,
    config: { mode: "contract-test" },
    skills: [
      { name: "answer-style", status: answerStyle.status, sha256: answerStyle.sha256 },
      { name: "quality-judge", status: rubric.status, sha256: rubric.sha256 },
    ],
    runRole: async (request) => {
      calls.push(request);
      const reply = replies.shift();
      assert.ok(reply, `unexpected ${request.role} call`);
      assert.equal(request.role, reply[0]);
      return reply[1];
    },
  });

  assert.equal(replies.length, 0);
  assert.equal(summary.integrityOk, true);
  assert.deepEqual(summary.outcomes, { pass: 1 });
  assert.equal(summary.results, 1);
  assert.deepEqual(store.exportRunSamples(summary.runId), [{
    messages: [
      { role: "user", content: question },
      { role: "assistant", content: "第三版完整答案" },
    ],
  }]);

  const answers = calls.filter(({ role }) => role === "answer");
  assert.deepEqual(answers.map(({ input }) => input), [
    { material: materialText, question },
    { material: materialText, question, previousAnswer: "第一版答案", feedback: "第一轮反馈：补充日期。" },
    { material: materialText, question, previousAnswer: "第二版答案", feedback: "第二轮反馈：补充签字条件。" },
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
    { material: materialText, question, answer: "第一版答案" },
    { material: materialText, question, answer: "第二版答案" },
    { material: materialText, question, answer: "第三版完整答案" },
  ]);
  for (const request of judges) {
    assert.equal(request.systemPrompt, expectedJudgePrompt);
    assert.ok(!request.systemPrompt.includes(answerStyle.body));
    assert.ok(!request.systemPrompt.includes(questionSkill.body));
    assert.ok(!request.systemPrompt.includes(materialText));
  }

  // Verify SQLite model_calls store reference-based input_refs_json without duplicating raw material text
  const dbCalls = storeConnection(store).prepare("SELECT role, input_refs_json FROM model_calls ORDER BY id").all() as Array<{
    role: string; input_refs_json: string;
  }>;
  assert.deepEqual(dbCalls.map((c) => c.role), ["answer", "judge", "answer", "judge", "answer", "judge"]);
  for (const c of dbCalls) {
    assert.equal(c.input_refs_json.includes(materialText), false);
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
