import { storeConnection } from "./fixtures/store-connection.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeQuestionQuota,
  extractVideoKey,
  loadVideoChunks,
  loadVideoUnit,
  mergeVideoParts,
  queryProcessedVideoIndex,
  rankVideosCoreFirst,
  scanCorpusVideos,
  selectVideos,
  summarizeCorpusStatus,
} from "../src/synth/corpus.js";
import { runCorpusQuestionGeneration } from "../src/synth/corpus-questions.js";
import { DataMakerStore } from "../src/synth/store/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "data-maker-corpus-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runQuestionCli(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", "synth", "questions", ...args], {
    cwd: ROOT,
    env: { ...process.env, LLM_API_KEY: "fixture-key", LLM_MODEL: "fixture", ...env },
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

test("extractVideoKey normalizes legacy part IDs and video IDs to the same video key", () => {
  assert.equal(extractVideoKey("BV1Dt4y1Y7S2/P001"), "BV1Dt4y1Y7S2");
  assert.equal(extractVideoKey("BV1Dt4y1Y7S2/P045"), "BV1Dt4y1Y7S2");
  assert.equal(extractVideoKey("BV1Dt4y1Y7S2"), "BV1Dt4y1Y7S2");
  assert.equal(extractVideoKey("youtube/0iLy_lI8H4Y/P001"), "youtube/0iLy_lI8H4Y");
  assert.equal(extractVideoKey("audio/i-abc"), "audio/i-abc");
});

test("mergeVideoParts strips repeated identical top-level titles across parts", () => {
  const merged = mergeVideoParts([
    "# 标题A\n\n## P001\n第一部分正文。",
    "# 标题A\n\n## P002\n第二部分正文。",
    "# 标题A\n\n## P003\n第三部分正文。",
  ]);
  assert.equal(merged, "# 标题A\n\n## P001\n第一部分正文。\n\n## P002\n第二部分正文。\n\n## P003\n第三部分正文。");
  assert.equal(mergeVideoParts(["# 单P标题\r\n正文"]), "# 单P标题\n正文");
});

test("scanCorpusVideos groups multi-P folders as 1 video and excludes legacy/completed videos from selection", async (t) => {
  const dir = await tempDir(t);
  await mkdir(join(dir, "by_bv", "BV_SINGLE"), { recursive: true });
  await mkdir(join(dir, "by_bv", "BV_MULTI"), { recursive: true });
  await mkdir(join(dir, "by_bv", "BV_LEGACY"), { recursive: true });
  await mkdir(join(dir, "youtube", "YT_01"), { recursive: true });
  await mkdir(join(dir, "audio"), { recursive: true });

  await writeFile(join(dir, "by_bv", "BV_SINGLE", "P001.md"), "# 单P\n正文1");
  await writeFile(join(dir, "by_bv", "BV_MULTI", "P001.md"), "# 多P标题\n\n## P001\n段落一");
  await writeFile(join(dir, "by_bv", "BV_MULTI", "P002.md"), "# 多P标题\n\n## P002\n段落二");
  await writeFile(join(dir, "by_bv", "BV_MULTI", "P010.md"), "# 多P标题\n\n## P010\n段落十");
  await writeFile(join(dir, "by_bv", "BV_LEGACY", "P001.md"), "# 旧库已迁移\n正文");
  await writeFile(join(dir, "youtube", "YT_01", "P001.md"), "# YT标题\n油管正文");
  await writeFile(join(dir, "audio", "a1.md"), "# 音频标题\n音频正文");

  const units = await scanCorpusVideos(dir);
  assert.equal(units.length, 5);
  const multi = units.find((u) => u.videoId === "BV_MULTI")!;
  assert.equal(multi.partPaths.length, 3);
  const loadedMulti = await loadVideoUnit(multi);
  assert.equal(loadedMulti.content, "# 多P标题\n\n## P001\n段落一\n\n## P002\n段落二\n\n## P010\n段落十");

  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());

  // Legacy BV_LEGACY/P001 with existing question counts as BV_LEGACY already processed!
  const legacyMat = store.upsertMaterial({ videoId: "BV_LEGACY/P001", content: "# 旧库已迁移\n正文" });
  store.insertQuestion({ materialId: legacyMat.id, question: "已有问题？" });

  // audio/a1 completed with 0 questions also counts as processed!
  const zeroMat = store.upsertMaterial({ videoId: "audio/a1", content: "# 音频标题\n音频正文" });
  const qRunId = store.createRun({
    kind: "question_generation",
    maxAttempts: 1,
    maxTurns: 1,
    config: {},
    prompts: { question: "p" },
    skills: [],
    exportPolicy: { format: "messages_jsonl", training_enabled: false },
  });
  const zeroCall = store.startModelCall({ runId: qRunId, role: "question", materialId: zeroMat.id, inputRefs: {} });
  store.finishModelCall(zeroCall, '{"video_id":"audio/a1","saved_count":0,"skipped_count":0}');
  store.finishRun(qRunId, "completed");

  const status = summarizeCorpusStatus(units, store);
  assert.equal(status.totalVideos, 5);
  assert.equal(status.totalPartFiles, 7);
  assert.equal(status.multiPartVideos, 1);
  assert.equal(status.processedVideos, 2);
  assert.equal(status.unprocessedVideos, 3);
  assert.deepEqual(status.unprocessed.map((u) => u.videoId), ["BV_MULTI", "BV_SINGLE", "youtube/YT_01"]);
  assert.deepEqual(selectVideos(status.unprocessed, { limit: 2 }).map((u) => u.videoId), ["BV_MULTI", "BV_SINGLE"]);
});

