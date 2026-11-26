import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReasoningExportDataset, formatReviewMarkdown } from "../src/reasoning/export.js";
import { runReasoningBackfill } from "../src/reasoning/engine.js";
import { ReasoningStore } from "../src/reasoning/store.js";
import { parseOptionalSynthProfile } from "../src/shared/schema.js";
import {
  attachNegativeToolDeclaration,
  buildToolDefinition,
  buildToolStepMessages,
  CANONICAL_WEB_SEARCH_VARIANT,
  GENERALIZED_WEB_SEARCH_VARIANTS,
  pickWebSearchToolVariant,
} from "../src/shared/tool-schema.js";
import { TRAIN_SUITE_PROFILES, type RoleRunner, type SearchAnswerRunner, type ToolStep, type TrainingSampleLine } from "../src/shared/types.js";
import { createSeededRng } from "../src/shared/utils.js";
import { createWebSearchAgentTool, normalizeSearchCacheKey, parseMagpieWebSearchOutput } from "../src/shared/web-search.js";
import { runDialogueBatch } from "../src/synth/dialogue-loop.js";
import { resolveSynthBundle } from "../src/synth/skills.js";
import { DataMakerStore } from "../src/synth/store/index.js";

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "data-maker-search-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("parseMagpieWebSearchOutput parses magpie tool JSON and enforces truncation and empty fallback", () => {
  const raw = JSON.stringify({
    content: [{ type: "text", text: "1. 国家统计局公告 — https://stats.gov.cn\n2024年GDP总量1348066亿元。" }],
    isError: false,
  });
  const parsed = parseMagpieWebSearchOutput(raw, "2024年中国GDP");
  assert.equal(parsed.isError, false);
  assert.match(parsed.text, /1348066亿元/);

  const truncated = parseMagpieWebSearchOutput(JSON.stringify({ content: [{ type: "text", text: "A".repeat(200) }] }), "q", 50);
  assert.ok(truncated.text.length <= 50);
  assert.match(truncated.text, /已截断/);

  const empty = parseMagpieWebSearchOutput("", "empty");
  assert.equal(empty.isError, false);
  assert.match(empty.text, /未检索到/);

  assert.equal(
    normalizeSearchCacheKey("  Isaac   Newton  Title ", 5, "low"),
    normalizeSearchCacheKey("isaac newton title", 5, "low"),
  );
  assert.notEqual(
    normalizeSearchCacheKey("isaac newton title", 5, "low"),
    normalizeSearchCacheKey("isaac newton title", 10, "low"),
  );
});

test("createWebSearchAgentTool records ToolStep and enforces maxCalls cap", async () => {
  const steps: ToolStep[] = [];
  let runnerCalls = 0;
  const tool = createWebSearchAgentTool(
    async ({ query }) => {
      runnerCalls++;
      return { query, text: `证据:${query}`, isError: false };
    },
    { maxCalls: 2, onStep: (step) => steps.push(step) },
  );

  const r1 = await tool.execute("c1", { query: "查询1" });
  const r2 = await tool.execute("c2", { query: "查询2" });
  const r3 = await tool.execute("c3", { query: "查询3" });

  assert.equal(runnerCalls, 2);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], {
    stepNo: 1,
    toolName: "web_search",
    arguments: { query: "查询1" },
    toolOutput: "证据:查询1",
  });
  assert.match((r1.content[0] as { text: string }).text, /证据:查询1/);
  assert.match((r2.content[0] as { text: string }).text, /证据:查询2/);
  assert.match((r3.content[0] as { text: string }).text, /搜索次数已达上限/);
});

