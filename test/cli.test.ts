import { storeConnection } from "./fixtures/store-connection.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DataMakerStore } from "../src/synth/store/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "data-maker-cli-"));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(target, directory);
    assert.ok(target.startsWith(join(tmpdir(), "data-maker-cli-")));
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

async function dm(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, LLM_API_KEY: "test-project-key", LLM_MODEL: "fixture", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  return { code, stdout, stderr };
}

test("unified CLI help and presets listing work offline without model configuration", async () => {
  const cleanEnv = { LLM_API_KEY: "", LLM_MODEL: "" };

  const rootHelp = await dm(["--help"], cleanEnv);
  assert.equal(rootHelp.code, 0, rootHelp.stderr);
  assert.match(rootHelp.stdout, /synth/);
  assert.match(rootHelp.stdout, /cot/);
  assert.match(rootHelp.stdout, /eval/);
  assert.match(rootHelp.stdout, /presets/);

  const presetsRes = await dm(["presets"], cleanEnv);
  assert.equal(presetsRes.code, 0, presetsRes.stderr);
  assert.match(presetsRes.stdout, /train-standard/);
  assert.match(presetsRes.stdout, /train-val/);
  assert.match(presetsRes.stdout, /pilot/);
  assert.doesNotMatch(presetsRes.stdout, /adv-full/);

  const evalHelp = await dm(["eval", "--help"], cleanEnv);
  assert.equal(evalHelp.code, 0, evalHelp.stderr);
  assert.match(evalHelp.stdout, /\bmake\b/);
  assert.match(evalHelp.stdout, /\bevaluate\b/);
  assert.match(evalHelp.stdout, /\bsuites\b/);

  const synthRunHelp = await dm(["synth", "run", "--help"], cleanEnv);
  assert.equal(synthRunHelp.code, 0, synthRunHelp.stderr);
  assert.match(synthRunHelp.stdout, /--preset/);
  assert.match(synthRunHelp.stdout, /--db/);
  assert.match(synthRunHelp.stdout, /--max-turns/);
  assert.match(synthRunHelp.stdout, /--concurrency/);
});

test("offline dm demo writes unified SQLite results and outcomes with training_enabled=false", async (t) => {
  const root = await workspace(t);
  const dbPath = join(root, "demo.sqlite");
  const result = await dm(["demo", "--db", dbPath], { LLM_API_KEY: "", LLM_MODEL: "" });
  assert.equal(result.code, 0, result.stderr);

  const store = new DataMakerStore(dbPath, { readOnly: true });
  try {
    assert.equal(store.checkIntegrity().ok, true);
    const runs = storeConnection(store).prepare("SELECT id, kind, status, export_policy_json, skills_json FROM runs ORDER BY id").all() as Array<{
      id: number; kind: string; status: string; export_policy_json: string; skills_json: string;
    }>;
    assert.deepEqual(runs.map((r) => [r.kind, r.status]), [
      ["question_generation", "completed"],
      ["answer_judge", "completed"],
    ]);
    assert.deepEqual(JSON.parse(runs[1].export_policy_json), { format: "messages_jsonl", training_enabled: false });
    assert.deepEqual((JSON.parse(runs[0].skills_json) as Array<{ name: string }>).map((s) => s.name), ["question-design"]);
    assert.deepEqual((JSON.parse(runs[1].skills_json) as Array<{ name: string }>).map((s) => s.name), ["answer-style", "quality-judge"]);
    assert.deepEqual(store.queryOutcomeCounts(runs[1].id), { pass: 2, drop: 1 });
    assert.equal(store.exportRunSamples(runs[1].id).length, 2);

    const callCounts = storeConnection(store).prepare("SELECT role, COUNT(*) AS c FROM model_calls GROUP BY role").all() as Array<{
      role: string; c: number;
    }>;
    assert.deepEqual(Object.fromEntries(callCounts.map((r) => [r.role, Number(r.c)])), {
      question: 1,
      answer: 4,
      judge: 4,
    });
  } finally {
    store.close();
  }
});

