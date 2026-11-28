import { storeConnection } from "./fixtures/store-connection.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DataMakerStore } from "../src/synth/store/index.js";
import { runDialogueBatch } from "../src/synth/dialogue-loop.js";
import { createUnifiedSaveQuestionsTool } from "../src/synth/question-store.js";
import { parseFollowup } from "../src/shared/schema.js";
import type { RoleRequest } from "../src/shared/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "data-maker-dialogue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runCli(entry: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: ROOT,
    env: { ...process.env, LLM_API_KEY: "fixture-secret-key", LLM_MODEL: "fixture", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("parseFollowup validates followup and stop JSON contracts", () => {
  assert.deepEqual(parseFollowup('{"action":"followup","user":"如果条件反过来呢？"}'), {
    action: "followup",
    user: "如果条件反过来呢？",
  });
  assert.deepEqual(parseFollowup('{"action":"stop"}'), { action: "stop" });
  assert.throws(() => parseFollowup('{"action":"followup","user":"  "}'), /user/);
  assert.throws(() => parseFollowup('{"action":"continue"}'), /action/);
});

test("createUnifiedSaveQuestionsTool writes questions linked to material_id and generation_run_id with dedup and rollback", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const mat = store.upsertMaterial({ videoId: "BV-u/P001", content: "文稿正文" });
  const runId = store.createRun({
    kind: "question_generation",
    maxAttempts: 1,
    maxTurns: 1,
    config: { videoId: "BV-u/P001" },
    prompts: { question: "prompt" },
    skills: [],
    exportPolicy: { format: "messages_jsonl", training_enabled: false },
  });

  const receipts: unknown[] = [];
  const tool = createUnifiedSaveQuestionsTool(store, mat.id, "BV-u/P001", runId, (r) => receipts.push(r));
  await tool.execute("c1", { video_id: "BV-u/P001", questions: [" 问题一？ ", "问题一？", "问题二？"] });
  await tool.execute("c2", { video_id: "BV-u/P001", questions: [] });

  assert.deepEqual(receipts, [
    { video_id: "BV-u/P001", saved_count: 2, skipped_count: 1 },
    { video_id: "BV-u/P001", saved_count: 0, skipped_count: 0 },
  ]);

  const rows = storeConnection(store).prepare("SELECT material_id, question, generation_run_id FROM questions ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.material_id, r.question, r.generation_run_id]), [
    [mat.id, "问题一？", runId],
    [mat.id, "问题二？", runId],
  ]);
  assert.equal(store.checkIntegrity().ok, true);
});

