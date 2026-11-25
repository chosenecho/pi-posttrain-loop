import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DataMakerStore } from "../src/db.js";
import {
  createSaveQuestionsTool,
  createUnifiedSaveQuestionsTool,
} from "../src/question-store.js";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE questions (id INTEGER PRIMARY KEY, video_id TEXT NOT NULL, question TEXT NOT NULL)");
  return db;
}

test("save_questions persists parameterized text, trims and skips exact duplicates", async (t) => {
  const db = database();
  t.after(() => db.close());
  const receipts: unknown[] = [];
  const tool = createSaveQuestionsTool(db, "BV-test/P001", (receipt) => receipts.push(receipt));
  await tool.execute("call-1", { video_id: "BV-test/P001", questions: [" 问题一？ ", "问题一？", "What's your approach?"] });
  await tool.execute("call-2", { video_id: "BV-test/P001", questions: ["问题一？"] });
  assert.deepEqual(receipts, [
    { video_id: "BV-test/P001", saved_count: 2, skipped_count: 1 },
    { video_id: "BV-test/P001", saved_count: 0, skipped_count: 1 },
  ]);
  assert.deepEqual(db.prepare("SELECT question FROM questions ORDER BY id").all().map((row) => row.question), ["问题一？", "What's your approach?"]);
  const other = createSaveQuestionsTool(db, "BV-other/P001", () => {});
  await other.execute("call-3", { video_id: "BV-other/P001", questions: ["问题一？"] });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions").get()?.n, 3);
});

test("save_questions rejects mismatched source or invalid questions without partial inserts", async (t) => {
  const db = database();
  t.after(() => db.close());
  const tool = createSaveQuestionsTool(db, "BV-test/P001", () => assert.fail("unexpected success"));
  await assert.rejects(tool.execute("call-1", { video_id: "wrong", questions: ["问题？"] }), /video_id/);
  await assert.rejects(tool.execute("call-2", { video_id: "BV-test/P001", questions: ["问题？", " "] }), /questions/);
  await assert.rejects(tool.execute("call-3", { video_id: "BV-test/P001", questions: [42] }), /questions/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions").get()?.n, 0);
});

test("save_questions accepts an empty array and rolls back the whole batch on database failure", async (t) => {
  const db = database();
  t.after(() => db.close());
  const tool = createSaveQuestionsTool(db, "BV-test/P001", () => {});
  const result = await tool.execute("empty", { video_id: "BV-test/P001", questions: [] });
  assert.deepEqual(result.details, { video_id: "BV-test/P001", saved_count: 0, skipped_count: 0 });
  db.exec(`CREATE TRIGGER reject_bad BEFORE INSERT ON questions
    WHEN NEW.question = 'bad' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  await assert.rejects(tool.execute("call-1", { video_id: "BV-test/P001", questions: ["问题？", "bad"] }), /fixture failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions").get()?.n, 0);
});

test("unified save_questions enforces structural cap/dedup without static regex rejections", async (t) => {
  const store = new DataMakerStore(":memory:");
  t.after(() => store.close());
  const mat = store.upsertMaterial({ videoId: "BV-save", content: "文稿" });
  const runId = store.createRun({
    kind: "question_generation",
    maxAttempts: 1,
    maxTurns: 1,
    config: {},
    prompts: { question: "p" },
    skills: [],
    exportPolicy: { training_enabled: false },
  });
  const receipts: unknown[] = [];
  const tool = createUnifiedSaveQuestionsTool(store, mat.id, "BV-save", runId, (r) => receipts.push(r), {
    maxQuestions: 3,
  });

  const batch = [
    "你把形式和质料区分开之后，这里面最关键的张力体现在哪？",
    "亚里士多德的范畴表究竟从哪来的？",
    "很多人觉得焦虑纯粹是心态不好，这种说法为什么经不起推敲？",
    "超出上限的第四题会被静默截断计数到 skipped_count",
  ];

  await tool.execute("c-save", { video_id: "BV-save", questions: batch });
  assert.deepEqual(receipts, [{ video_id: "BV-save", saved_count: 3, skipped_count: 1 }]);
});
