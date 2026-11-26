import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  readAnswerStyle,
  readFollowupSkill,
  readMaterials,
  readQuestionSkill,
  readRubric,
  SHORT_ANSWER_STYLE,
  SHORT_FOLLOWUP_SKILL,
  SHORT_QUALITY_JUDGE,
  SHORT_QUESTION_SKILL,
  TRAP_ANSWER_STYLE,
  TRAP_FOLLOWUP_SKILL,
  TRAP_QUALITY_JUDGE,
  TRAP_QUESTION_SKILL,
} from "../src/synth/skills.js";

async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "data-maker-io-"));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(target, directory);
    assert.ok(target.startsWith(join(tmpdir(), "data-maker-io-")));
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

test("input JSONL accepts BOM, CRLF, and blank lines", async (t) => {
  const path = join(await workspace(t), "input.jsonl");
  await writeFile(path, '\uFEFF{"id":" a ","text":"资料"}\r\n\r\n{"id":"b","text":"第二份资料"}\r\n');
  assert.deepEqual(await readMaterials(path), [{ id: "a", text: "资料" }, { id: "b", text: "第二份资料" }]);
});

test("input JSONL rejects duplicate IDs, malformed lines, and empty input", async (t) => {
  const path = join(await workspace(t), "input.jsonl");
  await writeFile(path, '{"id":"m","text":"A"}\n{"id":"m","text":"B"}');
  await assert.rejects(readMaterials(path), /id 重复/);
  await writeFile(path, '{"id":"m","text":"A"}\nnot-json');
  await assert.rejects(readMaterials(path), /第 2 行/);
  await writeFile(path, "\n \n");
  await assert.rejects(readMaterials(path), /没有材料/);
});

test("Skill loader reads full body and hashes normalized content", async (t) => {
  const path = join(await workspace(t), "SKILL.md");
  const text = "---\nname: quality\nstatus: placeholder\n---\n\n# 规则\n正文\n";
  await writeFile(path, text);
  const rubric = await readRubric(path);
  assert.equal(rubric.status, "placeholder");
  assert.equal(rubric.body, "# 规则\n正文");
  assert.match(rubric.sha256, /^[a-f0-9]{64}$/);
  await writeFile(path, text.replace(/\n/g, "\r\n"));
  assert.equal((await readRubric(path)).sha256, rubric.sha256);
});

test("ready Skill requires actual rule text instead of leftover TODO or placeholder output", async (t) => {
  const path = join(await workspace(t), "SKILL.md");
  for (const invalid of [
    "missing frontmatter",
    "---\nstatus: ready\n---\nTODO",
    "---\nstatus: ready\n---\n## 占位模式的输出",
    "---\nstatus: ready\nstatus: ready\n---\n正文",
    "---\nstatus: unknown\n---\n正文",
    "---\nstatus: ready\n---\n\n",
  ]) {
    await writeFile(path, invalid);
    await assert.rejects(readRubric(path));
  }
  await writeFile(path, "---\nstatus: ready\n---\n依据材料判定问题与回答，满足条件时通过。\n");
  assert.equal((await readRubric(path)).status, "ready");
});

test("short profile train skills all load cleanly with status ready", async () => {
  const [q, a, f, j] = await Promise.all([
    readQuestionSkill(SHORT_QUESTION_SKILL),
    readAnswerStyle(SHORT_ANSWER_STYLE),
    readFollowupSkill(SHORT_FOLLOWUP_SKILL),
    readRubric(SHORT_QUALITY_JUDGE),
  ]);
  for (const skill of [q, a, f, j]) {
    assert.equal(skill.status, "ready");
    assert.ok(skill.body.length > 100);
  }
});

test("trap profile train skills all load cleanly with status ready", async () => {
  const [q, a, f, j] = await Promise.all([
    readQuestionSkill(TRAP_QUESTION_SKILL),
    readAnswerStyle(TRAP_ANSWER_STYLE),
    readFollowupSkill(TRAP_FOLLOWUP_SKILL),
    readRubric(TRAP_QUALITY_JUDGE),
  ]);
  for (const skill of [q, a, f, j]) {
    assert.equal(skill.status, "ready");
    assert.ok(skill.body.length > 100);
  }
});