test("question-cli --input-dir merges multi-P videos, skips duplicates by video_id and sha256, and never re-calls processed videos", async (t) => {
  const dir = await tempDir(t);
  const corpusDir = join(dir, "corpus");
  const dbPath = join(dir, "unified.sqlite");
  await mkdir(join(corpusDir, "by_bv", "BV_MULTI"), { recursive: true });
  await mkdir(join(corpusDir, "by_bv", "BV_DUP_CONTENT"), { recursive: true });
  await mkdir(join(corpusDir, "youtube", "YT_SAME"), { recursive: true });

  await writeFile(join(corpusDir, "by_bv", "BV_MULTI", "P001.md"), "# 合集\n\n## P001\n上集内容");
  await writeFile(join(corpusDir, "by_bv", "BV_MULTI", "P002.md"), "# 合集\n\n## P002\n下集内容");
  // Same content in both by_bv and youtube to verify cross-directory sha256 dedup!
  await writeFile(join(corpusDir, "by_bv", "BV_DUP_CONTENT", "P001.md"), "# 重复搬运\n完全一致的正文");
  await writeFile(join(corpusDir, "youtube", "YT_SAME", "P001.md"), "# 重复搬运\n完全一致的正文");

  const receivedRequests: Array<{ video_id: string; transcript: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body) as { messages: Array<{ content: string | Array<{ text?: string }> }> };
      const userContent = payload.messages[1].content;
      const userText = typeof userContent === "string" ? userContent : userContent.map((p) => p.text ?? "").join("");
      const input = JSON.parse(userText) as { video_id: string; transcript: string };
      receivedRequests.push(input);
      const args = JSON.stringify({ video_id: input.video_id, questions: [`关于 ${input.video_id} 的问题？`] });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        id: "q", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "tc_1", type: "function", function: { name: "save_questions", arguments: args } }] }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: "q", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
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

  // Run 1: select all 3 videos -> BV_MULTI (merged 2P) + BV_DUP_CONTENT called; youtube/YT_SAME skipped by sha256!
  const first = await runQuestionCli(["--input-dir", corpusDir, "--db", dbPath, "--concurrency", "1"], env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(receivedRequests.length, 2);
  const multiReq = receivedRequests.find((r) => r.video_id === "BV_MULTI")!;
  assert.ok(multiReq.transcript.includes("上集内容") && multiReq.transcript.includes("下集内容"));

  // Run 2: running again with --input-dir skips already-processed BV_MULTI & BV_DUP_CONTENT, and youtube/YT_SAME is still skipped by sha256 -> 0 new calls!
  const second = await runQuestionCli(["--input-dir", corpusDir, "--db", dbPath, "--concurrency", "2"], env);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(receivedRequests.length, 2, "must not re-call model for already-processed videos or duplicate content");

  // Single-file mode on P002.md of BV_MULTI also recognizes BV_MULTI as already processed -> 0 calls!
  const third = await runQuestionCli(["--input", join(corpusDir, "by_bv", "BV_MULTI", "P002.md"), "--db", dbPath], env);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(receivedRequests.length, 2);
  assert.match(third.stdout, /"skipped": true/);
});

