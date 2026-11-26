import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCorpusQuestionGeneration } from "../src/synth/corpus-questions.js";
import { scanCorpusVideos } from "../src/synth/corpus.js";
import { DataMakerStore } from "../src/synth/store/index.js";
import { runDialogueBatch } from "../src/synth/dialogue-loop.js";
import { runReasoningBackfill } from "../src/reasoning/engine.js";
import { ReasoningStore } from "../src/reasoning/store.js";
import { runProbeCalibration } from "../src/eval/calibrate.js";
import { EvalStore } from "../src/eval/store/index.js";
import { gradeEvalRun } from "../src/eval/eval-grader.js";
import { runSuiteEvaluation } from "../src/eval/eval-runner.js";
import type { RoleRunner, Skill } from "../src/shared/types.js";

const SECRET = "synthetic-privacy-flow-marker";
const PRIVATE_MESSAGE = `${SECRET} Bearer fixture-token https://provider.example/v1?token=${SECRET}\nprivate material fragment`;
const PASS = JSON.stringify({ decision: "pass", issues: [], feedback: "" });
const SKILL: Skill = { status: "ready", body: "fixture skill", sha256: "fixture-sha" };
const RUBRIC = { expectedBehavior: "answer", stance: "fixture stance", keyPoints: ["fixture point"], forbidden: [], mustNotHallucinate: [], failureSignals: [] };

function sensitiveException(): Error {
  return Object.assign(new Error(PRIVATE_MESSAGE), { status: 503 });
}

function assertPublic(values: unknown[], code = "unexpected_error"): void {
  const text = JSON.stringify(values);
  assert.ok(text.includes(code), "expected a controlled public error code");
  for (const privateText of [SECRET, "Bearer fixture-token", "provider.example", "private material fragment"]) {
    assert.equal(text.includes(privateText), false, "private exception text reached a public sink");
  }
}

function assertErrorColumns(db: DatabaseSync, tables: string[], code = "unexpected_error"): void {
  const errors = tables.flatMap((table) => db.prepare(`SELECT error FROM ${table} WHERE error IS NOT NULL`).all());
  assert.ok(errors.length > 0);
  assertPublic(errors, code);
}

function seedQuestion(store: DataMakerStore): void {
  const material = store.upsertMaterial({ videoId: "BV-privacy-fixture", content: "fixture material" });
  store.insertQuestion({ materialId: material.id, question: "fixture question?" });
}

function seedSuite(store: EvalStore): void {
  store.freezeSuite({
    name: "privacy-fixture", kind: "in_distribution", sha256: "a".repeat(64), manifest: {},
    items: [{
      itemKey: "privacy:item:1", videoKey: "BV-privacy-fixture", probeType: null, expectedBehavior: "answer",
      messages: [{ role: "user", content: "fixture question?" }, { role: "assistant", content: "fixture reference answer" }],
      rubrics: [{ turnNo: 1, rubric: RUBRIC }],
    }],
  });
}

