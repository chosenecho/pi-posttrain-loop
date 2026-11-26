import assert from "node:assert/strict";
import test from "node:test";
import { DataMakerStore, normalizeText, sha256Hex } from "../src/synth/store/index.js";

function setupStore(): DataMakerStore {
  return new DataMakerStore(":memory:");
}

function createSampleRun(store: DataMakerStore, overrides: { maxAttempts?: number; maxTurns?: number } = {}): number {
  return store.createRun({
    kind: "answer_judge",
    maxAttempts: overrides.maxAttempts ?? 3,
    maxTurns: overrides.maxTurns ?? 1,
    config: { model: { id: "test-model" }, inputSchemaVersion: "v1" },
    prompts: { answer: "回答提示词", judge: "质检提示词" },
    skills: [],
    exportPolicy: { format: "messages_jsonl", training_enabled: false },
  });
}

test("materials deduplicate by normalized (video_id, sha256) and version on edits", () => {
  const store = setupStore();
  try {
    const m1 = store.upsertMaterial({ videoId: "BV1/P001", content: "\uFEFF第一行\r\n第二行", sourcePath: "/a/P001.md" });
    const m1Again = store.upsertMaterial({ videoId: "BV1/P001", content: "第一行\n第二行", sourcePath: "/b/P001.md" });
    assert.equal(m1.id, m1Again.id);
    assert.equal(m1.content, "第一行\n第二行");
    assert.equal(m1.sha256, sha256Hex(normalizeText("第一行\r\n第二行")));

    const m2 = store.upsertMaterial({ videoId: "BV1/P001", content: "第一行\n第二行（修订版）" });
    assert.notEqual(m2.id, m1.id);

    const q1 = store.insertQuestion({ materialId: m1.id, question: "  测试问题  " });
    const q1Dup = store.insertQuestion({ materialId: m1.id, question: "测试问题" });
    const q2 = store.insertQuestion({ materialId: m2.id, question: "测试问题" });
    assert.equal(q1.inserted, true);
    assert.equal(q1Dup.inserted, false);
    assert.equal(q1Dup.record.id, q1.record.id);
    assert.equal(q2.inserted, true);
    assert.notEqual(q2.record.id, q1.record.id);
    assert.equal(store.checkIntegrity().ok, true);
  } finally {
    store.close();
  }
});