test("batch-cli runs end-to-end video selection, question generation, 2-turn judge, export, and skips processed videos on repeat", async (t) => {
  const dir = await tempDir(t);
  const corpusDir = join(dir, "corpus");
  const dbPath = join(dir, "batch.sqlite");
  const exportPath = join(dir, "batch-train.jsonl");
  await mkdir(join(corpusDir, "by_bv", "BV_BATCH"), { recursive: true });
  await writeFile(join(corpusDir, "by_bv", "BV_BATCH", "P001.md"), "# 打包测试\n\n## P001\n上集核心观点");
  await writeFile(join(corpusDir, "by_bv", "BV_BATCH", "P002.md"), "# 打包测试\n\n## P002\n下集补充观点");

  let callCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body) as { tools?: Array<unknown>; messages: Array<{ content: string | Array<{ text?: string }> }> };
      callCount++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (payload.tools && payload.tools.length > 0) {
        const args = JSON.stringify({ video_id: "BV_BATCH", questions: ["上下集核心观点是什么？"] });
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

      const sysRaw = payload.messages[0].content;
      const sysText = typeof sysRaw === "string" ? sysRaw : sysRaw.map((p) => p.text ?? "").join("");
      const userRaw = payload.messages[1].content;
      const userText = typeof userRaw === "string" ? userRaw : userRaw.map((p) => p.text ?? "").join("");
      const userInput = JSON.parse(userText) as Record<string, unknown>;

      let text: string;
      if (sysText.includes("<judging-skill>")) {
        text = '{"decision":"pass","issues":[],"feedback":""}';
      } else if (sysText.includes("<followup-strategy>")) {
        text = '{"action":"followup","user":"下集和上集的衔接点在哪里？"}';
      } else {
        text = userInput.history ? "下集补充了上集的边界条件。" : "上集提出核心观点，下集展开补充。";
      }
      res.write(`data: ${JSON.stringify({
        id: `b${callCount}`, object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: `b${callCount}`, object: "chat.completion.chunk", created: 1, model: "fixture",
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

  const runBatch = async (args: string[]) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", "synth", "run", ...args], {
      cwd: ROOT,
      env: { ...process.env, LLM_API_KEY: "fixture-key", LLM_MODEL: "fixture", ...env },
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
  };

  // Run 1: generates question + runs 2-turn judge + exports 1 strict 2-turn JSONL line
  const first = await runBatch(["--input-dir", corpusDir, "--db", dbPath, "--limit", "5", "--max-turns", "2", "--export", exportPath]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(callCount, 6); // 1 question + 2 answer + 2 judge + 1 followup

  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(exportPath, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    messages: [
      { role: "user", content: "上下集核心观点是什么？" },
      { role: "assistant", content: "上集提出核心观点，下集展开补充。" },
      { role: "user", content: "下集和上集的衔接点在哪里？" },
      { role: "assistant", content: "下集补充了上集的边界条件。" },
    ],
  });

  // Run 2: all videos already processed -> 0 extra model calls!
  const second = await runBatch(["--input-dir", corpusDir, "--db", dbPath, "--limit", "5"]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(callCount, 6);
  assert.match(second.stdout, /"selectedVideos": 0/);
});

test("question CLI keeps unsaved model output in trace without printing it or storing it in error", async (t) => {
  const dir = await tempDir(t);
  const corpusDir = join(dir, "corpus");
  const dbPath = join(dir, "privacy.sqlite");
  await mkdir(join(corpusDir, "by_bv", "BV_PRIVACY"), { recursive: true });
  await writeFile(join(corpusDir, "by_bv", "BV_PRIVACY", "P001.md"), "仅用于隐私回归的合成材料。");
  const marker = "privacy-user@example.invalid fixture-private-token";
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "privacy", choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "privacy", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = await runQuestionCli([
    "--input-dir", corpusDir, "--db", dbPath, "--call-attempts", "2", "--retry-delay-ms", "0",
  ], {
    LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    LLM_MAX_TOKENS: "256", LLM_CONTEXT_WINDOW: "32768", LLM_TIMEOUT_MS: "5000",
  });
  assert.equal(result.code, 1);
  assert.equal(calls, 2);
  assert.match(result.stderr, /model_save_tool_missing/);
  assert.match(result.stderr, /question:call:\d+/);
  for (const value of [marker, "privacy-user@example.invalid", "fixture-private-token"]) {
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(value), false);
  }
  const store = new DataMakerStore(dbPath);
  try {
    const row = storeConnection(store).prepare("SELECT output_text, error FROM model_calls WHERE role = 'question'").get() as { output_text: string; error: string };
    assert.equal(row.output_text, marker);
    assert.match(row.error, /model_save_tool_missing/);
    assert.equal(row.error.includes(marker), false);
  } finally {
    store.close();
  }
});

test("computeQuestionQuota keeps compact v2 quotas (2-6) to maximize corpus video coverage", () => {
  // Single-P tiers: <1500 -> 2, 1500..4999 -> 3, 5000..14999 -> 4, >=15000 -> 5
  assert.equal(computeQuestionQuota(1200, 1), 2);
  assert.equal(computeQuestionQuota(3500, 1), 3);
  assert.equal(computeQuestionQuota(10000, 1), 4);
  assert.equal(computeQuestionQuota(25000, 1), 5);

  // Tiny multi-P slices (9P totaling 3600 chars) do not get inflated bonus
  assert.equal(computeQuestionQuota(3600, 9), 3);

  // Substantial multi-P (4P totaling 11500 chars -> effectiveParts=4 >= 3) gets +1 -> 5; >=15000 gets +1 -> 6
  assert.equal(computeQuestionQuota(11500, 4), 5);
  assert.equal(computeQuestionQuota(20000, 4), 6);

  // Manual maxCap override clamps result
  assert.equal(computeQuestionQuota(25000, 4, 4), 4);
});

test("rankVideosCoreFirst prioritizes substantial multi-P series, then substantial single-P lectures, demoting short clips", async (t) => {
  const dir = await tempDir(t);
  await mkdir(join(dir, "by_bv", "BV_SHORT"), { recursive: true });
  await mkdir(join(dir, "by_bv", "BV_LONG_SINGLE"), { recursive: true });
  await mkdir(join(dir, "by_bv", "BV_MULTI_SERIES"), { recursive: true });

  await writeFile(join(dir, "by_bv", "BV_SHORT", "P001.md"), "短通知".repeat(100));
  await writeFile(join(dir, "by_bv", "BV_LONG_SINGLE", "P001.md"), "长理论单篇".repeat(2000));
  await writeFile(join(dir, "by_bv", "BV_MULTI_SERIES", "P001.md"), "系列课上".repeat(600));
  await writeFile(join(dir, "by_bv", "BV_MULTI_SERIES", "P002.md"), "系列课下".repeat(600));

  const units = await scanCorpusVideos(dir);
  const ranked = await rankVideosCoreFirst(units);
  assert.deepEqual(ranked.map((u) => u.videoId), [
    "BV_MULTI_SERIES",
    "BV_LONG_SINGLE",
    "BV_SHORT",
  ]);
});

test("loadVideoChunks keeps normal multi-P merged and splits oversized multi-P series along part boundaries", async (t) => {
  const dir = await tempDir(t);
  const videoDir = join(dir, "by_bv", "BV_LONG_SERIES");
  await mkdir(videoDir, { recursive: true });

  const p1 = "# 系列课\n\n## P001\n" + "甲".repeat(400);
  const p2 = "# 系列课\n\n## P002\n" + "乙".repeat(400);
  const p3 = "# 系列课\n\n## P003\n" + "丙".repeat(900);
  await writeFile(join(videoDir, "P001.md"), p1);
  await writeFile(join(videoDir, "P002.md"), p2);
  await writeFile(join(videoDir, "P003.md"), p3);

  const [unit] = await scanCorpusVideos(dir);
  assert.equal(unit.videoId, "BV_LONG_SERIES");

  // Default maxChunkChars (32,000) keeps all 3 parts merged as 1 unit
  const singleChunk = await loadVideoChunks(unit);
  assert.equal(singleChunk.length, 1);
  assert.equal(singleChunk[0].videoId, "BV_LONG_SERIES");
  assert.equal(singleChunk[0].partCount, 3);

  // With maxChunkChars = 1000, P001+P002 (~830 chars) merge into P001-P002, and P003 (~920 chars) becomes P003
  const splitChunks = await loadVideoChunks(unit, { maxChunkChars: 1000 });
  assert.equal(splitChunks.length, 2);
  assert.equal(splitChunks[0].videoId, "BV_LONG_SERIES/P001-P002");
  assert.equal(splitChunks[0].partCount, 2);
  assert.equal(splitChunks[1].videoId, "BV_LONG_SERIES/P003");
  assert.equal(splitChunks[1].partCount, 1);

  // extractVideoKey normalizes both range and single-part chunk IDs back to BV_LONG_SERIES
  assert.equal(extractVideoKey(splitChunks[0].videoId), "BV_LONG_SERIES");
  assert.equal(extractVideoKey(splitChunks[1].videoId), "BV_LONG_SERIES");
});

test("per-profile dedup allows running the same video across short, medium, long, xlong, trap independently", async (t) => {
  const dir = await tempDir(t);
  const videoDir = join(dir, "by_bv", "BV_MULTI_PROFILE");
  await mkdir(videoDir, { recursive: true });
  await writeFile(join(videoDir, "P001.md"), "这是一段用于测试多套 Skill 独立去重的视频正文。".repeat(40));

  const units = await scanCorpusVideos(dir);
  assert.equal(units.length, 1);

  const store = new DataMakerStore(join(dir, "multi-profile.sqlite"));
  try {
    const observedMaxQuestions: Record<string, number> = {};
    const makeRunner = (profile: string, questionText: string) =>
      (tools: Array<{ execute: (id: string, input: unknown) => Promise<unknown> }>) =>
        async (req: { input: Record<string, unknown> }) => {
          observedMaxQuestions[profile] = Number(req.input.max_questions);
          await tools[0]!.execute("call-1", {
            video_id: req.input.video_id,
            questions: [questionText],
          });
          return "saved";
        };

    const shortRes = await runCorpusQuestionGeneration({
      store,
      config: { baseUrl: "http://127.0.0.1/v1", apiKey: "k", modelId: "fixture", maxTokens: 256, contextWindow: 8192, timeoutMs: 5000 },
      systemPrompt: "short-q",
      skills: [],
      candidates: units,
      concurrency: 1,
      split: "train",
      profile: "short",
      createRunner: makeRunner("short", "这事靠谱吗？"),
    });
    assert.equal(shortRes.processedVideos, 1);
    assert.equal(shortRes.savedQuestions, 1);
    assert.equal(observedMaxQuestions.short, 8);

    // Same video is marked processed for "short" but NOT for "medium"
    assert.equal(queryProcessedVideoIndex(store, "short").processedVideoKeys.has("BV_MULTI_PROFILE"), true);
    assert.equal(queryProcessedVideoIndex(store, "medium").processedVideoKeys.has("BV_MULTI_PROFILE"), false);

    // Running "medium" on the exact same video must NOT be skipped by sha256 or video_key
    const mediumRes = await runCorpusQuestionGeneration({
      store,
      config: { baseUrl: "http://127.0.0.1/v1", apiKey: "k", modelId: "fixture", maxTokens: 256, contextWindow: 8192, timeoutMs: 5000 },
      systemPrompt: "medium-q",
      skills: [],
      candidates: units,
      concurrency: 1,
      split: "train",
      profile: "medium",
      createRunner: makeRunner("medium", "这种现象背后的运作机制到底是什么？"),
    });
    assert.equal(mediumRes.processedVideos, 1);
    assert.equal(mediumRes.skippedBySha256, 0);
    assert.equal(mediumRes.savedQuestions, 1);
    assert.equal(observedMaxQuestions.medium, 8);
    assert.equal(queryProcessedVideoIndex(store, "medium").processedVideoKeys.has("BV_MULTI_PROFILE"), true);

    // Re-running "short" without --force skips by sha256 under the same profile
    const shortAgain = await runCorpusQuestionGeneration({
      store,
      config: { baseUrl: "http://127.0.0.1/v1", apiKey: "k", modelId: "fixture", maxTokens: 256, contextWindow: 8192, timeoutMs: 5000 },
      systemPrompt: "short-q",
      skills: [],
      candidates: units,
      concurrency: 1,
      split: "train",
      profile: "short",
      createRunner: makeRunner("short-2", "不应被执行"),
    });
    assert.equal(shortAgain.processedVideos, 0);
    assert.equal(shortAgain.skippedBySha256, 1);
  } finally {
    store.close();
  }
});
