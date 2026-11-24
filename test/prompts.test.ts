import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { DataMakerStore } from "../src/db.js";
import { runMaterialsToStore } from "../src/pipeline.js";
import { parseReview } from "../src/schema.js";
import { DEFAULT_PROMPTS_DIR, followupPrompt, judgePrompt, questionPrompt, readFollowupPrompt, readSystemPrompts } from "../src/prompts.js";
import type { Role, RoleRequest, SystemPrompts } from "../src/types.js";

const custom: SystemPrompts = {
  question: "CUSTOM question system prompt",
  answer: "CUSTOM answer system prompt",
  judge: "CUSTOM judge system prompt",
};
const roles: Role[] = ["question", "answer", "judge"];

async function promptDirectory(t: TestContext, files: Partial<SystemPrompts>): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "data-maker-prompts-test-")));
  assert.ok(isAbsolute(directory));
  t.after(async () => {
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all(Object.entries(files).map(([role, contents]) =>
    writeFile(join(directory, `${role}.md`), contents, "utf8"),
  ));
  return directory;
}

test("all four default prompt files load cleanly with zero leftover TODO placeholders", async () => {
  const prompts = await readSystemPrompts();
  const followup = await readFollowupPrompt();
  const markers = { question: /question|出题/i, answer: /answer|回答/i, judge: /judge|质检/i };

  for (const role of roles) {
    const text = await readFile(join(DEFAULT_PROMPTS_DIR, `${role}.md`), "utf8");
    assert.match(text, markers[role]);
    assert.equal(prompts[role], text.trim());
    assert.doesNotMatch(prompts[role], /\bTODO\b/);
  }
  assert.doesNotMatch(followup, /\bTODO\b/);
  assert.match(followup, /followup-strategy/);
  assert.equal(new Set([...Object.values(prompts), followup]).size, 4);
  assert.match(prompts.question, /question-design/);
  assert.match(prompts.answer, /扮演.*作者/);
  assert.match(prompts.answer, /previousAnswer/);
  assert.match(prompts.answer, /feedback/);
  assert.match(prompts.answer, /仅输出.*答案正文/);
  assert.match(prompts.answer, /数据库/);
  assert.match(prompts.judge, /仅包含.*question.*answer/);
  assert.match(prompts.judge, /原始材料.*未提供/);
  const examples = prompts.judge.match(/^\{"decision":.+\}$/gm) ?? [];
  assert.deepEqual(examples.map((text) => parseReview(text).decision), ["pass", "revise", "drop"]);
});

test("custom prompt directory loads all three files and trims their boundaries", async (t) => {
  const directory = await promptDirectory(t, {
    question: "\n  CUSTOM question system prompt  \n",
    answer: "\tCUSTOM answer system prompt\r\n",
    judge: "\nCUSTOM judge system prompt\n\n",
  });

  assert.deepEqual(await readSystemPrompts(directory), custom);
});

for (const role of roles) {
  test(`a blank ${role} prompt is rejected`, async (t) => {
    const directory = await promptDirectory(t, { ...custom, [role]: " \t\r\n " });
    await assert.rejects(readSystemPrompts(directory), /非空|empty/i);
  });

  test(`a missing ${role} prompt is rejected`, async (t) => {
    const files: Partial<SystemPrompts> = { ...custom };
    delete files[role];
    const directory = await promptDirectory(t, files);
    await assert.rejects(readSystemPrompts(directory), { code: "ENOENT" });
  });
}

test("role prompt composers embed each Skill inside its dedicated tag without leakage", () => {
  const qPrompt = questionPrompt(custom.question, "出题规则正文");
  assert.ok(qPrompt.startsWith(custom.question));
  assert.ok(qPrompt.includes("<question-design>\n出题规则正文\n</question-design>"));

  const fPrompt = followupPrompt("CUSTOM followup prompt", "追问策略正文");
  assert.ok(fPrompt.startsWith("CUSTOM followup prompt"));
  assert.ok(fPrompt.includes("<followup-strategy>\n追问策略正文\n</followup-strategy>"));

  const skillBody = "逐项核对原始材料。\n只有全部通过才可入库。";
  const prompt = judgePrompt(custom.judge, skillBody);
  assert.ok(prompt.startsWith(custom.judge));
  assert.ok(prompt.includes(`<judging-skill>\n${skillBody}\n</judging-skill>`));
  assert.ok(!prompt.includes(custom.question));
  assert.ok(!prompt.includes(custom.answer));
});

test("pipeline injects independent system prompts and isolated Skills for all roles and snapshots them in SQLite", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const calls: RoleRequest[] = [];
  const questionSkill = { status: "ready", body: "QUESTION SKILL 正文", sha256: "q-skill-hash" } as const;
  const answerStyle = { status: "ready", body: "STYLE 回答风格正文", sha256: "style-hash" } as const;
  const skillBody = "检查回答是否覆盖当前问题。";
  const run = await runMaterialsToStore({
    store,
    materials: [{ id: "prompt-source", text: "项目在周五交付。" }],
    direction: "事实提取",
    questionSkill,
    rubric: { status: "ready", body: skillBody, sha256: "prompt-test-hash" },
    answerStyle,
    prompts: custom,
    runRole: async (request) => {
      calls.push(request);
      if (request.role === "question") return '{"questions":["何时交付？"]}';
      if (request.role === "answer") return "周五交付。";
      return '{"decision":"pass","issues":[],"feedback":""}';
    },
  });

  assert.equal(run.integrityOk, true);
  assert.equal(run.dialogue?.results, 1);
  assert.deepEqual(run.dialogue?.outcomes, { pass: 1 });
  assert.deepEqual(calls.map(({ role }) => role), ["question", "answer", "judge"]);
  const expectedQuestion = `${custom.question}\n\n<question-design>\n${questionSkill.body}\n</question-design>`;
  const expectedAnswer = `${custom.answer}\n\n<answer-style>\n${answerStyle.body}\n</answer-style>`;
  const expectedJudge = `${custom.judge}\n\n<judging-skill>\n${skillBody}\n</judging-skill>`;
  assert.equal(calls[0].systemPrompt, expectedQuestion);
  assert.equal(calls[1].systemPrompt, expectedAnswer);
  assert.ok(!calls[1].systemPrompt.includes(skillBody));
  assert.ok(!calls[2].systemPrompt.includes(answerStyle.body));
  assert.equal(calls[2].systemPrompt, expectedJudge);

  // Verify SQLite prompt & skill snapshots match exactly
  const qRun = store.db.prepare("SELECT prompts_json, skills_json FROM runs WHERE id = ?").get(run.questionRunId) as {
    prompts_json: string; skills_json: string;
  };
  assert.deepEqual(JSON.parse(qRun.prompts_json), { question: expectedQuestion });
  assert.equal((JSON.parse(qRun.skills_json) as Array<{ name: string }>)[0].name, "question-design");
  const jRun = store.db.prepare("SELECT prompts_json, skills_json FROM runs WHERE id = ?").get(run.judgeRunId!) as {
    prompts_json: string; skills_json: string;
  };
  assert.deepEqual(JSON.parse(jRun.prompts_json), { answer: expectedAnswer, judge: expectedJudge });
  assert.deepEqual((JSON.parse(jRun.skills_json) as Array<{ name: string }>).map((s) => s.name), [
    "answer-style",
    "quality-judge",
  ]);
});