test("single-turn flow records only passed results and exports strict single-line JSONL with optional system", () => {
  const store = setupStore();
  try {
    const mat = store.upsertMaterial({ videoId: "BV1/P001", content: "原文正文内容" });
    const qPass = store.insertQuestion({ id: 1, materialId: mat.id, question: "第一题：核心观点是什么？" }).record;
    const qExhaust = store.insertQuestion({ id: 2, materialId: mat.id, question: "第二题：会耗尽的问题" }).record;
    const qDrop = store.insertQuestion({ id: 3, materialId: mat.id, question: "第三题：无效问题" }).record;

    const runId = createSampleRun(store, { maxAttempts: 2, maxTurns: 1 });
    const itemMap = store.createRunItems(runId, [qPass.id, qExhaust.id, qDrop.id]);

    // Question 1: attempt 1 revise -> attempt 2 pass (multiline answer)
    const item1 = itemMap.get(qPass.id)!;
    store.startRunItem(item1);
    const turn1 = store.createTurn({ runItemId: item1, turnNo: 1 });
    const a11 = store.startAttempt({ turnId: turn1, attemptNo: 1 });
    const c11a = store.startModelCall({ runId, role: "answer", turnId: turn1, attemptId: a11, inputRefs: { material: mat.id, question: qPass.id } });
    store.finishModelCall(c11a, "初版回答");
    store.recordAttemptAnswer(a11, "初版回答");
    const c11j = store.startModelCall({ runId, role: "judge", turnId: turn1, attemptId: a11, inputRefs: { question: qPass.id, answer: a11 } });
    store.commitJudgeOutcome({
      runItemId: item1, turnId: turn1, turnNo: 1, attemptId: a11, judgeCallId: c11j,
      judgeOutputText: JSON.stringify({ decision: "revise", issues: ["不够具体"], feedback: "请补充两段解释" }),
      review: { decision: "revise", issues: ["不够具体"], feedback: "请补充两段解释" },
      isFinalTurn: true, exhaustedBudget: false,
    });

    const a12 = store.startAttempt({ turnId: turn1, attemptNo: 2 });
    const c12a = store.startModelCall({ runId, role: "answer", turnId: turn1, attemptId: a12, inputRefs: { material: mat.id, question: qPass.id, previousAnswer: a11, feedback: a11 } });
    const finalAnswer = "第一段回答。\n\n第二段补充细节。";
    store.finishModelCall(c12a, finalAnswer);
    store.recordAttemptAnswer(a12, finalAnswer);
    const c12j = store.startModelCall({ runId, role: "judge", turnId: turn1, attemptId: a12, inputRefs: { question: qPass.id, answer: a12 } });
    const passCommit = store.commitJudgeOutcome({
      runItemId: item1, turnId: turn1, turnNo: 1, attemptId: a12, judgeCallId: c12j,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: true, exhaustedBudget: false,
    });
    assert.ok(passCommit.resultId);

    // Question 2: exhausted after 2 attempts
    const item2 = itemMap.get(qExhaust.id)!;
    store.startRunItem(item2);
    const turn2 = store.createTurn({ runItemId: item2, turnNo: 1 });
    for (const attemptNo of [1, 2]) {
      const att = store.startAttempt({ turnId: turn2, attemptNo });
      const ca = store.startModelCall({ runId, role: "answer", turnId: turn2, attemptId: att, inputRefs: { material: mat.id, question: qExhaust.id } });
      store.finishModelCall(ca, `尝试 ${attemptNo}`);
      store.recordAttemptAnswer(att, `尝试 ${attemptNo}`);
      const cj = store.startModelCall({ runId, role: "judge", turnId: turn2, attemptId: att, inputRefs: { question: qExhaust.id, answer: att } });
      store.commitJudgeOutcome({
        runItemId: item2, turnId: turn2, turnNo: 1, attemptId: att, judgeCallId: cj,
        judgeOutputText: JSON.stringify({ decision: "revise", issues: ["仍不达标"], feedback: "继续修改" }),
        review: { decision: "revise", issues: ["仍不达标"], feedback: "继续修改" },
        isFinalTurn: true, exhaustedBudget: attemptNo === 2,
      });
    }

    // Question 3: drop on attempt 1
    const item3 = itemMap.get(qDrop.id)!;
    store.startRunItem(item3);
    const turn3 = store.createTurn({ runItemId: item3, turnNo: 1 });
    const a31 = store.startAttempt({ turnId: turn3, attemptNo: 1 });
    const c31a = store.startModelCall({ runId, role: "answer", turnId: turn3, attemptId: a31, inputRefs: { material: mat.id, question: qDrop.id } });
    store.finishModelCall(c31a, "无法回答");
    store.recordAttemptAnswer(a31, "无法回答");
    const c31j = store.startModelCall({ runId, role: "judge", turnId: turn3, attemptId: a31, inputRefs: { question: qDrop.id, answer: a31 } });
    store.commitJudgeOutcome({
      runItemId: item3, turnId: turn3, turnNo: 1, attemptId: a31, judgeCallId: c31j,
      judgeOutputText: JSON.stringify({ decision: "drop", issues: ["问题无效"], feedback: "终止" }),
      review: { decision: "drop", issues: ["问题无效"], feedback: "终止" },
      isFinalTurn: true, exhaustedBudget: false,
    });

    store.finishRun(runId, "completed");

    assert.deepEqual(store.queryOutcomeCounts(runId), { pass: 1, exhausted: 1, drop: 1 });
    assert.equal(store.queryResultTurns(runId).length, 1);

    // Export without system prompt
    const jsonl = store.exportRunJsonl(runId);
    const lines = jsonl.trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("第一段回答。\\n\\n第二段补充细节。"));
    assert.ok(!lines[0].includes("\\u7b2c")); // Chinese stays unescaped UTF-8
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["messages"]);
    assert.deepEqual(parsed.messages, [
      { role: "user", content: "第一题：核心观点是什么？" },
      { role: "assistant", content: finalAnswer },
    ]);

    // Export with configurable system prompt
    const jsonlWithSys = store.exportRunJsonl(runId, { systemPrompt: "你是目标人物本人，请直接回答。" });
    const parsedWithSys = JSON.parse(jsonlWithSys.trimEnd()) as { messages: Array<{ role: string; content: string }> };
    assert.deepEqual(parsedWithSys.messages, [
      { role: "system", content: "你是目标人物本人，请直接回答。" },
      { role: "user", content: "第一题：核心观点是什么？" },
      { role: "assistant", content: finalAnswer },
    ]);

    assert.equal(store.checkIntegrity().ok, true);
  } finally {
    store.close();
  }
});

