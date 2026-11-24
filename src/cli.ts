import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DataMakerStore, validateMaxTurns } from "./db.js";
import { createDemoRunner } from "./demo.js";
import {
  DEFAULT_ANSWER_STYLE,
  DEFAULT_FOLLOWUP_SKILL,
  DEFAULT_QUALITY_JUDGE,
  DEFAULT_QUESTION_SKILL,
  readAnswerStyle,
  readFollowupSkill,
  readMaterials,
  readQuestionSkill,
  readRubric,
} from "./io.js";
import { readPiConfig } from "./pi-runner.js";
import { runMaterialsToStore } from "./pipeline.js";
import { DEFAULT_PROMPTS_DIR, readFollowupPrompt, readSystemPrompts } from "./prompts.js";
import { errorMessage, nonEmpty, validateConcurrency, validateMaxAttempts } from "./schema.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLE = join(ROOT, "data/materials.example.jsonl");
const DEFAULT_DB = join(ROOT, "data/data-maker.sqlite");
const DEFAULT_DEMO_DB = join(ROOT, "output/demo.sqlite");
const DEMO_DIRECTION = "根据传感器说明生成使用与告警规则的问答";

const HELP = `pi-posttrain-loop — 统一 SQLite 训练数据生成 CLI

离线演示（固定脚本，无模型调用，默认写入 output/demo.sqlite）：
  npm run demo

接入模型（先将 .env.example 复制为 .env 并配置）：
  npm start -- --input data/materials.example.jsonl --direction "理解设备使用与告警规则"

参数：
  --input PATH          输入 JSONL，每行 {"id":"唯一标识","text":"材料"}
  --direction TEXT      出题大方向，真实调用时必填
  --db PATH             统一 SQLite 数据库路径（默认 data/data-maker.sqlite；--demo 默认 output/demo.sqlite）
  --question-skill PATH 出题 Skill，默认 skills/question-design/SKILL.md
  --followup-skill PATH 追问 Skill，默认 skills/followup-strategy/SKILL.md
  --answer-style PATH   回答风格 Skill，默认 skills/answer-style/SKILL.md
  --skill PATH          判断 Skill，默认 skills/quality-judge/SKILL.md
  --prompts PATH        系统提示词目录，默认 prompts/
  --max-attempts N      每对话轮最多尝试次数，默认 3，范围 1–10
  --max-turns N         每条样本目标对话轮上限，默认 1，范围 1–20
  --concurrency N       并发处理的材料/题目数，默认 live=10 / demo=1，范围 1–500
  --export PATH         可选：运行完成后导出本次通过结果为严格单行 JSONL
  --system TEXT         可选：搭配 --export 注入统一训练 system 提示词
  --system-file PATH    可选：从文件读取训练 system 提示词（与 --system 互斥）
  --demo                固定示例演示，验证 revise/pass/drop 路径
  --help                查看说明
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      direction: { type: "string" },
      db: { type: "string" },
      "question-skill": { type: "string" },
      "followup-skill": { type: "string" },
      skill: { type: "string" },
      "answer-style": { type: "string" },
      prompts: { type: "string" },
      "max-attempts": { type: "string" },
      "max-turns": { type: "string" },
      concurrency: { type: "string" },
      export: { type: "string" },
      system: { type: "string" },
      "system-file": { type: "string" },
      demo: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.system !== undefined && values["system-file"] !== undefined) {
    throw new Error("--system 与 --system-file 不能同时指定");
  }

  const mode = values.demo ? "demo" : "live";
  if (values.demo && (values.input !== undefined || values.direction !== undefined)) {
    throw new Error("--demo 使用固定材料和方向；自定义输入请使用真实模型模式");
  }

  const direction = values.demo ? DEMO_DIRECTION : nonEmpty(values.direction, "--direction");
  const maxAttempts = validateMaxAttempts(Number(values["max-attempts"] ?? 3));
  const maxTurns = validateMaxTurns(Number(values["max-turns"] ?? 1));
  const concurrency = validateConcurrency(Number(values.concurrency ?? (values.demo ? 1 : 10)));
  const inputPath = resolve(values.input ?? EXAMPLE);
  const dbPath = resolve(values.db ?? (values.demo ? DEFAULT_DEMO_DB : DEFAULT_DB));
  const questionSkillPath = resolve(values["question-skill"] ?? DEFAULT_QUESTION_SKILL);
  const followupSkillPath = resolve(values["followup-skill"] ?? DEFAULT_FOLLOWUP_SKILL);
  const skillPath = resolve(values.skill ?? DEFAULT_QUALITY_JUDGE);
  const answerStylePath = resolve(values["answer-style"] ?? DEFAULT_ANSWER_STYLE);
  const promptDirectory = resolve(values.prompts ?? DEFAULT_PROMPTS_DIR);

  const materials = await readMaterials(inputPath);
  const questionSkill = await readQuestionSkill(questionSkillPath);
  const rubric = await readRubric(skillPath);
  const answerStyle = await readAnswerStyle(answerStylePath);
  const prompts = await readSystemPrompts(promptDirectory);

  let baseFollowupPrompt: string | undefined;
  let followupSkill;
  if (maxTurns > 1) {
    try {
      baseFollowupPrompt = await readFollowupPrompt(promptDirectory);
    } catch {
      baseFollowupPrompt = await readFollowupPrompt(DEFAULT_PROMPTS_DIR);
    }
    followupSkill = await readFollowupSkill(followupSkillPath);
  }

  let exportSystemPrompt: string | undefined;
  if (values.system !== undefined) {
    exportSystemPrompt = nonEmpty(values.system, "--system");
  } else if (values["system-file"] !== undefined) {
    exportSystemPrompt = nonEmpty(await readFile(resolve(values["system-file"]), "utf8"), "--system-file");
  }

  const config = mode === "live" ? readPiConfig() : undefined;
  const runRole = config
    ? (await import("./pi-runner.js")).createPiRunner(config)
    : createDemoRunner();

  const sanitizedModel = config
    ? {
        id: config.modelId,
        baseUrl: config.baseUrl,
        maxTokens: config.maxTokens,
        contextWindow: config.contextWindow,
        thinkingLevel: config.thinkingLevel,
        ...(config.roleThinkingLevels ? { roleThinkingLevels: config.roleThinkingLevels } : {}),
        timeoutMs: config.timeoutMs,
      }
    : "deterministic-demo-fixture";

  console.log(`模式：${mode}；材料：${materials.length}；每轮最多 ${maxAttempts} 次尝试；最多 ${maxTurns} 对话轮；并发 ${concurrency}`);
  console.log(`数据库：${dbPath}`);

  const store = new DataMakerStore(dbPath);
  try {
    const summary = await runMaterialsToStore({
      store,
      materials,
      direction,
      questionSkill,
      followupSkill,
      rubric,
      answerStyle,
      prompts,
      followupPrompt: baseFollowupPrompt,
      runRole,
      maxAttempts,
      maxTurns,
      concurrency,
      mode,
      config: {
        inputPath,
        promptDirectory,
        model: sanitizedModel,
      },
      skillPaths: {
        questionSkillPath,
        followupSkillPath: maxTurns > 1 ? followupSkillPath : undefined,
        rubricPath: skillPath,
        answerStylePath,
      },
      onProgress: (message) => console.log(message),
    });

    let exportedPath: string | undefined;
    if (values.export !== undefined && summary.judgeRunId !== undefined) {
      exportedPath = resolve(nonEmpty(values.export, "--export"));
      const jsonl = store.exportRunJsonl(summary.judgeRunId, { systemPrompt: exportSystemPrompt });
      await mkdir(dirname(exportedPath), { recursive: true });
      await writeFile(exportedPath, jsonl, "utf8");
    }

    const outcomes = summary.dialogue?.outcomes ?? {};
    const passed = outcomes.pass ?? 0;
    const dropped = outcomes.drop ?? 0;
    const exhausted = outcomes.exhausted ?? 0;
    const errors = summary.questionErrors + (summary.dialogue?.errors ?? 0);

    console.log(`完成：通过 ${passed}，跳过 ${dropped}，耗尽 ${exhausted}，错误 ${errors}`);
    console.log(JSON.stringify({
      db: dbPath,
      mode,
      questionRunId: summary.questionRunId,
      judgeRunId: summary.judgeRunId ?? null,
      materials: summary.materials,
      questions: summary.generatedQuestions,
      passed,
      dropped,
      exhausted,
      errors,
      results: summary.dialogue?.results ?? 0,
      trainingEnabled: summary.trainingEnabled,
      rubricStatus: rubric.status,
      integrityOk: summary.integrityOk,
      ...(exportedPath ? { exportedPath } : {}),
    }, null, 2));

    if (!summary.integrityOk || errors > 0) {
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(`错误：${errorMessage(error)}`);
  process.exitCode = 1;
});