test("runDialogueBatch supports multi-turn pass, early followup stop, Turn 2 exhaustion (0 results), and malformed error isolation", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const mat = store.upsertMaterial({ videoId: "BV-m/P001", content: "多轮材料原文" });
  const q1 = store.insertQuestion({ id: 1, materialId: mat.id, question: "问题一（两轮通过）" }).record;
  const q2 = store.insertQuestion({ id: 2, materialId: mat.id, question: "问题二（追问停止保留1轮）" }).record;
  const q3 = store.insertQuestion({ id: 3, materialId: mat.id, question: "问题三（第2轮耗尽作废）" }).record;
  const q4 = store.insertQuestion({ id: 4, materialId: mat.id, question: "问题四（追问畸形JSON报错）" }).record;

  const seen: RoleRequest[] = [];
  let q1t2Attempt = 0;

  const runRole = async (req: RoleRequest): Promise<string> => {
    seen.push(req);
    const question = String(req.input.question ?? "");
    if (req.role === "answer") {
      if (question === q1.question) return "问题一首轮回答";
      if (question === "补充反例条件") {
        q1t2Attempt++;
        return q1t2Attempt === 1 ? "问题一第二轮初版" : "问题一第二轮修订最终版";
      }
      if (question === q2.question) return "问题二首轮回答";
      if (question === q3.question) return "问题三首轮回答";
      if (question === "第三题追问") return "问题三第二轮回答";
      if (question === q4.question) return "问题四首轮回答";
      throw new Error(`unexpected answer question: ${question}`);
    }
    if (req.role === "judge") {
      if (question === "补充反例条件" && req.input.answer === "问题一第二轮初版") {
        return JSON.stringify({ decision: "revise", issues: ["不够充分"], feedback: "请正面回应反例" });
      }
      if (question === "第三题追问") {
        return JSON.stringify({ decision: "revise", issues: ["跑题"], feedback: "重新扣题" });
      }
      return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
    }
    if (req.role === "followup") {
      const history = req.input.history as Array<{ role: string; content: string }>;
      const firstQ = history[0]?.content;
      if (firstQ === q1.question) return JSON.stringify({ action: "followup", user: "补充反例条件" });
      if (firstQ === q2.question) return JSON.stringify({ action: "stop" });
      if (firstQ === q3.question) return JSON.stringify({ action: "followup", user: "第三题追问" });
      if (firstQ === q4.question) return "not valid json";
      throw new Error(`unexpected followup history: ${firstQ}`);
    }
    throw new Error(`unexpected role: ${req.role}`);
  };

  const summary = await runDialogueBatch({
    store,
    runRole,
    prompts: { answer: "回答提示词", judge: "质检提示词", followup: "追问提示词" },
    maxAttempts: 2,
    maxTurns: 2,
    config: { mode: "unit-test" },
  });

  assert.equal(summary.integrityOk, true);
  assert.equal(summary.questions, 4);
  assert.equal(summary.results, 2);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.outcomes, { pass: 2, exhausted: 1, error: 1 });

  // No dangling running records anywhere
  for (const table of ["runs", "run_items", "turns", "attempts", "model_calls"]) {
    const running = (storeConnection(store).prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE status = 'running'`).get() as { c: number }).c;
    assert.equal(running, 0, `${table} must have zero running rows`);
  }

  // Exported samples: q1 has 2 turns (4 messages), q2 has 1 turn (2 messages), q3 & q4 excluded
  const samples = store.exportRunSamples(summary.runId);
  assert.deepEqual(samples, [
    {
      messages: [
        { role: "user", content: "问题一（两轮通过）" },
        { role: "assistant", content: "问题一首轮回答" },
        { role: "user", content: "补充反例条件" },
        { role: "assistant", content: "问题一第二轮修订最终版" },
      ],
    },
    {
      messages: [
        { role: "user", content: "问题二（追问停止保留1轮）" },
        { role: "assistant", content: "问题二首轮回答" },
      ],
    },
  ]);

  // Verify multi-turn answer wire input places stable prefix keys (material -> history) before question/revision fields
  const turn2Answers = seen.filter((r) => r.role === "answer" && r.input.question === "补充反例条件");
  assert.deepEqual(Object.keys(turn2Answers[0].input), ["material", "history", "question"]);
  assert.deepEqual(Object.keys(turn2Answers[1].input), ["material", "history", "question", "previousAnswer", "feedback"]);

  // Verify Q4 raw malformed output was preserved in model_calls
  const failedFollowup = storeConnection(store).prepare(
    "SELECT status, output_text, error FROM model_calls WHERE role = 'followup' AND status = 'error'",
  ).get() as { status: string; output_text: string; error: string };
  assert.equal(failedFollowup.output_text, "not valid json");
  assert.ok(failedFollowup.error.includes("model_output_invalid"));
});

test("runDialogueBatch executes questions concurrently up to limit, isolates errors, and exports deterministically", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const mat = store.upsertMaterial({ videoId: "BV-conc/P001", content: "并发测试原文" });
  const ids = [1, 2, 3, 4, 5];
  for (const id of ids) {
    store.insertQuestion({ id, materialId: mat.id, question: `并发问题 ${id}` });
  }

  let inFlight = 0;
  let peakInFlight = 0;

  const runRole = async (req: RoleRequest): Promise<string> => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      const q = String(req.input.question ?? "");
      // Make earlier questions slower so later questions finish first (out-of-order completion).
      const num = Number(q.replace(/\D+/g, "")) || 1;
      const delayMs = req.role === "answer" ? (6 - num) * 15 : 5;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (num === 3 && req.role === "answer") {
        throw new Error("simulated q3 network failure");
      }
      if (req.role === "answer") return `回答 ${num}`;
      return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
    } finally {
      inFlight--;
    }
  };

  const summary = await runDialogueBatch({
    store,
    runRole,
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 2,
    maxTurns: 1,
    concurrency: 3,
    config: { mode: "concurrency-test" },
  });

  assert.equal(peakInFlight, 3, "should genuinely execute 3 questions concurrently");
  assert.equal(summary.concurrency, 3);
  assert.equal(summary.integrityOk, true);
  assert.equal(summary.errors, 1);
  assert.equal(summary.results, 4);
  assert.deepEqual(summary.outcomes, { pass: 4, error: 1 });

  // Exported samples must remain deterministically ordered by question_id despite out-of-order completion
  const exported = store.exportRunSamples(summary.runId);
  assert.deepEqual(exported.map((s) => s.messages[0].content), [
    "并发问题 1",
    "并发问题 2",
    "并发问题 4",
    "并发问题 5",
  ]);
  const runRow = storeConnection(store).prepare("SELECT config_json FROM runs WHERE id = ?").get(summary.runId) as { config_json: string };
  assert.equal((JSON.parse(runRow.config_json) as { concurrency: number }).concurrency, 3);

  // Follow-up run with onlyUnjudged=true at maxTurns=1 should pick ONLY failed q3 (plus any new q6), skipping passed q1,q2,q4,q5!
  store.insertQuestion({ id: 6, materialId: mat.id, question: "新增问题 6" });
  const seenUnjudged: string[] = [];
  const retrySummary = await runDialogueBatch({
    store,
    runRole: async (req) => {
      if (req.role === "answer") {
        seenUnjudged.push(String(req.input.question));
        return "补跑回答";
      }
      return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
    },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 2,
    maxTurns: 1,
    onlyUnjudged: true,
    config: { mode: "unjudged-retry" },
  });
  assert.deepEqual(seenUnjudged.sort(), ["并发问题 3", "新增问题 6"]);
  assert.equal(retrySummary.questions, 2);
  assert.equal(retrySummary.results, 2);

  // At maxTurns=2, questions only judged at maxTurns=1 are still unjudged for 2-turn runs!
  const seenTwoTurn: string[] = [];
  const twoTurnSummary = await runDialogueBatch({
    store,
    runRole: async (req) => {
      if (req.role === "answer" && req.input.history === undefined) {
        seenTwoTurn.push(String(req.input.question));
        return "首轮回答";
      }
      if (req.role === "followup") return JSON.stringify({ action: "stop" });
      return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
    },
    prompts: { answer: "回答", judge: "质检", followup: "追问" },
    maxAttempts: 2,
    maxTurns: 2,
    onlyUnjudged: true,
    questionIds: [1, 2],
    config: { mode: "unjudged-2turn" },
  });
  assert.deepEqual(seenTwoTurn.sort(), ["并发问题 1", "并发问题 2"]);
  assert.equal(twoTurnSummary.results, 2);
});

test("same-material warmup serializes only the first answer call before fanning out and releases on failure", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const mat = store.upsertMaterial({ videoId: "BV-warm/P001", content: "缓存预热原文" });
  for (const id of [1, 2, 3, 4]) {
    store.insertQuestion({ id, materialId: mat.id, question: `预热问题 ${id}` });
  }

  let firstAnswerFinished = false;
  let answerStartsBeforeFirstFinished = 0;
  let answerInFlight = 0;
  let peakAnswerInFlight = 0;

  const summary = await runDialogueBatch({
    store,
    runRole: async (req) => {
      if (req.role === "answer") {
        if (!firstAnswerFinished) answerStartsBeforeFirstFinished++;
        answerInFlight++;
        peakAnswerInFlight = Math.max(peakAnswerInFlight, answerInFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (req.input.question === "预热问题 1") {
            // Even if the warmup call throws, remaining workers must be released cleanly!
            throw new Error("warmup call simulated failure");
          }
          return `回答：${String(req.input.question)}`;
        } finally {
          answerInFlight--;
          if (req.input.question === "预热问题 1") firstAnswerFinished = true;
        }
      }
      return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
    },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 1,
    maxTurns: 1,
    concurrency: 4,
    config: { mode: "warmup-test" },
  });

  assert.equal(answerStartsBeforeFirstFinished, 1, "only 1 warmup answer call should start before first finishes");
  assert.equal(peakAnswerInFlight, 3, "remaining 3 questions should fan out in parallel right after warmup releases");
  assert.equal(summary.errors, 1);
  assert.equal(summary.results, 3);
  assert.equal(summary.integrityOk, true);
});

test("question-cli, judge-cli (--max-turns 2 --export) and export-cli work end-to-end against unified SQLite", async (t) => {
  const dir = await tempDir(t);
  const dbPath = join(dir, "unified.sqlite");
  const transcriptPath = join(dir, "P001.md");
  const exportPath = join(dir, "train.jsonl");
  await writeFile(transcriptPath, "关于自由主义和保守主义的简短测试文稿。", "utf8");

  let step = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      const current = step++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (current === 0) {
        // question-cli tool call: save_questions
        const args = JSON.stringify({ video_id: "BV-e2e/P001", questions: ["核心立场是什么？"] });
        res.write(`data: ${JSON.stringify({
          id: "q", object: "chat.completion.chunk", created: 1, model: "fixture",
          choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "tc_1", type: "function", function: { name: "save_questions", arguments: args } }] }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "q", object: "chat.completion.chunk", created: 1, model: "fixture",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      const outputs = [
        "我的核心立场是区分不同政治态度。",
        '{"decision":"pass","issues":[],"feedback":""}',
        '{"action":"followup","user":"如果出现反例你怎么看？"}',
        "遇到反例时，要回到具体前提重新检验。",
        '{"decision":"pass","issues":[],"feedback":""}',
      ];
      const text = outputs[current - 1];
      res.write(`data: ${JSON.stringify({
        id: `s${current}`, object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: `s${current}`, object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected TCP address");

  const env = {
    LLM_BASE_URL: `http://127.0.0.1:${addr.port}/v1`,
    LLM_MAX_TOKENS: "256",
    LLM_CONTEXT_WINDOW: "32768",
    LLM_TIMEOUT_MS: "5000",
  };

  // 1. Run synth questions into unified SQLite
  const qRes = await runCli("src/cli/index.ts", ["synth", "questions", "--input", transcriptPath, "--db", dbPath, "--video-id", "BV-e2e/P001"], env);
  assert.equal(qRes.code, 0, qRes.stderr);

  // 2. Run synth judge with --max-turns 2 and --export + --system
  const jRes = await runCli(
    "src/cli/index.ts",
    ["synth", "judge", "--db", dbPath, "--max-turns", "2", "--max-attempts", "2", "--export", exportPath, "--system", "你是作者本人。"],
    env,
  );
  assert.equal(jRes.code, 0, jRes.stderr);

  // Verify exported JSONL is single-line multi-turn with system prompt
  const exportedText = await readFile(exportPath, "utf8");
  const lines = exportedText.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    messages: [
      { role: "system", content: "你是作者本人。" },
      { role: "user", content: "核心立场是什么？" },
      { role: "assistant", content: "我的核心立场是区分不同政治态度。" },
      { role: "user", content: "如果出现反例你怎么看？" },
      { role: "assistant", content: "遇到反例时，要回到具体前提重新检验。" },
    ],
  });

  // 3. Running synth judge again with --only-unjudged skips already-judged 2-turn question with 0 extra model calls
  const callsBeforeSkip = step;
  const skipRes = await runCli(
    "src/cli/index.ts",
    ["synth", "judge", "--db", dbPath, "--max-turns", "2", "--only-unjudged"],
    env,
  );
  assert.equal(skipRes.code, 0, skipRes.stderr);
  assert.equal(step, callsBeforeSkip, "--only-unjudged must not invoke model when all questions are judged");
  assert.match(skipRes.stdout, /"selectedQuestions": 0/);

  // 4. Verify synth export independently without --system and with --all-formal + --manifest
  const exportNoSysPath = join(dir, "train-no-sys.jsonl");
  const eRes = await runCli("src/cli/index.ts", ["synth", "export", "--db", dbPath, "--run", "2", "--out", exportNoSysPath]);
  assert.equal(eRes.code, 0, eRes.stderr);
  const noSysLine = JSON.parse((await readFile(exportNoSysPath, "utf8")).trimEnd()) as { messages: Array<{ role: string; content: string }> };
  assert.equal(noSysLine.messages.length, 4);
  assert.equal(noSysLine.messages[0].role, "user");

  const allFormalOut = join(dir, "train-all-formal.jsonl");
  const manifestOut = join(dir, "train-manifest.json");
  const allRes = await runCli("src/cli/index.ts", [
    "synth", "export", "--db", dbPath, "--all-formal", "--out", allFormalOut, "--manifest", manifestOut,
  ]);
  assert.equal(allRes.code, 0, allRes.stderr);
  const manifest = JSON.parse(await readFile(manifestOut, "utf8")) as {
    mode: string; trainSamples: number; includedRunIds: number[]; materialCount: number;
  };
  assert.equal(manifest.mode, "all-formal");
  assert.equal(manifest.trainSamples, 1);
  assert.deepEqual(manifest.includedRunIds, [2]);
  assert.equal(manifest.materialCount, 1);

  const tsOutBase = join(dir, "train-ts.jsonl");
  const tsManifestBase = join(dir, "train-ts-manifest.json");
  const tsRes = await runCli("src/cli/index.ts", [
    "synth", "export", "--db", dbPath, "--all-formal", "--out", tsOutBase, "--manifest", tsManifestBase, "--timestamp",
  ]);
  assert.equal(tsRes.code, 0, tsRes.stderr);
  const tsReport = JSON.parse(tsRes.stdout) as {
    timestamp: string; out: string; manifest: string; trainSamples: number;
  };
  assert.match(tsReport.timestamp, /^\d{8}-\d{6}$/);
  assert.equal(tsReport.out, join(dir, `train-ts-${tsReport.timestamp}.jsonl`));
  assert.equal(tsReport.manifest, join(dir, `train-ts-manifest-${tsReport.timestamp}.json`));
  assert.equal(tsReport.trainSamples, 1);
  const tsWritten = (await readFile(tsReport.out, "utf8")).trimEnd();
  assert.equal(tsWritten.length > 0, true);
  const tsManifest = JSON.parse(await readFile(tsReport.manifest, "utf8")) as { timestamp: string; out: string };
  assert.equal(tsManifest.timestamp, tsReport.timestamp);
  assert.equal(tsManifest.out, tsReport.out);

  // 4. Verify DB integrity, loaded ready Skills, training_enabled=true, and zero leaked API key
  const store = new DataMakerStore(dbPath, { readOnly: true });
  try {
    assert.equal(store.checkIntegrity().ok, true);
    const runs = storeConnection(store).prepare("SELECT kind, status, config_json, skills_json, export_policy_json FROM runs ORDER BY id").all() as Array<{
      kind: string; status: string; config_json: string; skills_json: string; export_policy_json: string;
    }>;
    assert.deepEqual(runs.map((r) => [r.kind, r.status]), [
      ["question_generation", "completed"],
      ["answer_judge", "completed"],
    ]);
    assert.deepEqual((JSON.parse(runs[0].skills_json) as Array<{ name: string; status: string }>).map((s) => [s.name, s.status]), [
      ["question-design", "ready"],
    ]);
    assert.deepEqual((JSON.parse(runs[1].skills_json) as Array<{ name: string; status: string }>).map((s) => [s.name, s.status]), [
      ["answer-style", "ready"],
      ["quality-judge", "ready"],
      ["followup-strategy", "ready"],
    ]);
    assert.deepEqual(JSON.parse(runs[1].export_policy_json), { format: "messages_jsonl", training_enabled: true });
    for (const run of runs) {
      assert.equal(run.config_json.includes("fixture-secret-key"), false);
    }
  } finally {
    store.close();
  }
});