test("multi-turn flow exports full multi-turn JSONL and enforces all-or-nothing result rule", () => {
  const store = setupStore();
  try {
    const mat = store.upsertMaterial({ videoId: "BV2/P001", content: "多轮测试原文" });
    const qComplete = store.insertQuestion({ id: 1, materialId: mat.id, question: "第一轮问题" }).record;
    const qTurn2Fail = store.insertQuestion({ id: 2, materialId: mat.id, question: "第二轮会失败的起始问题" }).record;

    const runId = createSampleRun(store, { maxAttempts: 2, maxTurns: 2 });
    const items = store.createRunItems(runId, [qComplete.id, qTurn2Fail.id]);

    // Sample 1: Turn 1 pass -> followup -> Turn 2 pass -> enters results with turn_count=2
    const item1 = items.get(qComplete.id)!;
    store.startRunItem(item1);
    const t1 = store.createTurn({ runItemId: item1, turnNo: 1 });
    const a1 = store.startAttempt({ turnId: t1, attemptNo: 1 });
    const ca1 = store.startModelCall({ runId, role: "answer", turnId: t1, attemptId: a1, inputRefs: { material: mat.id, question: qComplete.id } });
    store.finishModelCall(ca1, "第一轮回答");
    store.recordAttemptAnswer(a1, "第一轮回答");
    const cj1 = store.startModelCall({ runId, role: "judge", turnId: t1, attemptId: a1, inputRefs: { question: qComplete.id, answer: a1 } });
    const c1Res = store.commitJudgeOutcome({
      runItemId: item1, turnId: t1, turnNo: 1, attemptId: a1, judgeCallId: cj1,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: false, exhaustedBudget: false,
    });
    assert.equal(c1Res.resultId, undefined);

    const followupCall = store.startModelCall({ runId, role: "followup", turnId: t1, inputRefs: { material: mat.id, history: [{ turn_id: t1, attempt_id: a1 }] } });
    store.finishModelCall(followupCall, "补充新条件或反例");

    const t2 = store.createTurn({ runItemId: item1, turnNo: 2, userContent: "补充新条件或反例" });
    const a2 = store.startAttempt({ turnId: t2, attemptNo: 1 });
    const ca2 = store.startModelCall({ runId, role: "answer", turnId: t2, attemptId: a2, inputRefs: { material: mat.id, history: [{ turn_id: t1, attempt_id: a1 }], user: { turn_id: t2, field: "user_content" } } });
    store.finishModelCall(ca2, "修正后的最终回答\n第二行");
    store.recordAttemptAnswer(a2, "修正后的最终回答\n第二行");
    const cj2 = store.startModelCall({ runId, role: "judge", turnId: t2, attemptId: a2, inputRefs: { history: [{ turn_id: t1, attempt_id: a1 }], user: { turn_id: t2, field: "user_content" }, answer: a2 } });
    const c2Res = store.commitJudgeOutcome({
      runItemId: item1, turnId: t2, turnNo: 2, attemptId: a2, judgeCallId: cj2,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: true, exhaustedBudget: false,
    });
    assert.ok(c2Res.resultId);

    // Sample 2: Turn 1 passes, Turn 2 drops -> 0 results (all-or-nothing!)
    const item2 = items.get(qTurn2Fail.id)!;
    store.startRunItem(item2);
    const s2t1 = store.createTurn({ runItemId: item2, turnNo: 1 });
    const s2a1 = store.startAttempt({ turnId: s2t1, attemptNo: 1 });
    const s2ca1 = store.startModelCall({ runId, role: "answer", turnId: s2t1, attemptId: s2a1, inputRefs: { material: mat.id, question: qTurn2Fail.id } });
    store.finishModelCall(s2ca1, "第一轮通过的回答");
    store.recordAttemptAnswer(s2a1, "第一轮通过的回答");
    const s2cj1 = store.startModelCall({ runId, role: "judge", turnId: s2t1, attemptId: s2a1, inputRefs: { question: qTurn2Fail.id, answer: s2a1 } });
    store.commitJudgeOutcome({
      runItemId: item2, turnId: s2t1, turnNo: 1, attemptId: s2a1, judgeCallId: s2cj1,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: false, exhaustedBudget: false,
    });

    const s2t2 = store.createTurn({ runItemId: item2, turnNo: 2, userContent: "无效追问" });
    const s2a2 = store.startAttempt({ turnId: s2t2, attemptNo: 1 });
    const s2ca2 = store.startModelCall({ runId, role: "answer", turnId: s2t2, attemptId: s2a2, inputRefs: { material: mat.id, user: { turn_id: s2t2, field: "user_content" } } });
    store.finishModelCall(s2ca2, "无法作答");
    store.recordAttemptAnswer(s2a2, "无法作答");
    const s2cj2 = store.startModelCall({ runId, role: "judge", turnId: s2t2, attemptId: s2a2, inputRefs: { user: { turn_id: s2t2, field: "user_content" }, answer: s2a2 } });
    store.commitJudgeOutcome({
      runItemId: item2, turnId: s2t2, turnNo: 2, attemptId: s2a2, judgeCallId: s2cj2,
      judgeOutputText: JSON.stringify({ decision: "drop", issues: ["追问无效"], feedback: "终止" }),
      review: { decision: "drop", issues: ["追问无效"], feedback: "终止" },
      isFinalTurn: true, exhaustedBudget: false,
    });

    assert.deepEqual(store.queryOutcomeCounts(runId), { pass: 1, drop: 1 });

    const jsonl = store.exportRunJsonl(runId, { systemPrompt: "你是一个哲学讨论者" });
    const lines = jsonl.trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      messages: [
        { role: "system", content: "你是一个哲学讨论者" },
        { role: "user", content: "第一轮问题" },
        { role: "assistant", content: "第一轮回答" },
        { role: "user", content: "补充新条件或反例" },
        { role: "assistant", content: "修正后的最终回答\n第二行" },
      ],
    });
    assert.equal(store.checkIntegrity().ok, true);
  } finally {
    store.close();
  }
});

