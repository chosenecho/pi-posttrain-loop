import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DataMakerStore } from "../src/synth/store/index.js";
import {
  computeBatchStats,
  DEFAULT_REASONING_CHECK_CONFIG,
  inferThinkTier,
  parseProfileFilter,
  parseTierFilter,
  runRuleChecks,
} from "../src/reasoning/checks.js";
import {
  composeReasoningJudgePrompt,
  composeReasoningWriterPrompt,
  DEFAULT_REASONING_JUDGE_SKILL,
  DEFAULT_REASONING_WRITER_SKILL,
  readReasoningJudgeSkill,
  readReasoningPiConfigs,
  readReasoningPrompts,
  readReasoningWriterSkill,
  runReasoningBackfill,
  selectStratifiedTurns,
} from "../src/reasoning/engine.js";
import {
  buildReasoningExportDataset,
  formatReasoningJsonl,
  formatReviewMarkdown,
} from "../src/reasoning/export.js";
import { ReasoningStore, type CandidateTurn } from "../src/reasoning/store.js";
import { parseReview } from "../src/shared/schema.js";
import type { RoleRequest } from "../src/shared/types.js";

async function tempDir(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "data-maker-reasoning-test-")));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function runCli(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: join(import.meta.dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function seedUnifiedDb(dbPath: string): {
  runId: number;
  resultIds: number[];
  attemptIds: number[];
  secretMaterialText: string;
} {
  const store = new DataMakerStore(dbPath);
  const secretMaterialText = "机密原始视频转写稿_UNIQUE_MATERIAL_MARKER_9981：同学们欢迎来到本期视频，这里有很多录播口癖。";
  try {
    const matA = store.upsertMaterial({
      videoId: "BV1VIDEOA/P001",
      content: secretMaterialText,
      sourcePath: "data/BV1VIDEOA.md",
    });
    const matB = store.upsertMaterial({
      videoId: "BV1VIDEOB/P001",
      content: "另一份原始材料内容_MATERIAL_B_7721",
      sourcePath: "data/BV1VIDEOB.md",
    });

    const qRunId = store.createRun({
      kind: "question_generation",
      maxAttempts: 1,
      maxTurns: 1,
      config: { mode: "live" },
      prompts: { question: "q" },
      skills: [],
      exportPolicy: { training_enabled: false },
    });
    store.finishRun(qRunId, "completed");

    const q1 = store.insertQuestion({
      materialId: matA.id,
      question: "为什么很多人越强调自我感动，越难真正改变处境？",
      generationRunId: qRunId,
    }).record.id;
    const q2 = store.insertQuestion({
      materialId: matB.id,
      question: "制度约束和个体自律到底谁更根本？",
      generationRunId: qRunId,
    }).record.id;

    const runId = store.createRun({
      kind: "answer_judge",
      maxAttempts: 3,
      maxTurns: 2,
      config: { mode: "live" },
      prompts: { answer: "a", judge: "j" },
      skills: [],
      exportPolicy: { training_enabled: true },
    });

    const itemMap = store.createRunItems(runId, [q1, q2]);
    const attemptIds: number[] = [];
    const resultIds: number[] = [];

    // Dialogue 1 (2 turns, matA)
    const item1 = itemMap.get(q1)!;
    store.startRunItem(item1);
    const t1 = store.createTurn({ runItemId: item1, turnNo: 1 });
    const a1 = store.startAttempt({ turnId: t1, attemptNo: 1 });
    const ans1 =
      "因为自我感动本质上是在用情绪消费替代现实改造。一个人觉得自己很委屈、很努力的时候，大脑立刻就领到了一笔廉价的道德奖赏，好像光凭态度就已经尽了责任。结果真正的结构性障碍、利益分配和行动代价一点都没碰，反而把受苦本身当成了某种免责证明。时间一长，人不是没力气走出去，而是已经习惯在那种悲情叙事里确认自身价值了。想打破这个循环，第一步恰恰是戒掉这种自我安抚，把情绪和现实处境剥离开来看。";
    const c1a = store.startModelCall({ runId, role: "answer", turnId: t1, attemptId: a1, inputRefs: { material: matA.id, question: q1 } });
    store.finishModelCall(c1a, ans1);
    store.recordAttemptAnswer(a1, ans1);
    const c1j = store.startModelCall({ runId, role: "judge", turnId: t1, attemptId: a1, inputRefs: { question: q1, answer: a1 } });
    store.commitJudgeOutcome({
      runItemId: item1,
      turnId: t1,
      turnNo: 1,
      attemptId: a1,
      judgeCallId: c1j,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: false,
      exhaustedBudget: false,
    });
    attemptIds.push(a1);

    const t2 = store.createTurn({
      runItemId: item1,
      turnNo: 2,
      userContent: "那如果现实条件短期真改不了，靠自我安慰撑过去难道不对吗？",
    });
    const a2 = store.startAttempt({ turnId: t2, attemptNo: 1 });
    const ans2 =
      "撑过去和自我感动是两回事。人在逆境里找心理缓冲很正常，只要你心里清楚那只是临时止痛药，不是治病方案。问题出在很多人吃止痛药吃出了崇高感，开始反过来美化病灶本身，甚至谁提醒他看病就跟谁急。保留清醒的缓冲没问题，把缓冲当成终极意义才会真正锁死出路。";
    const c2a = store.startModelCall({ runId, role: "answer", turnId: t2, attemptId: a2, inputRefs: { material: matA.id, question: q1 } });
    store.finishModelCall(c2a, ans2);
    store.recordAttemptAnswer(a2, ans2);
    const c2j = store.startModelCall({ runId, role: "judge", turnId: t2, attemptId: a2, inputRefs: { question: q1, answer: a2 } });
    const commit1 = store.commitJudgeOutcome({
      runItemId: item1,
      turnId: t2,
      turnNo: 2,
      attemptId: a2,
      judgeCallId: c2j,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: true,
      exhaustedBudget: false,
    });
    attemptIds.push(a2);
    resultIds.push(commit1.resultId!);

    // Dialogue 2 (1 turn, matB)
    const item2 = itemMap.get(q2)!;
    store.startRunItem(item2);
    const t3 = store.createTurn({ runItemId: item2, turnNo: 1 });
    const a3 = store.startAttempt({ turnId: t3, attemptNo: 1 });
    const ans3 =
      "把这两者拆成谁更根本，本身就掉进了伪命题。制度划定的是底线、激励和博弈边界，没有稳固的制度约束，再好的个体自律也会在劣币驱逐良币里迅速耗尽；但制度条文永远写不尽所有灰区，离开具体人的判断与底线，任何规则都会被钻空子玩坏。真正有效的秩序，是用制度把守规矩的成本降下来，再让个体自律有地方落脚。";
    const c3a = store.startModelCall({ runId, role: "answer", turnId: t3, attemptId: a3, inputRefs: { material: matB.id, question: q2 } });
    store.finishModelCall(c3a, ans3);
    store.recordAttemptAnswer(a3, ans3);
    const c3j = store.startModelCall({ runId, role: "judge", turnId: t3, attemptId: a3, inputRefs: { question: q2, answer: a3 } });
    const commit2 = store.commitJudgeOutcome({
      runItemId: item2,
      turnId: t3,
      turnNo: 1,
      attemptId: a3,
      judgeCallId: c3j,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: true,
      exhaustedBudget: false,
    });
    attemptIds.push(a3);
    resultIds.push(commit2.resultId!);

    store.finishRun(runId, "completed");
    return { runId, resultIds, attemptIds, secretMaterialText };
  } finally {
    store.close();
  }
}

test("default reasoning prompts and skills load as ready with zero TODOs and valid JSON examples", async () => {
  const [writerSkill, judgeSkill, prompts] = await Promise.all([
    readReasoningWriterSkill(),
    readReasoningJudgeSkill(),
    readReasoningPrompts(),
  ]);

  assert.equal(writerSkill.status, "ready");
  assert.equal(judgeSkill.status, "ready");
  assert.match(writerSkill.sha256, /^[a-f0-9]{64}$/);
  assert.match(judgeSkill.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(prompts.writer, /\bTODO\b/);
  assert.doesNotMatch(prompts.judge, /\bTODO\b/);

  const composedWriter = composeReasoningWriterPrompt(prompts.writer, writerSkill.body);
  const composedJudge = composeReasoningJudgePrompt(prompts.judge, judgeSkill.body);
  assert.ok(composedWriter.includes(`<reasoning-writer>\n${writerSkill.body}\n</reasoning-writer>`));
  assert.ok(composedJudge.includes(`<reasoning-judge>\n${judgeSkill.body}\n</reasoning-judge>`));
  assert.ok(!composedWriter.includes(judgeSkill.body));
  assert.ok(!composedJudge.includes(writerSkill.body));

  const examples = prompts.judge.match(/^\{"decision":.+\}$/gm) ?? [];
  assert.deepEqual(examples.map((line) => parseReview(line).decision), ["pass", "revise", "drop"]);
});

test("deterministic safety checks only block engineering faults and leave tone/length/nuance to the LLM judge", () => {
  const answer =
    "把制度和自律拆成非此即彼，其实漏掉了两者互相咬合的机制。现实社会里原材料分配、道德要求和法律禁止从来不是孤立运转的，规则先划出博弈底线，人的判断再在条文之外补齐灰区。没有外部兜底，单靠个人觉悟很快就会在劣币竞争里被耗干；反过来如果只剩冰冷条文而没有人的自觉，任何细则都能被拆解成空壳。所以关键不是站哪一边，而是看规则能不能让守底线的人不吃亏。";

  // Clean natural thought with domain words ("原材料", "道德要求", "法律禁止", "按规则办事") passes cleanly
  const cleanThought =
    "把这两件事当成单选题来问，其实前提就已经劈歪了。像生产里的原材料怎么分配、日常的道德要求、按规则办事和成文的法律禁止，往往是绑在一起起作用的，得先拆掉这个非此即彼的架子，点明光靠觉悟撑不住劣币竞争，再反过来说死条文也会被钻空子，最后落到让守底线不吃亏这个支点上。";
  const passRes = runRuleChecks(cleanThought, answer, "short");
  assert.equal(passRes.passed, true, `Expected pass, got: ${passRes.issues.join("; ")}`);
  assert.deepEqual(passRes.metrics.leakHits, []);
  assert.deepEqual(passRes.metrics.formatHits, []);

  // Tone/opening/style nuances and slight tier-range overflow are NOT short-circuited by regex;
  // they pass through to the LLM judge for semantic evaluation.
  const nuancedThought =
    "他这里把制度和自律拆成了二选一，其实漏掉了两者互相咬合的机制。推进顺序是先拆前提，剩下的交给开口再展开。";
  const nuanceRes = runRuleChecks(nuancedThought, answer, "short");
  assert.equal(nuanceRes.passed, true, `Tone/short-overlap should defer to LLM judge, got: ${nuanceRes.issues.join("; ")}`);
  assert.deepEqual(nuanceRes.metrics.formatHits, []);

  // Slightly outside soft target range (e.g. 280 chars for medium, still well below safety fuse) passes rule layer
  const mediumOverflow = "把制度与自律对立起来本身就是伪命题。".repeat(16); // ~288 chars
  const longAnswer = answer.repeat(3);
  const overflowRes = runRuleChecks(mediumOverflow, longAnswer, "medium");
  assert.equal(overflowRes.passed, true, `Soft tier overflow should defer to LLM judge, got: ${overflowRes.issues.join("; ")}`);

  // Thinking longer than a brief answer is allowed as long as it stays within maxChars safety fuse
  const briefAnswer = "不是。它研究的不是逻辑学，而是逻辑本身，先把现成学科框架卸掉再直面逻辑本身。";
  const deeperThoughtForBrief =
    "一看到书名带“逻辑”两个字，最容易顺手把它归进逻辑学教科书那类现成学科里。可这里真正要追问的恰恰不是某套既成学科的规则汇编，而是逻辑自身何以成立、它的内在规定性怎么向我们显现。所以得先把现成的学科外壳卸下来，直接回到逻辑本身去谈。";
  const longerThanAnswerRes = runRuleChecks(deeperThoughtForBrief, briefAnswer, "short");
  assert.equal(longerThanAnswerRes.passed, true, `Thinking longer than short answer should be allowed, got: ${longerThanAnswerRes.issues.join("; ")}`);

  // Runaway length fuse (> maxChars) MUST block
  const runaway = "一二三四五六七八九十".repeat(160); // 1600 chars > 1500
  const runawayRes = runRuleChecks(runaway, longAnswer, "long");
  assert.equal(runawayRes.passed, false);
  assert.ok(runawayRes.issues.some((issue) => issue.includes("安全上限")));

  // Leakage detection
  const leaked = runRuleChecks(
    "原稿和材料中提到这个观点，按字数要求不超过120字且不能用加粗，所以我先简单回应这个核心分歧点，再收尾给出结论。",
    answer,
    "short",
  );
  assert.equal(leaked.passed, false);
  assert.ok(leaked.metrics.leakHits.length >= 3);

  // Blatant verbatim copy-paste detection (feedback must surface the matched snippet)
  const copied = runRuleChecks(
    "我想说的是没有外部兜底单靠个人觉悟很快就会在劣币竞争里被耗干，反过来如果只剩冰冷条文而没有人的自觉，任何细则都能被拆解成空壳。",
    answer,
    "short",
  );
  assert.equal(copied.passed, false);
  assert.ok(copied.issues.some((issue) => /重合率|连续.*照抄/.test(issue)));
  assert.ok(copied.feedback.includes(copied.metrics.maxVerbatimSnippet.slice(0, 12)));

  // Mechanical format violations ONLY: numbered list + Markdown + <think> tags
  const formatted = runRuleChecks(
    "<think>先想清制度和自律的关系。\n1. 先拆前提\n2. 再讲**互动关系**</think>",
    answer,
    "short",
  );
  assert.equal(formatted.passed, false);
  assert.ok(formatted.metrics.formatHits.length >= 3);

  // Tier inference (for offline stats/stratification only)
  assert.equal(inferThinkTier(260), "short");
  assert.equal(inferThinkTier(600), "medium");
  assert.equal(inferThinkTier(1000), "long");

  // Batch stats and opening-prefix diversity
  const stats = computeBatchStats([
    {
      status: "completed",
      decision: "pass",
      lengthTier: "short",
      reasoning: "他这里把前提混为一谈了，我得先拆开来说清边界。",
      metrics: passRes.metrics,
      rewriteCount: 0,
    },
    {
      status: "completed",
      decision: "pass",
      lengthTier: "short",
      reasoning: "他这里把前提混为一谈了，直接举个反例就能戳破。",
      metrics: passRes.metrics,
      rewriteCount: 1,
    },
  ]);
  assert.equal(stats.passRate, 1);
  assert.equal(stats.openingDiversity.uniquePrefixCount, 1);
  assert.deepEqual(stats.openingDiversity.topRepeated, [{ prefix: "他这里把前提混为", count: 2 }]);
});

test("selectStratifiedTurns balances tiers, turn numbers, and distinct videos reproducibly", () => {
  const candidates: CandidateTurn[] = [];
  const tiers = ["short", "medium", "long"] as const;
  let id = 1;
  for (const tier of tiers) {
    for (const turnNo of [1, 2, 3]) {
      for (let v = 1; v <= 4; v++) {
        candidates.push({
          resultId: id,
          sourceRunId: 1,
          sourceProfile: "standard",
          questionId: id,
          materialId: v,
          videoId: `BV_V${v}/P001`,
          videoKey: `BV_V${v}`,
          turnCount: 3,
          turnNo,
          attemptId: id,
          question: `q${id}`,
          answer: "a".repeat(tier === "short" ? 250 : tier === "medium" ? 600 : 1000),
          answerCharCount: tier === "short" ? 250 : tier === "medium" ? 600 : 1000,
          lengthTier: tier,
          history: [],
        });
        id++;
      }
    }
  }

  const pickA = selectStratifiedTurns(candidates, 9, 42);
  const pickB = selectStratifiedTurns(candidates, 9, 42);
  assert.deepEqual(pickA.map((c) => c.attemptId), pickB.map((c) => c.attemptId));
  assert.equal(pickA.length, 9);

  // Every (tier x turnNo) stratum must appear once in a 9-turn stratified pick
  const strata = new Set(pickA.map((c) => `${c.lengthTier}:${c.turnNo}`));
  assert.equal(strata.size, 9);
  // All 4 distinct videos should be represented
  const videos = new Set(pickA.map((c) => c.videoKey));
  assert.equal(videos.size, 4);
});

test("readReasoningPiConfigs supports independent REASONING_* overrides with fallback to LLM_*", () => {
  const configs = readReasoningPiConfigs({
    LLM_BASE_URL: "https://teacher.example.com/v1",
    LLM_MODEL: "teacher-v1",
    LLM_API_KEY: "sk-teacher",
    LLM_JUDGE_THINKING_LEVEL: "low",
    REASONING_BASE_URL: "http://127.0.0.1:8000/v1",
    REASONING_MODEL: "Qwen3.8-27B",
    REASONING_API_KEY: "local-key",
    REASONING_THINKING_LEVEL: "high",
  });
  assert.equal(configs.writer.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(configs.writer.modelId, "Qwen3.8-27B");
  assert.equal(configs.writer.thinkingLevel, "high");
  assert.equal(configs.judge.baseUrl, "https://teacher.example.com/v1");
  assert.equal(configs.judge.modelId, "teacher-v1");
  assert.equal(configs.judge.thinkingLevel, "low");
});

test("end-to-end backfill enforces material isolation, rule/LLM rewrites, drops, turn-expanded ms-swift export, and review markdown", async (t) => {
  const dir = await tempDir(t);
  const dbPath = join(dir, "unified.sqlite");
  const { secretMaterialText } = seedUnifiedDb(dbPath);

  const [writerSkill, judgeSkill, prompts] = await Promise.all([
    readReasoningWriterSkill(),
    readReasoningJudgeSkill(),
    readReasoningPrompts(),
  ]);

  const store = new ReasoningStore(dbPath);
  try {
  const candidates = store.queryCandidateTurns({ allFormal: true });
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].history.length, 0);
  assert.equal(candidates[1].history.length, 2); // Turn 2 carries Turn 1 user+assistant pure history

  const writerCalls: RoleRequest[] = [];
  const judgeCalls: RoleRequest[] = [];
  const writerCallCounts = new Map<string, number>();

  const backfill = await runReasoningBackfill({
    store,
    candidates,
    writerPrompt: prompts.writer,
    writerSkill,
    writerSkillPath: DEFAULT_REASONING_WRITER_SKILL,
    judgePrompt: prompts.judge,
    judgeSkill,
    judgeSkillPath: DEFAULT_REASONING_JUDGE_SKILL,
    writerModel: "mock-qwen3.8-27b",
    judgeModel: "mock-judge",
    concurrency: 2,
    maxRewrites: 2,
    checkConfig: DEFAULT_REASONING_CHECK_CONFIG,
    runWriter: async (req) => {
      writerCalls.push(req);
      // Verify strict blind isolation: raw material text must NEVER appear in writer input or prompt,
      // and length tiers / targetChars are NOT forced onto the writer.
      const serialized = JSON.stringify(req.input) + req.systemPrompt;
      assert.equal(serialized.includes(secretMaterialText), false, "raw material leaked to writer");
      assert.equal("targetThinkTier" in req.input, false);
      assert.equal("targetChars" in req.input, false);

      const q = String(req.input.question);
      const count = (writerCallCounts.get(q) ?? 0) + 1;
      writerCallCounts.set(q, count);

      // Turn 1 of Dialogue 1: fail rule check (leakage) on attempt 1, then pass cleanly on attempt 2
      if (q.includes("自我感动")) {
        if (count === 1) {
          return "原稿和材料中提到自我感动很不好，按要求控制字数，所以我打算直接反驳一下。";
        }
        assert.ok(typeof req.input.feedback === "string" && req.input.feedback.length > 0);
        return "他抓住了情绪消费这个现象，得先点破这种悲情叙事其实是在提前兑现道德免责。沿着这个口子拆开，先说为什么廉价奖赏会让人停在原地，再点出把受苦当勋章的隐患，最后把情绪和现实处境切开给个落点。";
      }

      // Turn 2 of Dialogue 1: pass rule check, then judge asks revise on attempt 1, pass on attempt 2
      if (q.includes("自我安慰")) {
        if (count === 1) {
          return "他拿现实改不了来反问，我得先肯定缓冲本身合理，再切开临时止痛和美化困境的边界，语气收干脆些，别把前轮讲过的重复一遍。";
        }
        assert.ok(String(req.input.feedback).includes("聚焦"));
        return "这轮追问拿现实难改来卡边界，正好把临时止痛和沉溺悲情彻底劈开。先承认逆境里找缓冲很正常，但马上卡死底线：别把止痛药捧成崇高意义，直接回击美化病灶那一层就够了。";
      }

      // Turn 1 of Dialogue 2: pass rule check, then LLM judge drops it
      return "把制度和自律做成二选一，本身就是把一对相互依存的齿轮硬拆开了。先戳破这个伪对立，再分别点出缺制度会耗干好人、缺自律会玩坏条文，最后归到降低守规成本上。";
    },
    runJudge: async (req) => {
      judgeCalls.push(req);
      assert.equal(JSON.stringify(req.input).includes(secretMaterialText), false, "raw material leaked to judge");
      assert.equal("targetThinkTier" in req.input, false);
      const metrics = req.input.referenceMetrics as Record<string, unknown> | undefined;
      assert.ok(metrics && typeof metrics.charCount === "number" && !("targetChars" in metrics));
      const q = String(req.input.question);
      const reasoning = String(req.input.reasoning);
      if (q.includes("自我安慰") && reasoning.includes("别把前轮讲过的重复一遍")) {
        return JSON.stringify({
          decision: "revise",
          issues: ["收尾略带元指令口吻"],
          feedback: "去掉提醒自己别重复的元指令口吻，聚焦在止痛与沉溺的边界区分上。",
        });
      }
      if (q.includes("制度约束")) {
        return JSON.stringify({
          decision: "drop",
          issues: ["测试丢弃分支"],
          feedback: "测试主动丢弃该样本。",
        });
      }
      return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
    },
  });

  assert.equal(backfill.selectedTurns, 3);
  assert.equal(backfill.stats.passed, 2);
  assert.equal(backfill.stats.dropped, 1);
  assert.equal(backfill.stats.errored, 0);
  // Rule failure on Dialogue 1 Turn 1 attempt 1 must NOT invoke LLM judge unnecessarily:
  // Judge called once for D1T1(attempt 2), twice for D1T2(attempt 1+2), once for D2T1(attempt 1) = 4
  assert.equal(judgeCalls.length, 4);

  // Verify --only-missing now skips the 2 already-passed turns and only returns the 1 dropped turn
  const missing = store.queryCandidateTurns({ allFormal: true, onlyMissing: true });
  assert.equal(missing.length, 1);
  assert.ok(missing[0].question.includes("制度约束"));

  // Verify default ms-swift 4.6.0 export uses inline <think>\n...\n</think>\n\n format with expandTurns=true
  const exportedInline = buildReasoningExportDataset(store, {
    reasoningRunId: backfill.reasoningRunId,
    allFormal: true,
    expandTurns: true,
  });
  assert.equal(exportedInline.format, "inline");
  assert.equal(exportedInline.train.length, 2);
  const inlineS2 = exportedInline.train[1].sample.messages;
  assert.equal(inlineS2[1].content.includes("<think>"), false, "history turn stays clean in inline format");
  assert.match(inlineS2[3].content, /^<think>\n[\s\S]+\n<\/think>\n\n/);
  assert.equal("reasoning_content" in inlineS2[3], false);

  // Verify explicit format="reasoning_content" (for direct HF apply_chat_template)
  const exportedRc = buildReasoningExportDataset(store, {
    reasoningRunId: backfill.reasoningRunId,
    allFormal: true,
    expandTurns: true,
    format: "reasoning_content",
    systemPrompt: "你是作者本人。",
  });
  assert.equal(exportedRc.train.length, 2);
  assert.equal(exportedRc.skippedMissingTurns, 1);

  // Sample 1: system + user1 + assistant1(reasoning_content + content)
  const s1 = exportedRc.train[0].sample.messages;
  assert.equal(s1.length, 3);
  assert.equal(s1[0].role, "system");
  assert.equal(s1[2].role, "assistant");
  assert.ok(typeof s1[2].reasoning_content === "string" && s1[2].reasoning_content.length > 40);
  assert.ok(!s1[2].content.includes("<think>"));

  // Sample 2: system + user1 + assistant1(PURE content, NO reasoning_content) + user2 + assistant2(reasoning_content)
  const s2 = exportedRc.train[1].sample.messages;
  assert.equal(s2.length, 5);
  assert.equal(s2[2].role, "assistant");
  assert.equal("reasoning_content" in s2[2], false, "history assistant turn must NOT carry reasoning_content");
  assert.equal(s2[2].content.includes("<think>"), false, "history assistant turn must NOT contain <think>");
  assert.equal(s2[4].role, "assistant");
  assert.ok(typeof s2[4].reasoning_content === "string" && s2[4].reasoning_content.length > 40);

  // Verify strict single-line JSONL output
  const jsonlInline = formatReasoningJsonl(exportedInline.train.map((r) => r.sample));
  const jsonlLines = jsonlInline.trimEnd().split("\n");
  assert.equal(jsonlLines.length, 2);
  for (const line of jsonlLines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }

  // Verify Markdown review sheet contains stats, passed items, and dropped diagnostics
  const runRecord = store.getReasoningRun(backfill.reasoningRunId)!;
  const traces = store.queryRunTracesWithContext(backfill.reasoningRunId);
  const md = formatReviewMarkdown(runRecord, traces, backfill.stats);
  assert.match(md, /CoT 脱稿补写审阅稿/);
  assert.match(md, /已通过样本（2 条）/);
  assert.match(md, /未通过 \/ 异常样本（1 条）/);
  assert.match(md, /测试丢弃分支/);

  // Verify startup recovery marks orphaned running runs/traces as interrupted without touching passed traces
  const orphanRun = store.createReasoningRun({
    writerModel: "m",
    judgeModel: null,
    config: {},
    prompts: {},
    skills: [],
  });
  store.startTrace({
    reasoningRunId: orphanRun,
    attemptId: candidates[2].attemptId,
    resultId: candidates[2].resultId,
    turnNo: 1,
    lengthTier: "short",
  });
  const recovered = store.recoverInterruptedRuns();
  assert.deepEqual(recovered, { runs: 1, traces: 1 });
  assert.equal(store.getPassedReasoningMap(backfill.reasoningRunId).size, 2);
  } finally {
    store.close();
  }
});

test("reasoning-cli --help, --status, and --export-only work offline without API keys", async (t) => {
  const dir = await tempDir(t);
  const dbPath = join(dir, "cli-test.sqlite");
  seedUnifiedDb(dbPath);

  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv.LLM_API_KEY;
  delete cleanEnv.LLM_BASE_URL;
  delete cleanEnv.LLM_MODEL;
  delete cleanEnv.REASONING_API_KEY;
  delete cleanEnv.REASONING_BASE_URL;
  delete cleanEnv.REASONING_MODEL;

  const helpRes = await runCli("src/cli/index.ts", ["cot", "--help"], cleanEnv);
  assert.equal(helpRes.code, 0, helpRes.stderr);
  assert.match(helpRes.stdout, /脱稿思考链（CoT）逆向补写/);

  // status works read-only even before reasoning_runs table exists in the DB
  const statusRes = await runCli("src/cli/index.ts", ["cot", "status", "--db", dbPath], cleanEnv);
  assert.equal(statusRes.code, 0, statusRes.stderr);
  const statusJson = JSON.parse(statusRes.stdout) as {
    candidateResults: number;
    candidateTurns: number;
    missingTurns: number;
    reasoningRuns: unknown[];
  };
  assert.equal(statusJson.candidateResults, 2);
  assert.equal(statusJson.candidateTurns, 3);
  assert.equal(statusJson.missingTurns, 3);
  assert.deepEqual(statusJson.reasoningRuns, []);

  // Seed one passed trace for both videos to test --export-only + --val-ratio + --review-md offline
  const store = new ReasoningStore(dbPath);
  try {
    const cands = store.queryCandidateTurns({ allFormal: true });
    const runId = store.createReasoningRun({
      writerModel: "test-writer",
      judgeModel: null,
      config: {},
      prompts: {},
      skills: [],
    });
    for (const c of cands) {
      const tid = store.startTrace({
        reasoningRunId: runId,
        attemptId: c.attemptId,
        resultId: c.resultId,
        turnNo: c.turnNo,
        lengthTier: c.lengthTier,
      });
      store.completeTrace(tid, {
        status: "completed",
        decision: "pass",
        rewriteCount: 0,
        reasoning: `围绕这个问题先拆核心前提，再明确我的判断落点与推进顺序（样本${c.attemptId}，保持简洁自然直觉）。`,
        checks: { finalMetrics: null, llmReview: null, attempts: [] },
        rawOutput: "ok",
      });
    }
    store.finishReasoningRun(runId, "completed");
  } finally {
    store.close();
  }

  const outJsonl = join(dir, "train-cot.jsonl");
  const valJsonl = join(dir, "val-cot.jsonl");
  const manifestPath = join(dir, "manifest.json");
  const reviewPath = join(dir, "review.md");

  const expRes = await runCli(
    "src/cli/index.ts",
    [
      "cot", "export",
      "--db", dbPath,
      "--reasoning-run", "1",
      "--out", outJsonl,
      "--val-out", valJsonl,
      "--val-ratio", "0.5",
      "--shuffle",
      "--seed", "42",
      "--manifest", manifestPath,
      "--review-md", reviewPath,
    ],
    cleanEnv,
  );
  assert.equal(expRes.code, 0, expRes.stderr);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    trainSamples: number;
    valSamples: number;
    trainVideoCount: number;
    valVideoCount: number;
    format: string;
    expandTurns: boolean;
    recommendedMsSwiftArgs: string[];
  };
  assert.equal(manifest.trainSamples + manifest.valSamples, 3);
  assert.equal(manifest.trainVideoCount, 1);
  assert.equal(manifest.valVideoCount, 1);
  assert.equal(manifest.format, "inline");
  assert.equal(manifest.expandTurns, true);
  assert.deepEqual(manifest.recommendedMsSwiftArgs, [
    "--model_type", "qwen3_5",
    "--template", "qwen3_8",
    "--use_chat_template", "true",
    "--enable_thinking", "true",
    "--loss_scale", "last_round",
  ]);

  const reviewContent = await readFile(reviewPath, "utf8");
  assert.match(reviewContent, /已通过样本（3 条）/);
});

test("ReasoningStore supports standard + short profiles together and filter parsers validate input", async (t) => {
  assert.equal(DEFAULT_REASONING_CHECK_CONFIG.maxChars, 1500);
  assert.equal(parseProfileFilter(undefined), "all");
  assert.equal(parseProfileFilter("standard"), "standard");
  assert.equal(parseProfileFilter("short"), "short");
  assert.equal(parseProfileFilter("medium"), "medium");
  assert.equal(parseProfileFilter("long"), "long");
  assert.equal(parseProfileFilter("xlong"), "xlong");
  assert.equal(parseProfileFilter("trap"), "trap");
  assert.equal(parseProfileFilter("search"), "search");
  assert.throws(() => parseProfileFilter("unknown"));

  assert.equal(parseTierFilter(undefined), undefined);
  assert.deepEqual(parseTierFilter("long"), ["long"]);
  assert.deepEqual(parseTierFilter("short,long,short"), ["short", "long"]);
  assert.throws(() => parseTierFilter("huge"));

  const dir = await tempDir(t);
  const dbPath = join(dir, "profiles.sqlite");
  seedUnifiedDb(dbPath);

  // Add a second answer_judge run with profile="short" and an ultra-short 105-char answer
  const dmStore = new DataMakerStore(dbPath);
  try {
    const matC = dmStore.upsertMaterial({
      videoId: "BV1SHORTC/P001",
      content: "短答语料内容",
      sourcePath: "data/BV1SHORTC.md",
    });
    const qRun = dmStore.createRun({
      kind: "question_generation",
      maxAttempts: 1,
      maxTurns: 1,
      config: { mode: "live", profile: "short" },
      prompts: { question: "q" },
      skills: [],
      exportPolicy: { training_enabled: false, split: "train" },
    });
    dmStore.finishRun(qRun, "completed");
    const qShort = dmStore.insertQuestion({
      materialId: matC.id,
      question: "《逻辑研究》研究的就是逻辑学吗？",
      generationRunId: qRun,
    }).record.id;
    const shortRun = dmStore.createRun({
      kind: "answer_judge",
      maxAttempts: 3,
      maxTurns: 2,
      config: { mode: "sqlite-batch", split: "train", profile: "short" },
      prompts: { answer: "a", judge: "j" },
      skills: [],
      exportPolicy: { training_enabled: true, split: "train" },
    });
    const itemMap = dmStore.createRunItems(shortRun, [qShort]);
    const itemId = itemMap.get(qShort)!;
    dmStore.startRunItem(itemId);
    const turnId = dmStore.createTurn({ runItemId: itemId, turnNo: 1 });
    const attemptId = dmStore.startAttempt({ turnId, attemptNo: 1 });
    const shortAnswer = "不是。它研究的不是逻辑学，而是逻辑本身，让逻辑本身内在的规定性向我们显现。说白了，是先把现成的逻辑学框架卸掉，再去直面逻辑本身。";
    const ansCall = dmStore.startModelCall({ runId: shortRun, role: "answer", turnId, attemptId, inputRefs: { material: matC.id, question: qShort } });
    dmStore.finishModelCall(ansCall, shortAnswer);
    dmStore.recordAttemptAnswer(attemptId, shortAnswer);
    const judgeCall = dmStore.startModelCall({ runId: shortRun, role: "judge", turnId, attemptId, inputRefs: { question: qShort, answer: attemptId } });
    dmStore.commitJudgeOutcome({
      runItemId: itemId,
      turnId,
      turnNo: 1,
      attemptId,
      judgeCallId: judgeCall,
      judgeOutputText: JSON.stringify({ decision: "pass", issues: [], feedback: "" }),
      review: { decision: "pass", issues: [], feedback: "" },
      isFinalTurn: true,
      exhaustedBudget: false,
    });
    dmStore.finishRun(shortRun, "completed");
  } finally {
    dmStore.close();
  }

  const rStore = new ReasoningStore(dbPath);
  try {
    const allCands = rStore.queryCandidateTurns({ allFormal: true, profile: "all" });
    const stdCands = rStore.queryCandidateTurns({ allFormal: true, profile: "standard" });
    const shortCands = rStore.queryCandidateTurns({ allFormal: true, profile: "short" });
    assert.equal(stdCands.length, 3);
    assert.equal(shortCands.length, 1);
    assert.equal(allCands.length, 4);
    assert.equal(shortCands[0].sourceProfile, "short");

    const status = rStore.getStatusSummary({ allFormal: true });
    assert.deepEqual(status.byProfile, {
      standard: { results: 2, turns: 3, missingTurns: 3 },
      short: { results: 1, turns: 1, missingTurns: 1 },
      medium: { results: 0, turns: 0, missingTurns: 0 },
      long: { results: 0, turns: 0, missingTurns: 0 },
      xlong: { results: 0, turns: 0, missingTurns: 0 },
      trap: { results: 0, turns: 0, missingTurns: 0 },
      search: { results: 0, turns: 0, missingTurns: 0 },
      todo: { results: 0, turns: 0, missingTurns: 0 },
      clarify: { results: 0, turns: 0, missingTurns: 0 },
    });

    // Stratified selection across standard + short includes both profiles
    const stratified = selectStratifiedTurns(allCands, 2, 42);
    assert.equal(stratified.length, 2);
    assert.ok(stratified.some((c) => c.sourceProfile === "standard"));
    assert.ok(stratified.some((c) => c.sourceProfile === "short"));

    // Seed passed traces and verify profileDistribution in export
    const runId = rStore.createReasoningRun({ writerModel: "m", judgeModel: null, config: {}, prompts: {}, skills: [] });
    for (const c of allCands) {
      const tid = rStore.startTrace({ reasoningRunId: runId, attemptId: c.attemptId, resultId: c.resultId, turnNo: c.turnNo, lengthTier: c.lengthTier });
      rStore.completeTrace(tid, {
        status: "completed",
        decision: "pass",
        rewriteCount: 0,
        reasoning: "先把书名和现成学科框架分开，这里问的是逻辑本身而不是逻辑学教材。",
        checks: { finalMetrics: null, llmReview: null, attempts: [] },
        rawOutput: "ok",
      });
    }
    rStore.finishReasoningRun(runId, "completed");
    const exported = buildReasoningExportDataset(rStore, { allFormal: true, profile: "all" });
    assert.deepEqual(exported.profileDistribution, {
      standard: 3,
      short: 1,
      medium: 0,
      long: 0,
      xlong: 0,
      trap: 0,
      search: 0,
      todo: 0,
      clarify: 0,
    });
  } finally {
    rStore.close();
  }
});