test("createUnifiedSaveQuestionsTool enforces maxQuestions hard cap and counts excess in skipped_count", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const mat = store.upsertMaterial({ videoId: "BV-cap", content: "短文稿" });
  const runId = store.createRun({
    kind: "question_generation",
    maxAttempts: 1,
    maxTurns: 1,
    config: {},
    prompts: { question: "p" },
    skills: [],
    exportPolicy: { format: "messages_jsonl", training_enabled: false },
  });

  const receipts: unknown[] = [];
  const tool = createUnifiedSaveQuestionsTool(
    store,
    mat.id,
    "BV-cap",
    runId,
    (r) => receipts.push(r),
    { maxQuestions: 3 },
  );
  await tool.execute("c1", {
    video_id: "BV-cap",
    questions: ["问题1？", "问题2？", "问题3？", "问题4？", "问题5？"],
  });

  assert.deepEqual(receipts, [{ video_id: "BV-cap", saved_count: 3, skipped_count: 2 }]);
  const saved = storeConnection(store).prepare("SELECT question FROM questions WHERE material_id = ? ORDER BY id").all(mat.id) as Array<{ question: string }>;
  assert.deepEqual(saved.map((r) => r.question), ["问题1？", "问题2？", "问题3？"]);
});

test("runDialogueBatch lets followup Agent decide turn counts naturally and passes material to judge without targetLength", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const mat = store.upsertMaterial({ videoId: "BV-agent-loop", content: "测试 Agent Loop 自主收束与有稿核验的文稿正文" });
  store.insertQuestion({ id: 1, materialId: mat.id, question: "问题1（一轮即止）" });
  store.insertQuestion({ id: 2, materialId: mat.id, question: "问题2（两轮收束）" });
  store.insertQuestion({ id: 3, materialId: mat.id, question: "问题3（三轮展开）" });

  const summary = await runDialogueBatch({
    store,
    runRole: async (req) => {
      assert.equal("targetLength" in req.input, false, `${req.role} should not receive static targetLength`);
      if (req.role === "answer") {
        assert.equal(req.input.material, mat.content);
        return `回答：${String(req.input.question)}`;
      }
      if (req.role === "judge") {
        assert.equal(req.input.material, mat.content);
        assert.equal(Object.keys(req.input)[0], "material", "judge should keep material first for KV prefix cache");
        return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
      }
      if (req.role === "followup") {
        const history = req.input.history as Array<{ role: string; content: string }>;
        const firstQ = history[0]?.content ?? "";
        const completedTurns = history.length / 2;
        if (firstQ.includes("问题1")) return JSON.stringify({ action: "stop" });
        if (firstQ.includes("问题2") && completedTurns >= 2) return JSON.stringify({ action: "stop" });
        return JSON.stringify({ action: "followup", user: `第 ${completedTurns + 1} 轮自然追问` });
      }
      throw new Error(`unexpected role: ${req.role}`);
    },
    prompts: { answer: "回答", judge: "质检", followup: "追问" },
    maxAttempts: 1,
    maxTurns: 3,
    config: { mode: "agent-loop-test" },
  });

  assert.equal(summary.integrityOk, true);
  assert.equal(summary.results, 3);

  const dbDist = storeConnection(store).prepare(
    "SELECT turn_count, COUNT(*) AS c FROM results WHERE run_item_id IN (SELECT id FROM run_items WHERE run_id = ?) GROUP BY turn_count ORDER BY turn_count",
  ).all(summary.runId) as Array<{ turn_count: number; c: number }>;
  assert.deepEqual(dbDist.map((r) => [r.turn_count, Number(r.c)]), [
    [1, 1],
    [2, 1],
    [3, 1],
  ]);

  // Judge model_calls record material reference in input_refs_json without duplicating raw text
  const judgeCalls = storeConnection(store).prepare(
    "SELECT input_refs_json FROM model_calls WHERE run_id = ? AND role = 'judge'",
  ).all(summary.runId) as Array<{ input_refs_json: string }>;
  assert.equal(judgeCalls.length, 6);
  for (const row of judgeCalls) {
    assert.equal(row.input_refs_json.includes(mat.content), false);
    const refs = JSON.parse(row.input_refs_json) as { material?: { material_id: number; field: string } };
    assert.deepEqual(refs.material, { material_id: mat.id, field: "content" });
  }
});