test("negative constraints reject invalid results, cross-turn attempts, partial multi-turn, mutations, and mid-tx rollbacks", () => {
  const store = setupStore();
  try {
    const mat = store.upsertMaterial({ videoId: "BV3/P001", content: "约束测试原文" });
    const q1 = store.insertQuestion({ id: 1, materialId: mat.id, question: "问题 1" }).record;
    const q2 = store.insertQuestion({ id: 2, materialId: mat.id, question: "问题 2" }).record;
    const runId = createSampleRun(store, { maxAttempts: 2, maxTurns: 2 });
    const items = store.createRunItems(runId, [q1.id, q2.id]);
    const item1 = items.get(q1.id)!;
    const item2 = items.get(q2.id)!;
    store.startRunItem(item1);
    store.startRunItem(item2);

    const t1 = store.createTurn({ runItemId: item1, turnNo: 1 });
    const t1Revise = store.startAttempt({ turnId: t1, attemptNo: 1 });
    store.recordAttemptAnswer(t1Revise, "未通过回答");
    store.finishAttemptReview(t1Revise, { decision: "revise", issues: ["缺细节"], feedback: "补细节" });

    // 1. Cannot bind a revise attempt as passed_attempt_id
    assert.throws(() => {
      store.db.prepare("UPDATE turns SET status = 'pass', passed_attempt_id = ? WHERE id = ?").run(t1Revise, t1);
    }, /passed_attempt_id must reference a completed pass attempt/);

    // 2. Cannot bind an attempt from another turn/question
    const t2 = store.createTurn({ runItemId: item2, turnNo: 1 });
    const t2Pass = store.startAttempt({ turnId: t2, attemptNo: 1 });
    store.recordAttemptAnswer(t2Pass, "问题2通过回答");
    store.finishAttemptReview(t2Pass, { decision: "pass", issues: [], feedback: "" });
    assert.throws(() => {
      store.db.prepare("UPDATE turns SET status = 'pass', passed_attempt_id = ? WHERE id = ?").run(t2Pass, t1);
    }, /passed_attempt_id must reference a completed pass attempt/);

    // 3. Cannot insert result for non-pass run_item
    assert.throws(() => {
      store.db.prepare("INSERT INTO results (run_item_id, turn_count, created_at) VALUES (?, 1, ?)").run(item1, new Date().toISOString());
    }, /result requires run_item with status = pass/);

    // 4. Cannot insert result for multi-turn where Turn 1 passed but Turn 2 did not pass
    store.db.prepare("UPDATE turns SET status = 'pass', passed_attempt_id = ? WHERE id = ?").run(t2Pass, t2);
    const t2Turn2 = store.createTurn({ runItemId: item2, turnNo: 2, userContent: "追问" });
    store.finishTurnNonPass(t2Turn2, "exhausted");
    assert.throws(() => {
      store.transaction(() => {
        store.db.prepare("UPDATE run_items SET status = 'pass' WHERE id = ?").run(item2);
        store.db.prepare("INSERT INTO results (run_item_id, turn_count, created_at) VALUES (?, 2, ?)").run(item2, new Date().toISOString());
      });
    }, /every turn in a result must have status = pass/);
    // Also verify the transaction rolled back run_item status cleanly!
    const item2Status = (store.db.prepare("SELECT status FROM run_items WHERE id = ?").get(item2) as { status: string }).status;
    assert.equal(item2Status, "running");

    // 5. Cross-run / cross-turn model_calls must fail
    const run2 = createSampleRun(store, { maxAttempts: 2, maxTurns: 1 });
    assert.throws(() => {
      store.startModelCall({ runId: run2, role: "answer", turnId: t1, attemptId: t1Revise, inputRefs: {} });
    }, /turn_id does not belong to run_id/);
    assert.throws(() => {
      store.startModelCall({ runId, role: "answer", turnId: t1, attemptId: t2Pass, inputRefs: {} });
    }, /attempt_id does not belong to turn_id/);

    // 6. Immutability once committed to results
    const t1Pass = store.startAttempt({ turnId: t1, attemptNo: 2 });
    store.recordAttemptAnswer(t1Pass, "最终通过回答");
    store.finishAttemptReview(t1Pass, { decision: "pass", issues: [], feedback: "" });
    store.db.prepare("UPDATE turns SET status = 'pass', passed_attempt_id = ? WHERE id = ?").run(t1Pass, t1);
    store.finalizePassedRunItem(item1, 1);

    assert.throws(() => store.db.prepare("UPDATE materials SET content = '篡改' WHERE id = ?").run(mat.id), /cannot modify material/);
    assert.throws(() => store.db.prepare("DELETE FROM materials WHERE id = ?").run(mat.id), /cannot delete material/);
    assert.throws(() => store.db.prepare("UPDATE questions SET question = '篡改' WHERE id = ?").run(q1.id), /cannot modify question/);
    assert.throws(() => store.db.prepare("DELETE FROM questions WHERE id = ?").run(q1.id), /cannot delete question/);
    assert.throws(() => store.db.prepare("UPDATE run_items SET status = 'drop' WHERE id = ?").run(item1), /cannot modify run_item/);
    assert.throws(() => store.db.prepare("UPDATE turns SET status = 'drop', passed_attempt_id = NULL WHERE id = ?").run(t1), /cannot modify turn/);
    assert.throws(() => store.createTurn({ runItemId: item1, turnNo: 2, userContent: "强行追加" }), /cannot add turn/);
    assert.throws(() => store.db.prepare("UPDATE attempts SET answer = '篡改' WHERE id = ?").run(t1Pass), /cannot modify winning attempt/);
    assert.throws(() => store.db.prepare("DELETE FROM attempts WHERE id = ?").run(t1Pass), /cannot delete winning attempt/);

    assert.equal(store.checkIntegrity().ok, true);
  } finally {
    store.close();
  }
});