test("dm demo honors max-attempts and records exhaustion without inserting into results", async (t) => {
  const root = await workspace(t);
  const dbPath = join(root, "demo-1.sqlite");
  const result = await dm(["synth", "demo", "--max-attempts", "1", "--db", dbPath]);
  assert.equal(result.code, 0, result.stderr);

  const store = new DataMakerStore(dbPath, { readOnly: true });
  try {
    const judgeRun = storeConnection(store).prepare("SELECT id FROM runs WHERE kind = 'answer_judge'").get() as { id: number };
    assert.deepEqual(store.queryOutcomeCounts(judgeRun.id), { pass: 1, drop: 1, exhausted: 1 });
    assert.equal(store.exportRunSamples(judgeRun.id).length, 1);
  } finally {
    store.close();
  }
});

test("unified CLI rejects invalid commands, presets, and options before creating SQLite database", async (t) => {
  const root = await workspace(t);
  const dbPath = join(root, "should-not-exist.sqlite");
  assert.equal((await dm(["unknown-group"])).code, 1);
  assert.equal((await dm(["demo", "--max-attempts", "0", "--db", dbPath])).code, 1);
  assert.equal((await dm(["synth", "run", "--preset", "nonexistent", "--db", dbPath])).code, 1);
  assert.equal((await dm(["synth", "run", "--concurrency", "0", "--db", dbPath])).code, 1);
  assert.equal((await dm(["synth", "run", "--concurrency", "501", "--db", dbPath])).code, 1);
  assert.equal((await dm(["synth", "judge", "--prompts", join(root, "missing"), "--db", dbPath])).code, 1);
  assert.deepEqual(await readdir(root), []);
});