test("runDialogueBatch retries transient empty/malformed model errors up to callMaxAttempts and drops only persistent failures", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  const mat = store.upsertMaterial({ videoId: "BV-retry", content: "重试机制测试文稿" });
  store.insertQuestion({ id: 1, materialId: mat.id, question: "问题1：空正文重试后恢复" });
  store.insertQuestion({ id: 2, materialId: mat.id, question: "问题2：质检DSML串台重试后恢复" });
  store.insertQuestion({ id: 3, materialId: mat.id, question: "问题3：连续3次仍失败则丢弃" });

  const calls: Record<string, number> = {};
  const logs: string[] = [];
  const startMs = Date.now();

  const summary = await runDialogueBatch({
    store,
    runRole: async (req) => {
      const q = String(req.input.question ?? "");
      const key = `${q}:${req.role}`;
      calls[key] = (calls[key] ?? 0) + 1;
      const n = calls[key];

      if (q.startsWith("问题1")) {
        if (req.role === "answer") {
          if (n === 1) throw new Error("模型返回空正文");
          return "问题1重试后恢复的回答";
        }
        return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
      }
      if (q.startsWith("问题2")) {
        if (req.role === "answer") return "问题2正常回答";
        if (req.role === "judge") {
          if (n <= 2) return '{"decision":"revise","issues":["x"]</｜DSML｜ parameter>';
          return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
        }
      }
      if (q.startsWith("问题3")) {
        if (req.role === "answer") throw new Error("模型返回空正文");
      }
      throw new Error(`unexpected call ${key}`);
    },
    prompts: { answer: "回答", judge: "质检" },
    maxAttempts: 2,
    maxTurns: 1,
    callMaxAttempts: 3,
    callRetryDelayMs: 25,
    config: { mode: "retry-test" },
    onProgress: (msg) => logs.push(msg),
  });

  const elapsedMs = Date.now() - startMs;
  // Total retry sleeps: q1(1) + q2(2) + q3(2) = 5 sleeps * 25ms >= 100ms
  assert.ok(elapsedMs >= 100, `expected retry delays to be awaited, got ${elapsedMs}ms`);
  assert.equal(summary.integrityOk, true);
  assert.equal(summary.results, 2);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.outcomes, { pass: 2, error: 1 });

  assert.equal(calls["问题1：空正文重试后恢复:answer"], 2);
  assert.equal(calls["问题2：质检DSML串台重试后恢复:judge"], 3);
  assert.equal(calls["问题3：连续3次仍失败则丢弃:answer"], 3);

  // Q1 and Q2 exported cleanly; Q3 dropped
  const samples = store.exportRunSamples(summary.runId);
  assert.deepEqual(samples.map((s) => s.messages[0].content), [
    "问题1：空正文重试后恢复",
    "问题2：质检DSML串台重试后恢复",
  ]);

  // The item keeps a public code; the call audit keeps the controlled retry count.
  const failedItem = storeConnection(store).prepare(
    "SELECT status, error FROM run_items WHERE run_id = ? AND question_id = 3",
  ).get(summary.runId) as { status: string; error: string };
  assert.equal(failedItem.status, "error");
  assert.match(failedItem.error, /unexpected_error/);
  const failedCall = storeConnection(store).prepare(
    "SELECT error FROM model_calls WHERE run_id = ? AND status = 'error'",
  ).get(summary.runId) as { error: string };
  assert.match(failedCall.error, /重试 3 次后仍失败/);
  assert.ok(logs.some((l) => l.includes("调用失败（第 1/3 次）")));
  assert.ok(logs.some((l) => l.includes("已丢弃本题")));
});