test("question generation publishes only controlled errors and retains malformed output as trace", async (t) => {
  for (const malformed of [false, true]) {
    await t.test(malformed ? "model parse failure" : "injected provider exception", async () => {
      const dir = await mkdtemp(join(tmpdir(), "data-maker-privacy-q-"));
      const store = new DataMakerStore(":memory:");
      try {
        await mkdir(join(dir, "by_bv", "BV_PRIV"), { recursive: true });
        await writeFile(join(dir, "by_bv", "BV_PRIV", "P001.md"), "fixture material");
        const candidates = await scanCorpusVideos(dir);
        const progress: string[] = [];
        const summary = await runCorpusQuestionGeneration({
          store,
          config: {
            baseUrl: "http://127.0.0.1:1/v1",
            modelId: "fixture",
            apiKey: "fixture-key",
            maxTokens: 256,
            contextWindow: 32768,
            timeoutMs: 5000,
          },
          systemPrompt: "question",
          skills: [],
          candidates,
          concurrency: 1,
          callMaxAttempts: 1,
          createRunner: () => async () => {
            if (malformed) return PRIVATE_MESSAGE;
            throw sensitiveException();
          },
          onProgress: (message) => progress.push(message),
        });
        assert.equal(summary.errors, 1);
        const code = malformed ? "model_save_tool_missing" : "unexpected_error";
        assertPublic(progress, code);
        assertErrorColumns(store.db, ["model_calls"], code);
        const call = store.db.prepare("SELECT output_text FROM model_calls").get();
        assert.equal(call?.output_text, malformed ? PRIVATE_MESSAGE : null);
      } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("dialogue role failures hide exceptions across retries, progress and every ordinary error column", async (t) => {
  for (const failedRole of ["answer", "judge", "followup", "rubric"] as const) {
    await t.test(failedRole, async () => {
      const store = new DataMakerStore(":memory:");
      try {
        seedQuestion(store);
        const progress: string[] = [];
        let failingCalls = 0;
        const summary = await runDialogueBatch({
          store, prompts: { answer: "answer", judge: "judge", followup: "followup", rubric: "rubric" },
          maxAttempts: 1, maxTurns: failedRole === "followup" ? 2 : 1,
          callMaxAttempts: 2, callRetryDelayMs: 0, config: {},
          runRole: async ({ role }) => {
            if (role === failedRole) {
              failingCalls++;
              throw sensitiveException();
            }
            if (role === "answer") return "fixture answer";
            if (role === "judge") return PASS;
            if (role === "followup") return '{"action":"stop"}';
            return JSON.stringify(RUBRIC);
          },
          onProgress: (message) => progress.push(message),
        });
        assert.equal(failingCalls, 2);
        assert.equal(failedRole === "rubric" ? summary.rubricErrors : summary.errors, 1);
        assertPublic(progress);
        assert.ok(progress.some((message) => message.includes("第 1/2 次")));
        assertErrorColumns(store.db, ["model_calls", "eval_model_calls", "attempts", "turns", "run_items", "runs"]);
      } finally {
        store.close();
      }
    });
  }
});

test("malformed judge, followup and rubric outputs stay in trace instead of public errors", async (t) => {
  for (const failedRole of ["judge", "followup", "rubric"] as const) {
    await t.test(failedRole, async () => {
      const store = new DataMakerStore(":memory:");
      try {
        seedQuestion(store);
        const progress: string[] = [];
        await runDialogueBatch({
          store, prompts: { answer: "answer", judge: "judge", followup: "followup", rubric: "rubric" },
          maxAttempts: 1, maxTurns: failedRole === "followup" ? 2 : 1, config: {},
          callMaxAttempts: 2, callRetryDelayMs: 0,
          runRole: async ({ role }) => {
            if (role === failedRole) return PRIVATE_MESSAGE;
            if (role === "answer") return "fixture answer";
            if (role === "judge") return PASS;
            return '{"action":"stop"}';
          },
          onProgress: (message) => progress.push(message),
        });
        assertPublic(progress, "model_output_invalid");
        assertErrorColumns(store.db, ["model_calls", "eval_model_calls", "attempts", "turns", "run_items"], "model_output_invalid");
        const table = failedRole === "rubric" ? "eval_model_calls" : "model_calls";
        const row = store.db.prepare(`SELECT output_text FROM ${table} WHERE role = ? AND status = 'error'`).get(failedRole);
        assert.equal(row?.output_text, PRIVATE_MESSAGE);
      } finally {
        store.close();
      }
    });
  }
});

test("candidate evaluation hides Error, string and object exceptions in retry progress and database errors", async (t) => {
  for (const kind of ["error", "string", "object"] as const) {
    await t.test(kind, async () => {
      const store = new EvalStore(":memory:");
      try {
        seedSuite(store);
        const progress: string[] = [];
        let calls = 0;
        const summary = await runSuiteEvaluation({
          evalStore: store, suiteName: "privacy-fixture", candidate: "fixture", modelId: "candidate-fixture",
          callMaxAttempts: 2, callRetryDelayMs: 0,
          runCandidate: async () => {
            calls++;
            if (kind === "string") throw PRIVATE_MESSAGE;
            if (kind === "object") throw { message: PRIVATE_MESSAGE, body: PRIVATE_MESSAGE, status: 503 };
            throw sensitiveException();
          },
          onProgress: (message) => progress.push(message),
        });
        assert.equal(calls, 2);
        assert.equal(summary.errorTurns, 1);
        assertPublic(progress);
        assertErrorColumns(store.db, ["agent_calls", "eval_predictions", "eval_runs"]);
      } finally {
        store.close();
      }
    });
  }
});

test("evaluation grading publishes controlled transport and parsing failures", async (t) => {
  for (const malformed of [false, true]) {
    await t.test(malformed ? "parse" : "transport", async () => {
      const store = new EvalStore(":memory:");
      try {
        seedSuite(store);
        const evaluated = await runSuiteEvaluation({
          evalStore: store, suiteName: "privacy-fixture", candidate: "fixture", modelId: "candidate-fixture",
          runCandidate: async () => "fixture answer", callMaxAttempts: 1,
        });
        const progress: string[] = [];
        let calls = 0;
        const summary = await gradeEvalRun({
          evalStore: store, evalRunId: evaluated.evalRunId, graderPrompt: "grader", graderModelId: "grader-fixture",
          callMaxAttempts: 2, callRetryDelayMs: 0,
          runGrader: async () => {
            calls++;
            if (malformed) return PRIVATE_MESSAGE;
            throw sensitiveException();
          },
          onProgress: (message) => progress.push(message),
        });
        assert.equal(calls, 2);
        assert.equal(summary.errors, 1);
        const code = malformed ? "model_output_invalid" : "unexpected_error";
        assertPublic(progress, code);
        assertErrorColumns(store.db, ["agent_calls"], code);
      } finally {
        store.close();
      }
    });
  }
});

function seedProbe(store: EvalStore): number {
  const { record: source } = store.insertSourceMaterial({ videoId: "BV-privacy", videoKey: "BV-privacy", partCount: 1, content: "fixture material", splitSnapshot: "test" });
  const runId = store.createRun({ kind: "probe_build", config: {}, prompts: {}, skills: [] });
  const specId = store.createSpec({ runId, sourceMaterialId: source.id, slotIndex: 1, probeType: "wild_short", persona: "fixture", targetTurns: 1 });
  const probeId = store.createProbe({ specId, question: "fixture question?", anchor: "fixture material", trap: "fixture trap", expectedBehavior: "answer", anchorVerified: true });
  const turnId = store.createTurn({ probeId, turnNo: 1, userContent: "fixture question?", expectedBehavior: "answer" });
  const attemptId = store.addAttempt({ turnId, attemptNo: 1, answer: "fixture reference answer", answerCallId: null });
  store.reviewAttempt(attemptId, { decision: "pass", issues: [], feedback: "", verifyCallId: null });
  store.finishTurn(turnId, "pass", attemptId);
  store.saveRubric({ turnId, rubric: RUBRIC, callId: null });
  store.setProbeStatus(probeId, "accepted");
  store.finishRun(runId, "completed");
  return probeId;
}

test("calibration hides injected bare-model/grader exceptions and malformed grade output", async (t) => {
  for (const failure of ["bare", "grader", "parse"] as const) {
    await t.test(failure, async () => {
      const store = new EvalStore(":memory:");
      try {
        const probeId = seedProbe(store);
        const probe = store.getProbe(probeId);
        assert.ok(probe);
        const progress: string[] = [];
        const summary = await runProbeCalibration({
          evalStore: store, probes: [probe], prompts: { bareAnswer: "bare", evalGrader: "grader" }, skills: [],
          bareModelId: "bare-fixture", graderModelId: "grader-fixture", callMaxAttempts: 2, callRetryDelayMs: 0,
          runBareModel: async () => {
            if (failure === "bare") throw sensitiveException();
            return "fixture answer";
          },
          runGrader: async () => {
            if (failure === "parse") return PRIVATE_MESSAGE;
            throw sensitiveException();
          },
          onProgress: (message) => progress.push(message),
        });
        assert.equal(summary.errors, 1);
        const code = failure === "parse" ? "model_output_invalid" : "unexpected_error";
        assertPublic(progress, code);
        assertErrorColumns(store.db, ["agent_calls"], code);
        if (failure === "parse") {
          const row = store.db.prepare("SELECT output_text FROM agent_calls WHERE error IS NOT NULL").get();
          assert.equal(row?.output_text, PRIVATE_MESSAGE);
        }
      } finally {
        store.close();
      }
    });
  }
});

test("fatal evaluation progress exceptions remain controlled in the failed run record", async () => {
  const store = new EvalStore(":memory:");
  try {
    seedSuite(store);
    await assert.rejects(runSuiteEvaluation({
      evalStore: store, suiteName: "privacy-fixture", candidate: "fixture", modelId: "candidate-fixture",
      runCandidate: async () => "fixture answer", callMaxAttempts: 1,
      onProgress: () => { throw sensitiveException(); },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assertPublic([error.message]);
      return true;
    });
    assertErrorColumns(store.db, ["eval_runs"]);
  } finally {
    store.close();
  }
});

test("fatal calibration progress exceptions remain controlled in the failed run record", async () => {
  const store = new EvalStore(":memory:");
  try {
    const probe = store.getProbe(seedProbe(store));
    assert.ok(probe);
    await assert.rejects(runProbeCalibration({
      evalStore: store, probes: [probe], prompts: { bareAnswer: "bare", evalGrader: "grader" }, skills: [],
      bareModelId: "bare-fixture", graderModelId: "grader-fixture", callMaxAttempts: 1,
      runBareModel: async () => { throw sensitiveException(); },
      runGrader: async () => "{}",
      onProgress: () => { throw sensitiveException(); },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assertPublic([error.message]);
      return true;
    });
    assertErrorColumns(store.db, ["probe_runs", "agent_calls"]);
  } finally {
    store.close();
  }
});

test("reasoning backfill hides injected writer/grader exceptions in trace errors and progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "data-maker-privacy-reasoning-"));
  try {
    const path = join(dir, "fixture.sqlite");
    const data = new DataMakerStore(path);
    let runId: number;
    try {
      seedQuestion(data);
      const summary = await runDialogueBatch({
        store: data, prompts: { answer: "answer", judge: "judge" }, maxAttempts: 1, maxTurns: 1,
        config: { mode: "live" }, exportPolicy: { training_enabled: true },
        runRole: async ({ role }) => role === "answer" ? "fixture reference answer" : PASS,
      });
      runId = summary.runId;
    } finally {
      data.close();
    }
    const store = new ReasoningStore(path);
    try {
      const candidates = store.queryCandidateTurns({ runIds: [runId] });
      assert.equal(candidates.length, 1);
      const progress: unknown[] = [];
      const runWriter: RoleRunner = async () => { throw sensitiveException(); };
      const result = await runReasoningBackfill({
        store, candidates, writerPrompt: "writer", writerSkill: SKILL, writerSkillPath: "fixture-skill", writerModel: "fixture-writer",
        runWriter, callMaxAttempts: 2, callRetryDelayMs: 0, maxRewrites: 0,
        onProgress: (event) => progress.push(event),
      });
      assert.equal(result.stats.errored, 1);
      assert.equal(progress.length, 1);
      assert.equal(JSON.stringify(progress).includes(SECRET), false);
      assertErrorColumns(store.db, ["reasoning_traces", "reasoning_runs"]);

      const rawWriter = "先把提问里的两个条件分开，明确各自成立时会推导出什么，再找出真正影响判断的前提，最后围绕这个前提给出直接回应。";
      for (const malformed of [false, true]) {
        const graded = await runReasoningBackfill({
          store, candidates, writerPrompt: "writer", writerSkill: SKILL, writerSkillPath: "fixture-skill", writerModel: "fixture-writer",
          judgePrompt: "judge", judgeSkill: SKILL, judgeModel: "fixture-judge",
          runWriter: async () => rawWriter,
          runJudge: async () => {
            if (malformed) return PRIVATE_MESSAGE;
            throw sensitiveException();
          },
          callMaxAttempts: 2, callRetryDelayMs: 0, maxRewrites: 0,
        });
        assert.equal(graded.stats.errored, 1);
        const row = store.db.prepare("SELECT error, raw_output FROM reasoning_traces WHERE reasoning_run_id = ?").get(graded.reasoningRunId);
        assertPublic([row?.error], malformed ? "model_output_invalid" : "unexpected_error");
        assert.equal(row?.raw_output, rawWriter);
      }

      await assert.rejects(runReasoningBackfill({
        store, candidates, writerPrompt: "writer", writerSkill: SKILL, writerSkillPath: "fixture-skill", writerModel: "fixture-writer",
        runWriter, callMaxAttempts: 1, maxRewrites: 0,
        onProgress: () => { throw sensitiveException(); },
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assertPublic([error.message]);
        return true;
      });
      assertErrorColumns(store.db, ["reasoning_runs"]);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