test("live dm synth judge preserves minimal wire inputs, isolated Skills, SQLite snapshots, and strict JSONL export over actual Pi", async (t) => {
  const root = await workspace(t);
  const dbPath = join(root, "live.sqlite");
  const readySkillPath = join(root, "ready-judge.md");
  const placeholderSkillPath = join(root, "placeholder-judge.md");
  const style = join(root, "style.md");
  const styleBody = "STYLE 只设置表达方式。TODO：待填写风格。";
  const styleFile = `---\nstatus: placeholder\n---\n${styleBody}\n`;
  await writeFile(readySkillPath, "---\nstatus: ready\n---\n检查回答是否覆盖问题的要求。\n");
  await writeFile(placeholderSkillPath, "---\nstatus: placeholder\n---\nTODO 占位规则。\n");
  await writeFile(style, styleFile);

  const promptsDirectory = join(root, "prompts");
  await mkdir(promptsDirectory);
  const systemPrompts = { answer: "CUSTOM 回答 Agent", judge: "CUSTOM 质检 Agent" };
  for (const [role, text] of Object.entries(systemPrompts)) {
    await writeFile(join(promptsDirectory, `${role}.md`), text);
  }

  const question = "供电电压是多少？";
  const feedback = "补充明确的供电电压数值。";
  const seedStore = new DataMakerStore(dbPath);
  try {
    const material = seedStore.upsertMaterial({ videoId: "device", content: "供电电压12V。" });
    seedStore.insertQuestion({ materialId: material.id, question });
  } finally {
    seedStore.close();
  }

  const sentSystems: string[] = [];
  const sentInputs: Record<string, unknown>[] = [];
  const messageCounts: number[] = [];
  let calls = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const step = calls++ % 4;
      const payload = JSON.parse(body) as { messages: { content: string | { type: string; text?: string }[] }[] };
      const textOf = (content: typeof payload.messages[number]["content"]) => typeof content === "string"
        ? content : content.map((part) => part.text ?? "").join("");
      sentSystems.push(textOf(payload.messages[0].content));
      sentInputs.push(JSON.parse(textOf(payload.messages[1].content)) as Record<string, unknown>);
      messageCounts.push(payload.messages.length);
      const text = step === 0 ? "请按要求供电。"
        : step === 1 ? JSON.stringify({ decision: "revise", issues: ["数值缺失"], feedback })
        : step === 2 ? "供电电压为12V。"
        : '{"decision":"pass","issues":[],"feedback":""}';
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local TCP address");
  const env = { LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, LLM_MAX_TOKENS: "256", LLM_CONTEXT_WINDOW: "32768", LLM_TIMEOUT_MS: "5000" };

  for (const ready of [false, true]) {
    const exportPath = join(root, ready ? "ready.jsonl" : "placeholder.jsonl");
    const result = await dm([
      "synth", "judge",
      "--db", dbPath,
      "--max-turns", "1",
      "--prompts", promptsDirectory,
      "--answer-style", style,
      "--quality-judge", ready ? readySkillPath : placeholderSkillPath,
      "--export", exportPath,
    ], env);
    assert.equal(result.code, 0, result.stderr);

    const offset = ready ? 4 : 0;
    const sent = sentSystems.slice(offset, offset + 4);
    const expectedAnswer = `${systemPrompts.answer}\n\n<answer-style>\n${styleBody}\n</answer-style>`;
    assert.equal(sent[0], expectedAnswer);
    assert.equal(sent[2], expectedAnswer);
    assert.ok(sent[1].startsWith(`${systemPrompts.judge}\n\n<judging-skill>\n`));
    assert.equal(sent[1], sent[3]);

    const inputs = sentInputs.slice(offset, offset + 4);
    assert.deepEqual(inputs, [
      { material: "供电电压12V。", question },
      { material: "供电电压12V。", question, answer: "请按要求供电。" },
      { material: "供电电压12V。", question, previousAnswer: "请按要求供电。", feedback },
      { material: "供电电压12V。", question, answer: "供电电压为12V。" },
    ]);

    const exportedLines = (await readFile(exportPath, "utf8")).trimEnd().split("\n");
    assert.equal(exportedLines.length, 1);
    assert.deepEqual(JSON.parse(exportedLines[0]), {
      messages: [
        { role: "user", content: question },
        { role: "assistant", content: "供电电压为12V。" },
      ],
    });
  }

  const store = new DataMakerStore(dbPath, { readOnly: true });
  try {
    assert.equal(store.checkIntegrity().ok, true);
    const judgeRuns = storeConnection(store).prepare(
      "SELECT id, config_json, skills_json, export_policy_json FROM runs WHERE kind = 'answer_judge' ORDER BY id",
    ).all() as Array<{ id: number; config_json: string; skills_json: string; export_policy_json: string }>;
    assert.equal(judgeRuns.length, 2);

    assert.deepEqual(JSON.parse(judgeRuns[0].export_policy_json), { format: "messages_jsonl", training_enabled: false });
    assert.deepEqual(JSON.parse(judgeRuns[1].export_policy_json), { format: "messages_jsonl", training_enabled: true });

    const skills0 = JSON.parse(judgeRuns[0].skills_json) as Array<{ name: string; status: string; sha256: string }>;
    assert.equal(skills0[0].name, "answer-style");
    assert.equal(skills0[0].status, "placeholder");
    assert.equal(skills0[0].sha256, createHash("sha256").update(styleFile).digest("hex"));
    assert.equal(skills0[1].name, "quality-judge");
    assert.equal(skills0[1].status, "placeholder");

    for (const run of judgeRuns) {
      assert.equal(run.config_json.includes("test-project-key"), false);
      assert.equal(store.exportRunSamples(run.id).length, 1);
    }
  } finally {
    store.close();
  }

  assert.equal(calls, 8);
  assert.deepEqual(messageCounts, Array(8).fill(2), "each model call starts with only system and current user input");
});
