import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DataMakerStore, normalizeText, sha256Hex } from "../src/db.js";
import { migrateTrialToSqlite } from "../src/migrate.js";

async function createMigrationFixtures(rootDir: string): Promise<{
  sourceQuestionsDbPath: string;
  trialDir: string;
}> {
  const sourceQuestionsDbPath = join(rootDir, "questions.sqlite");
  const trialDir = join(rootDir, "database-trial-CkXhqo");
  await mkdir(trialDir, { recursive: true });

  const videoId = "BV1fixture01";
  const materialText = normalizeText("这是一份用于迁移验证的示例材料正文。");
  const materialSha = sha256Hex(materialText);

  const questions = Array.from({ length: 12 }, (_, idx) => ({
    id: idx + 1,
    video_id: videoId,
    question: `测试迁移问题 ${idx + 1}？`,
  }));

  const legacyDb = new DatabaseSync(sourceQuestionsDbPath);
  try {
    legacyDb.exec(
      "CREATE TABLE questions (id INTEGER PRIMARY KEY, video_id TEXT NOT NULL, question TEXT NOT NULL);",
    );
    const ins = legacyDb.prepare("INSERT INTO questions (id, video_id, question) VALUES (?, ?, ?)");
    for (const q of questions) {
      ins.run(q.id, q.video_id, q.question);
    }
  } finally {
    legacyDb.close();
  }

  const attemptsPlan = new Map<number, { attempts: number; status: "pass" | "exhausted" }>([
    [4, { attempts: 2, status: "pass" }],
    [7, { attempts: 3, status: "exhausted" }],
    [8, { attempts: 3, status: "pass" }],
    [12, { attempts: 3, status: "pass" }],
  ]);

  const rounds: unknown[] = [];
  const outcomes: unknown[] = [];
  const results: unknown[] = [];
  const traces: unknown[] = [];

  for (const q of questions) {
    const plan = attemptsPlan.get(q.id) ?? { attempts: 1, status: "pass" as const };
    let finalAnswer = "";
    let finalReview: { decision: "pass" | "revise"; issues: string[]; feedback: string } = {
      decision: "pass",
      issues: [],
      feedback: "",
    };

    for (let attempt = 1; attempt <= plan.attempts; attempt++) {
      const isLast = attempt === plan.attempts;
      const decision = isLast && plan.status === "pass" ? "pass" : "revise";
      const review =
        decision === "pass"
          ? { decision: "pass" as const, issues: [], feedback: "" }
          : { decision: "revise" as const, issues: ["需补充细节"], feedback: "请结合材料补充机制说明" };
      const answer = `针对问题 ${q.id} 的第 ${attempt} 版回答。`;
      finalAnswer = answer;
      finalReview = review;

      const t0 = `2026-03-01T00:${String(q.id).padStart(2, "0")}:${String(attempt * 4 - 3).padStart(2, "0")}.000Z`;
      const t1 = `2026-03-01T00:${String(q.id).padStart(2, "0")}:${String(attempt * 4 - 2).padStart(2, "0")}.000Z`;
      const t2 = `2026-03-01T00:${String(q.id).padStart(2, "0")}:${String(attempt * 4 - 1).padStart(2, "0")}.000Z`;
      const t3 = `2026-03-01T00:${String(q.id).padStart(2, "0")}:${String(attempt * 4).padStart(2, "0")}.000Z`;

      rounds.push({
        questionId: q.id,
        videoId: q.video_id,
        question: q.question,
        attempt,
        answer,
        review,
      });

      traces.push(
        {
          timestamp: t0,
          type: "role_start",
          questionId: q.id,
          videoId: q.video_id,
          attempt,
          role: "answer",
          input: { question: q.question },
        },
        {
          timestamp: t1,
          type: "role_result",
          questionId: q.id,
          videoId: q.video_id,
          attempt,
          role: "answer",
          output: answer,
        },
        {
          timestamp: t2,
          type: "role_start",
          questionId: q.id,
          videoId: q.video_id,
          attempt,
          role: "judge",
          input: { question: q.question, answer },
        },
        {
          timestamp: t3,
          type: "role_result",
          questionId: q.id,
          videoId: q.video_id,
          attempt,
          role: "judge",
          output: JSON.stringify(review),
        },
      );
    }

    const outcome = {
      questionId: q.id,
      videoId: q.video_id,
      question: q.question,
      status: plan.status,
      attempts: plan.attempts,
      answer: finalAnswer,
      review: finalReview,
    };
    outcomes.push(outcome);
    if (plan.status === "pass") {
      results.push(outcome);
    }
  }

  const runManifest = {
    mode: "live",
    startedAt: "2026-03-01T00:00:00.000Z",
    databasePath: "data/questions.sqlite",
    databaseSha256: "fixture-db-sha",
    materialRoot: "data/weimingzi-semantic",
    skills: [],
    maxAttempts: 3,
    trainingEnabled: false,
    questionCount: 12,
    promptDirectory: "prompts/no-skill",
    systemPrompts: { answer: "回答系统提示词", judge: "质检系统提示词" },
    model: {
      baseUrl: "http://127.0.0.1:3425/v1",
      modelId: "fixture-model",
      apiKey: "should-be-stripped",
      LLM_API_KEY: "should-be-stripped",
    },
    reviewScope: "no-skill-trial",
  };

  const summary = {
    startedAt: "2026-03-01T00:00:00.000Z",
    finishedAt: "2026-03-01T00:30:00.000Z",
    state: "completed",
    questions: 12,
    completed: 12,
    modelCalls: traces.length / 2,
    rounds: rounds.length,
    passed: 11,
    dropped: 0,
    exhausted: 1,
    errors: 0,
    results: 11,
  };

  const toJsonl = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";

  await writeFile(join(trialDir, "run.json"), JSON.stringify(runManifest, null, 2), "utf8");
  await writeFile(join(trialDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await writeFile(
    join(trialDir, "materials.jsonl"),
    toJsonl([{ videoId, path: "data/weimingzi-semantic/by_bv/BV1fixture01.md", sha256: materialSha, text: materialText }]),
    "utf8",
  );
  await writeFile(join(trialDir, "questions.jsonl"), toJsonl(questions), "utf8");
  await writeFile(join(trialDir, "rounds.jsonl"), toJsonl(rounds), "utf8");
  await writeFile(join(trialDir, "outcomes.jsonl"), toJsonl(outcomes), "utf8");
  await writeFile(join(trialDir, "results.jsonl"), toJsonl(results), "utf8");
  await writeFile(join(trialDir, "traces.jsonl"), toJsonl(traces), "utf8");

  return { sourceQuestionsDbPath, trialDir };
}

test("migrates questions.sqlite and database-trial-CkXhqo with exact counts, idempotency, and clean JSONL export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "data-maker-migrate-"));
  const targetDb = join(dir, "data-maker.sqlite");
  try {
    const { sourceQuestionsDbPath, trialDir } = await createMigrationFixtures(dir);
    const first = await migrateTrialToSqlite({
      targetDbPath: targetDb,
      sourceQuestionsDbPath,
      trialDir,
    });

    assert.equal(first.alreadyImported, false);
    assert.equal(first.sourceDbUnchanged, true);
    assert.equal(first.integrityOk, true);
    assert.deepEqual(first.counts, {
      materials: 1,
      questions: 12,
      runs: 1,
      runItems: 12,
      turns: 12,
      attempts: 19,
      modelCalls: 38,
      results: 11,
    });

    // Idempotent second import
    const second = await migrateTrialToSqlite({
      targetDbPath: targetDb,
      sourceQuestionsDbPath,
      trialDir,
    });
    assert.equal(second.alreadyImported, true);
    assert.equal(second.runId, first.runId);
    assert.deepEqual(second.counts, first.counts);
    assert.equal(second.sourceDbUnchanged, true);

    const store = new DataMakerStore(targetDb, { readOnly: true });
    try {
      // Legacy IDs 1..12 preserved with NULL generation_run_id
      const qs = store.db.prepare("SELECT id, generation_run_id FROM questions ORDER BY id").all() as Array<{ id: number; generation_run_id: number | null }>;
      assert.deepEqual(qs.map((q) => q.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.ok(qs.every((q) => q.generation_run_id === null));

      // Verify specific question outcomes from design section 7.5:
      // Q7 exhausted with 0 results; Q4 passed on attempt 2; Q8 & Q12 passed on attempt 3
      const q7Item = store.db.prepare("SELECT id, status FROM run_items WHERE run_id = ? AND question_id = 7").get(first.runId) as { id: number; status: string };
      assert.equal(q7Item.status, "exhausted");
      const q7Result = store.db.prepare("SELECT id FROM results WHERE run_item_id = ?").get(q7Item.id);
      assert.equal(q7Result, undefined);

      const resultRows = store.queryResultTurns(first.runId);
      assert.equal(resultRows.length, 11);
      const attemptByQuestion = new Map(resultRows.map((r) => [r.question_id, r.attempt_no]));
      assert.equal(attemptByQuestion.get(4), 2);
      assert.equal(attemptByQuestion.get(8), 3);
      assert.equal(attemptByQuestion.get(12), 3);
      assert.equal(attemptByQuestion.has(7), false);

      // No API credentials stored in runs
      const runRow = store.db.prepare("SELECT config_json, prompts_json, skills_json FROM runs WHERE id = ?").get(first.runId) as {
        config_json: string; prompts_json: string; skills_json: string;
      };
      assert.equal(runRow.config_json.includes("apiKey"), false);
      assert.equal(runRow.config_json.includes("LLM_API_KEY"), false);
      assert.equal(runRow.skills_json, "[]");

      // Training JSONL export satisfies strict one-line {"messages": [...]} spec
      const jsonl = store.exportRunJsonl(first.runId);
      const lines = jsonl.trimEnd().split("\n");
      assert.equal(lines.length, 11);
      for (const line of lines) {
        const obj = JSON.parse(line) as { messages: Array<{ role: string; content: string }> };
        assert.deepEqual(Object.keys(obj), ["messages"]);
        assert.equal(obj.messages.length, 2);
        assert.equal(obj.messages[0].role, "user");
        assert.equal(obj.messages[1].role, "assistant");
        assert.ok(obj.messages[0].content.trim().length > 0);
        assert.ok(obj.messages[1].content.trim().length > 0);
      }

      const jsonlWithSystem = store.exportRunJsonl(first.runId, { systemPrompt: "系统设定" });
      const firstWithSys = JSON.parse(jsonlWithSystem.trimEnd().split("\n")[0]) as { messages: Array<{ role: string; content: string }> };
      assert.equal(firstWithSys.messages.length, 3);
      assert.deepEqual(firstWithSys.messages[0], { role: "system", content: "系统设定" });
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