test("startup recovery marks orphaned running records as interrupted without touching passed results", () => {
  const store = setupStore();
  try {
    const mat = store.upsertMaterial({ videoId: "BV4/P001", content: "中断恢复原文" });
    const q1 = store.insertQuestion({ id: 1, materialId: mat.id, question: "已完成问题" }).record;
    const q2 = store.insertQuestion({ id: 2, materialId: mat.id, question: "中途崩溃问题" }).record;
    const runId = createSampleRun(store, { maxAttempts: 3, maxTurns: 1 });
    const items = store.createRunItems(runId, [q1.id, q2.id]);

    // Item 1 completed & in results
    const i1 = items.get(q1.id)!;
    store.startRunItem(i1);
    const t1 = store.createTurn({ runItemId: i1, turnNo: 1 });
    const a1 = store.startAttempt({ turnId: t1, attemptNo: 1 });
    const ca1 = store.startModelCall({ runId, role: "answer", turnId: t1, attemptId: a1, inputRefs: {} });
    store.finishModelCall(ca1, "完整回答");
    store.recordAttemptAnswer(a1, "完整回答");
    const cj1 = store.startModelCall({ runId, role: "judge", turnId: t1, attemptId: a1, inputRefs: {} });
    store.commitJudgeOutcome({
      runItemId: i1, turnId: t1, turnNo: 1, attemptId: a1, judgeCallId: cj1,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: true, exhaustedBudget: false,
    });

    // Item 2 crashed mid-flight while running
    const i2 = items.get(q2.id)!;
    store.startRunItem(i2);
    const t2 = store.createTurn({ runItemId: i2, turnNo: 1 });
    const a2 = store.startAttempt({ turnId: t2, attemptNo: 1 });
    store.startModelCall({ runId, role: "answer", turnId: t2, attemptId: a2, inputRefs: {} });

    const interrupted = store.markInterruptedRuns();
    assert.deepEqual(interrupted, { runs: 1, runItems: 1, turns: 1, attempts: 1, modelCalls: 1 });
    assert.deepEqual(store.queryOutcomeCounts(runId), { pass: 1, interrupted: 1 });
    assert.equal(store.queryResultTurns(runId).length, 1);
    assert.equal(store.checkIntegrity().ok, true);
  } finally {
    store.close();
  }
});