test("generic tool schema randomization keeps tools, tool_calls, and tool role strictly consistent", () => {
  const rng = createSeededRng(123);
  const seenNames = new Set<string>();
  const steps: ToolStep[] = [
    {
      stepNo: 1,
      toolName: "web_search",
      arguments: { query: "2024 GDP" },
      toolOutput: "2024年GDP现价总量为1348066亿元。",
      preCallThought: "这个具体数字不能靠记忆硬猜，先搜官方口径。",
    },
  ];

  for (let i = 0; i < 30; i++) {
    const variant = pickWebSearchToolVariant(rng, true);
    seenNames.add(variant.name);
    const def = buildToolDefinition(variant);
    const msgs = buildToolStepMessages(steps, variant, { format: "inline", callIdPrefix: "t1" });

    assert.equal(msgs.length, 2);
    const assistantMsg = msgs[0]!;
    const toolMsg = msgs[1]!;
    assert.equal(assistantMsg.role, "assistant");
    assert.match(assistantMsg.content, /<think>\n这个具体数字不能靠记忆硬猜，先搜官方口径。\n<\/think>/);
    assert.equal(assistantMsg.tool_calls?.[0]?.function.name, def.function.name);
    const parsedArgs = JSON.parse(assistantMsg.tool_calls![0]!.function.arguments) as Record<string, string>;
    assert.equal(parsedArgs[variant.queryParam], "2024 GDP");
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.name, def.function.name);
    assert.equal(toolMsg.tool_call_id, assistantMsg.tool_calls?.[0]?.id);
  }

  assert.ok(seenNames.size >= 3, `expected randomized tool aliases, got: ${[...seenNames].join(", ")}`);
  assert.equal(pickWebSearchToolVariant(rng, false).name, CANONICAL_WEB_SEARCH_VARIANT.name);
  assert.ok(GENERALIZED_WEB_SEARCH_VARIANTS.length >= 4);

  const baseSample: TrainingSampleLine = {
    messages: [{ role: "user", content: "你必须二选一" }, { role: "assistant", content: "这俩我都不选。" }],
  };
  const neg = attachNegativeToolDeclaration(baseSample, createSeededRng(7), true);
  assert.equal(neg.tools?.length, 1);
  assert.equal(neg.messages.some((m) => m.role === "tool" || Boolean(m.tool_calls)), false);
});

test("search profile bundle loads ready prompt/skills and registers in suite profiles", async () => {
  assert.equal(parseOptionalSynthProfile("search"), "search");
  assert.ok(TRAIN_SUITE_PROFILES.includes("search"));
  const bundle = await resolveSynthBundle({
    profile: "search",
    maxTurns: 2,
    includeQuestionGenerator: true,
  });
  assert.equal(bundle.rubricReady, true);
  assert.match(bundle.dialoguePrompts.answer, /web_search/);
  assert.equal(bundle.questionSkills[0]?.status, "ready");
  assert.equal(bundle.dialogueSkills.every((s) => s.status === "ready"), true);
});