test("exportMergedDataset filters formal runs, applies explicit dedup policies, shuffles reproducibly, and splits by video without leakage", () => {
  const store = setupStore();
  try {
    const m1 = store.upsertMaterial({ videoId: "BV_M1", content: "视频1原文" });
    const m2 = store.upsertMaterial({ videoId: "BV_M2", content: "视频2原文" });
    const m3 = store.upsertMaterial({ videoId: "BV_M3", content: "视频3原文" });
    const q1 = store.insertQuestion({ id: 1, materialId: m1.id, question: "M1问题1" }).record;
    const q2 = store.insertQuestion({ id: 2, materialId: m1.id, question: "M1问题2" }).record;
    const q3 = store.insertQuestion({ id: 3, materialId: m2.id, question: "M2问题1" }).record;
    const q4 = store.insertQuestion({ id: 4, materialId: m3.id, question: "M3问题1" }).record;

    const addPass = (runId: number, questionId: number, answerText: string, secondTurn?: { user: string; answer: string }) => {
      const items = store.createRunItems(runId, [questionId]);
      const itemId = items.get(questionId)!;
      store.startRunItem(itemId);
      const t1 = store.createTurn({ runItemId: itemId, turnNo: 1 });
      const a1 = store.startAttempt({ turnId: t1, attemptNo: 1 });
      const c1a = store.startModelCall({ runId, role: "answer", turnId: t1, attemptId: a1, inputRefs: {} });
      store.finishModelCall(c1a, answerText);
      store.recordAttemptAnswer(a1, answerText);
      const c1j = store.startModelCall({ runId, role: "judge", turnId: t1, attemptId: a1, inputRefs: {} });
      store.commitJudgeOutcome({
        runItemId: itemId, turnId: t1, turnNo: 1, attemptId: a1, judgeCallId: c1j,
        judgeOutputText: '{"decision":"pass","issues":[],"feedback":""}',
        review: { decision: "pass", issues: [], feedback: "" },
        isFinalTurn: !secondTurn, exhaustedBudget: false,
      });
      if (secondTurn) {
        const t2 = store.createTurn({ runItemId: itemId, turnNo: 2, userContent: secondTurn.user });
        const a2 = store.startAttempt({ turnId: t2, attemptNo: 1 });
        const c2a = store.startModelCall({ runId, role: "answer", turnId: t2, attemptId: a2, inputRefs: {} });
        store.finishModelCall(c2a, secondTurn.answer);
        store.recordAttemptAnswer(a2, secondTurn.answer);
        const c2j = store.startModelCall({ runId, role: "judge", turnId: t2, attemptId: a2, inputRefs: {} });
        store.commitJudgeOutcome({
          runItemId: itemId, turnId: t2, turnNo: 2, attemptId: a2, judgeCallId: c2j,
          judgeOutputText: '{"decision":"pass","issues":[],"feedback":""}',
          review: { decision: "pass", issues: [], feedback: "" },
          isFinalTurn: true, exhaustedBudget: false,
        });
      }
    };

    // Run 1: informal (training_enabled=false) - must be excluded by allFormal
    const rInformal = store.createRun({
      kind: "answer_judge", maxAttempts: 2, maxTurns: 1, config: {}, prompts: {}, skills: [],
      exportPolicy: { format: "messages_jsonl", training_enabled: false },
    });
    addPass(rInformal, q1.id, "非正式回答");
    store.finishRun(rInformal, "completed");

    // Run 2: formal 1-turn on q1
    const rFormalOld = store.createRun({
      kind: "answer_judge", maxAttempts: 2, maxTurns: 1, config: {}, prompts: {}, skills: [],
      exportPolicy: { format: "messages_jsonl", training_enabled: true },
    });
    addPass(rFormalOld, q1.id, "旧正式回答q1");
    store.finishRun(rFormalOld, "completed");

    // Run 3: formal 2-turn on q1 (overrides Run 2 under latest), q2, q3, q4
    const rFormalNew = store.createRun({
      kind: "answer_judge", maxAttempts: 2, maxTurns: 2, config: {}, prompts: {}, skills: [],
      exportPolicy: { format: "messages_jsonl", training_enabled: true },
    });
    addPass(rFormalNew, q1.id, "新正式回答q1", { user: "追问1", answer: "追答1" });
    addPass(rFormalNew, q2.id, "新正式回答q2", { user: "追问2", answer: "追答2" });
    addPass(rFormalNew, q3.id, "新正式回答q3", { user: "追问3", answer: "追答3" });
    addPass(rFormalNew, q4.id, "新正式回答q4", { user: "追问4", answer: "追答4" });
    store.finishRun(rFormalNew, "completed");

    // 1. allFormal + dedup=latest excludes Run 1 and picks Run 3 for q1
    const latest = store.exportMergedDataset({ allFormal: true, dedup: "latest" });
    assert.equal(latest.train.length, 4);
    assert.equal(latest.duplicateQuestionsResolved, 1);
    assert.deepEqual(latest.includedRunIds, [rFormalNew]);
    assert.equal(latest.train[0].sample.messages[1].content, "新正式回答q1");
    assert.equal(latest.train[0].sample.messages.length, 4);

    // 2. allFormal + dedup=earliest picks Run 2 for q1
    const earliest = store.exportMergedDataset({ allFormal: true, dedup: "earliest" });
    assert.equal(earliest.train[0].runId, rFormalOld);
    assert.equal(earliest.train[0].sample.messages[1].content, "旧正式回答q1");

    // 3. allFormal + dedup=error rejects conflict on q1
    assert.throws(() => store.exportMergedDataset({ allFormal: true, dedup: "error" }), /q1/);

    // 4. minTurns=2 filters out Run 2 automatically so dedup=error succeeds!
    const twoTurnOnly = store.exportMergedDataset({ allFormal: true, minTurns: 2, dedup: "error" });
    assert.equal(twoTurnOnly.train.length, 4);
    assert.equal(twoTurnOnly.duplicateQuestionsResolved, 0);

    // 5. Video-level train/val split guarantees zero material_id overlap and reproducible seeded order
    const splitA = store.exportMergedDataset({ allFormal: true, minTurns: 2, valRatio: 0.34, shuffle: true, seed: 42 });
    const splitB = store.exportMergedDataset({ allFormal: true, minTurns: 2, valRatio: 0.34, shuffle: true, seed: 42 });
    assert.deepEqual(splitA.train.map((r) => r.questionId), splitB.train.map((r) => r.questionId));
    assert.deepEqual(splitA.val.map((r) => r.questionId), splitB.val.map((r) => r.questionId));
    assert.ok(splitA.train.length > 0 && splitA.val.length > 0);
    const trainMats = new Set(splitA.train.map((r) => r.materialId));
    const valMats = new Set(splitA.val.map((r) => r.materialId));
    for (const matId of valMats) {
      assert.equal(trainMats.has(matId), false, "same material must never appear in both train and val");
    }
  } finally {
    store.close();
  }
});