test("end-to-end search dialogue loop, SQLite tool steps, CoT backfill, and generalized/negative tool export", async (t) => {
  const dir = await tempDir(t);
  const dbPath = join(dir, "search-e2e.sqlite");
  const store = new DataMakerStore(dbPath);
  const seenJudgeInputs: Array<Record<string, unknown>> = [];

  try {
    const matA = store.upsertMaterial({ videoId: "BV_SEARCH_1", content: "原文框架：看宏观数字得看口径和结构。" });
    const matB = store.upsertMaterial({ videoId: "BV_TRAP_1", content: "原文框架：不要替陌生人拍板人生选择。" });
    const qSearch = store.insertQuestion({ materialId: matA.id, question: "2024年国内GDP最终核实是多少？怎么看这个增速？" });
    const qTrap = store.insertQuestion({ materialId: matB.id, question: "我明天到底该不该立刻辞职？你给我拍个板。" });

    const runSearchAnswer: SearchAnswerRunner = async () => ({
      answer: "按国家统计局最终核实数，2024年GDP现价总量是1348066亿元、增长5.0%。但光盯总盘子没用，得看结构分配。",
      toolSteps: [
        {
          stepNo: 1,
          toolName: "web_search",
          arguments: { query: "2024年中国GDP最终核实 国家统计局" },
          toolOutput: "国家统计局公告：经最终核实，2024年GDP现价总量为1348066亿元，比上年增长5.0%。",
          preCallThought: "具体核实数字不能瞎蒙，先查一下国家统计局公告。",
        },
      ],
    });

    const runRole: RoleRunner = async (req) => {
      if (req.role === "judge") {
        seenJudgeInputs.push(req.input);
        return JSON.stringify({ decision: "pass", issues: [], feedback: "" });
      }
      if (req.role === "answer") {
        return "你明天辞不辞职我替你拍不了板，这笔账最后是你自己扛。";
      }
      throw new Error(`unexpected role: ${req.role}`);
    };

    const searchRun = await runDialogueBatch({
      store,
      runRole,
      runSearchAnswer,
      prompts: { answer: "search answer prompt", judge: "search judge prompt" },
      maxAttempts: 2,
      maxTurns: 1,
      questionIds: [qSearch.record.id],
      config: { profile: "search", mode: "test" },
      exportPolicy: { format: "messages_jsonl", split: "train", training_enabled: true },
    });

    const trapRun = await runDialogueBatch({
      store,
      runRole,
      prompts: { answer: "trap answer prompt", judge: "trap judge prompt" },
      maxAttempts: 2,
      maxTurns: 1,
      questionIds: [qTrap.record.id],
      config: { profile: "trap", mode: "test" },
      exportPolicy: { format: "messages_jsonl", split: "train", training_enabled: true },
    });

    assert.equal(searchRun.results, 1);
    assert.equal(trapRun.results, 1);
    assert.equal(searchRun.integrityOk, true);
    assert.equal(Array.isArray(seenJudgeInputs[0]?.toolSteps), true);

    // Synth merged export with tool generalization + negative tools on non-search sample
    const merged = store.exportMergedDataset({
      allFormal: true,
      seed: 42,
      generalizeTools: true,
      negativeToolsRatio: 1,
    });
    assert.equal(merged.train.length, 2);
    const searchSample = merged.train.find((r) => r.questionId === qSearch.record.id)!.sample;
    const trapSample = merged.train.find((r) => r.questionId === qTrap.record.id)!.sample;

    assert.equal(searchSample.tools?.length, 1);
    assert.deepEqual(searchSample.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(searchSample.messages[1]?.tool_calls?.[0]?.function.name, searchSample.tools![0]!.function.name);
    assert.equal(searchSample.messages[2]?.name, searchSample.tools![0]!.function.name);
    assert.equal(trapSample.tools?.length, 1);
    assert.deepEqual(trapSample.messages.map((m) => m.role), ["user", "assistant"]);
  } finally {
    store.close();
  }

  // CoT backfill + export should see toolSteps and emit both pre-call thinking and post-tool CoT
  const rStore = new ReasoningStore(dbPath);
  const seenCotWriterInputs: Array<Record<string, unknown>> = [];
  try {
    const candidates = rStore.queryCandidateTurns({ allFormal: true });
    assert.equal(candidates.length, 2);
    const searchCand = candidates.find((c) => c.sourceProfile === "search")!;
    assert.equal(searchCand.toolSteps?.length, 1);

    const backfill = await runReasoningBackfill({
      store: rStore,
      candidates,
      writerPrompt: "writer",
      writerSkill: { status: "ready", body: "body", sha256: "a".repeat(64) },
      writerSkillPath: "skills/reasoning-writer/SKILL.md",
      writerModel: "test-writer",
      runWriter: async (req) => {
        seenCotWriterInputs.push(req.input);
        return Array.isArray(req.input.toolSteps)
          ? "核实完官方数了，总量和增速都摆在这，但真正要拆的是结构分配问题。"
          : "辞职与否是对方自己扛后果的重大选择，不能替陌生人拍板。";
      },
    });
    assert.equal(backfill.stats.passed, 2);
    assert.ok(seenCotWriterInputs.some((inp) => Array.isArray(inp.toolSteps)));

    const exported = buildReasoningExportDataset(rStore, {
      allFormal: true,
      format: "inline",
      seed: 42,
      generalizeTools: true,
      negativeToolsRatio: 1,
    });
    const cotSearch = exported.train.find((r) => r.sourceProfile === "search")!.sample;
    const cotTrap = exported.train.find((r) => r.sourceProfile === "trap")!.sample;

    assert.equal(cotSearch.tools?.length, 1);
    assert.deepEqual(cotSearch.messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
    assert.match(cotSearch.messages[1]!.content, /<think>\n具体核实数字不能瞎蒙/);
    assert.equal(cotSearch.messages[1]!.tool_calls?.[0]?.function.name, cotSearch.tools![0]!.function.name);
    assert.match(cotSearch.messages[3]!.content, /<think>\n核实完官方数了/);
    assert.equal(cotTrap.tools?.length, 1);
    assert.deepEqual(cotTrap.messages.map((m) => m.role), ["user", "assistant"]);

    const run = rStore.getReasoningRun(backfill.reasoningRunId)!;
    const traces = rStore.queryRunTracesWithContext(backfill.reasoningRunId);
    const md = formatReviewMarkdown(run, traces);
    assert.match(md, /检索工具调用轨迹/);
  } finally {
    rStore.close();
  }
});
