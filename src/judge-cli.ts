import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DataMakerStore, validateMaxTurns } from "./db.js";
import { loadTargetQuestions, runDialogueBatch } from "./dialogue-loop.js";
import {
  DEFAULT_ANSWER_STYLE,
  DEFAULT_EVAL_RUBRIC_SKILL,
  DEFAULT_FOLLOWUP_SKILL,
  DEFAULT_QUALITY_JUDGE,
  readAnswerStyle,
  readEvalRubricSkill,
  readFollowupSkill,
  readRubric,
} from "./io.js";
import { createPiRunner, readPiConfig } from "./pi-runner.js";
import {
  answerPrompt,
  DEFAULT_PROMPTS_DIR,
  evalRubricPrompt,
  followupPrompt as composeFollowupPrompt,
  judgePrompt,
  readRubricPrompt,
} from "./prompts.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "./retry.js";
import { errorMessage, nonEmpty, validateConcurrency, validateMaxAttempts, validateSplit } from "./schema.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NO_SKILL_PROMPTS_DIR = join(ROOT, "prompts/no-skill");

function parseQuestionIds(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const ids = raw.split(",").map((part) => Number(part.trim()));
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("--question-ids 必须是以逗号分隔的正整数列表");
  }
  return [...new Set(ids)];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      prompts: { type: "string" },
      skill: { type: "string" },
      "answer-style": { type: "string" },
      "followup-skill": { type: "string" },
      "no-skill": { type: "boolean", default: false },
      "max-attempts": { type: "string" },
      "call-attempts": { type: "string" },
      "retry-delay-ms": { type: "string" },
      "max-turns": { type: "string" },
      "fixed-turns": { type: "boolean", default: false },
      "no-length-tier": { type: "boolean", default: false },
      concurrency: { type: "string" },
      split: { type: "string" },
      "extract-rubric": { type: "boolean", default: false },
      "rubric-skill": { type: "string" },
      "video-id": { type: "string" },
      "question-ids": { type: "string" },
      "only-unjudged": { type: "boolean", default: false },
      export: { type: "string" },
      system: { type: "string" },
      "system-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      "基于统一 SQLite 执行单轮或多轮回答/质检循环（默认加载 answer-style / quality-judge / followup-strategy 正式 Skill）\n" +
      "npm run judge -- [--db data/data-maker.sqlite] [--split train|test|dpo] [--max-attempts 3] [--call-attempts 3] [--retry-delay-ms 3000] [--max-turns 3] [--concurrency 10]\n" +
      "                 [--video-id ID] [--question-ids 1,2,3] [--only-unjudged] [--extract-rubric [--rubric-skill PATH]]\n" +
      "                 [--prompts prompts] [--skill PATH] [--answer-style PATH] [--followup-skill PATH]\n" +
      "                 [--no-skill] [--export PATH [--system TEXT | --system-file PATH]]",
    );
    return;
  }

  if (values.system !== undefined && values["system-file"] !== undefined) {
    throw new Error("--system 与 --system-file 不能同时指定");
  }
  if (
    values["no-skill"]
    && (values.skill !== undefined || values["answer-style"] !== undefined || values["followup-skill"] !== undefined || values["rubric-skill"] !== undefined)
  ) {
    throw new Error("--no-skill 不能与 --skill / --answer-style / --followup-skill / --rubric-skill 同时指定");
  }

  const targetSplit = values.split !== undefined ? validateSplit(values.split, "--split") : undefined;
  const extractRubric = Boolean(values["extract-rubric"]);
  const maxAttempts = validateMaxAttempts(Number(values["max-attempts"] ?? 3));
  const callMaxAttempts = validateCallMaxAttempts(Number(values["call-attempts"] ?? DEFAULT_CALL_MAX_ATTEMPTS));
  const callRetryDelayMs = validateCallRetryDelayMs(Number(values["retry-delay-ms"] ?? DEFAULT_CALL_RETRY_DELAY_MS));
  const maxTurns = validateMaxTurns(Number(values["max-turns"] ?? 3));
  const distributeTurns = !values["fixed-turns"] && maxTurns > 1;
  const distributeLength = !values["no-length-tier"];
  const concurrency = validateConcurrency(Number(values.concurrency ?? 10));
  const dbPath = resolve(values.db ?? join(ROOT, "data/data-maker.sqlite"));
  const noSkill = Boolean(values["no-skill"]);
  const promptDir = resolve(values.prompts ?? (noSkill ? NO_SKILL_PROMPTS_DIR : DEFAULT_PROMPTS_DIR));
  const questionIds = parseQuestionIds(values["question-ids"]);

  let answerSystemPrompt = nonEmpty(await readFile(join(promptDir, "answer.md"), "utf8"), "回答系统提示词");
  let judgeSystemPrompt = nonEmpty(await readFile(join(promptDir, "judge.md"), "utf8"), "质检系统提示词");
  let followupSystemPrompt = maxTurns > 1
    ? nonEmpty(await readFile(join(promptDir, "followup.md"), "utf8"), "多轮追问系统提示词")
    : undefined;
  let rubricSystemPrompt = extractRubric
    ? await readRubricPrompt(promptDir).catch(() => readRubricPrompt(DEFAULT_PROMPTS_DIR))
    : undefined;

  const skills: Array<Record<string, unknown>> = [];
  let rubricReady = false;

  if (!noSkill) {
    const stylePath = resolve(values["answer-style"] ?? DEFAULT_ANSWER_STYLE);
    const style = await readAnswerStyle(stylePath);
    answerSystemPrompt = answerPrompt(answerSystemPrompt, style.body);
    skills.push({ name: "answer-style", path: stylePath, status: style.status, body: style.body, sha256: style.sha256 });

    const rubricPath = resolve(values.skill ?? DEFAULT_QUALITY_JUDGE);
    const rubric = await readRubric(rubricPath);
    judgeSystemPrompt = judgePrompt(judgeSystemPrompt, rubric.body);
    rubricReady = rubric.status === "ready";
    skills.push({ name: "quality-judge", path: rubricPath, status: rubric.status, body: rubric.body, sha256: rubric.sha256 });

    if (maxTurns > 1 && followupSystemPrompt !== undefined) {
      const followupSkillPath = resolve(values["followup-skill"] ?? DEFAULT_FOLLOWUP_SKILL);
      const followupSkill = await readFollowupSkill(followupSkillPath);
      followupSystemPrompt = composeFollowupPrompt(followupSystemPrompt, followupSkill.body);
      skills.push({
        name: "followup-strategy",
        path: followupSkillPath,
        status: followupSkill.status,
        body: followupSkill.body,
        sha256: followupSkill.sha256,
      });
    }

    if (extractRubric && rubricSystemPrompt !== undefined) {
      const evalRubricSkillPath = resolve(values["rubric-skill"] ?? DEFAULT_EVAL_RUBRIC_SKILL);
      const evalRubricSkill = await readEvalRubricSkill(evalRubricSkillPath);
      rubricSystemPrompt = evalRubricPrompt(rubricSystemPrompt, evalRubricSkill.body);
      skills.push({
        name: "eval-rubric",
        path: evalRubricSkillPath,
        status: evalRubricSkill.status,
        body: evalRubricSkill.body,
        sha256: evalRubricSkill.sha256,
      });
    }
  }

  let exportSystemPrompt: string | undefined;
  if (values.system !== undefined) {
    exportSystemPrompt = nonEmpty(values.system, "--system");
  } else if (values["system-file"] !== undefined) {
    exportSystemPrompt = nonEmpty(await readFile(resolve(values["system-file"]), "utf8"), "--system-file");
  }

  const config = readPiConfig();
  const { apiKey: _apiKey, ...sanitizedModel } = config;
  const runRole = createPiRunner(config);

  const store = new DataMakerStore(dbPath);
  try {
    const onlyUnjudged = Boolean(values["only-unjudged"]);
    if (onlyUnjudged) {
      store.markInterruptedRuns();
      const pending = loadTargetQuestions(store, {
        videoId: values["video-id"],
        questionIds,
        onlyUnjudged: true,
        maxTurns,
        split: targetSplit,
      });
      if (pending.length === 0) {
        console.log(JSON.stringify({
          db: dbPath,
          ...(targetSplit ? { split: targetSplit } : {}),
          maxTurns,
          onlyUnjudged: true,
          selectedQuestions: 0,
          message: "没有需要处理的未质检问题",
        }, null, 2));
        return;
      }
    }

    const effectiveSplit = targetSplit ?? "train";
    const trainingEnabled = effectiveSplit === "train" && rubricReady;
    const evalEnabled = effectiveSplit !== "train" && rubricReady;

    const summary = await runDialogueBatch({
      store,
      runRole,
      prompts: {
        answer: answerSystemPrompt,
        judge: judgeSystemPrompt,
        followup: followupSystemPrompt,
        rubric: rubricSystemPrompt,
      },
      maxAttempts,
      maxTurns,
      concurrency,
      callMaxAttempts,
      callRetryDelayMs,
      distributeTurns,
      distributeLength,
      split: targetSplit,
      videoId: values["video-id"],
      questionIds,
      onlyUnjudged,
      config: {
        mode: noSkill ? "sqlite-judge-no-skill" : "sqlite-judge",
        ...(targetSplit ? { split: targetSplit } : {}),
        model: sanitizedModel,
        promptDirectory: promptDir,
        ...(extractRubric ? { extractRubric: true } : {}),
        inputSchemaVersion: maxTurns > 1 ? "v2-multiturn-json" : "v1-minimal-json",
      },
      skills,
      exportPolicy: effectiveSplit === "train"
        ? { format: "messages_jsonl", training_enabled: trainingEnabled }
        : {
            format: "messages_jsonl",
            split: effectiveSplit,
            purpose: effectiveSplit,
            training_enabled: false,
            eval_enabled: evalEnabled,
          },
      onProgress: (message) => console.log(message),
    });

    let exportedPath: string | undefined;
    if (values.export !== undefined) {
      exportedPath = resolve(nonEmpty(values.export, "--export"));
      const jsonl = store.exportRunJsonl(summary.runId, { systemPrompt: exportSystemPrompt });
      await mkdir(dirname(exportedPath), { recursive: true });
      await writeFile(exportedPath, jsonl, "utf8");
    }

    console.log(JSON.stringify({ ...summary, trainingEnabled, ...(exportedPath ? { exportedPath } : {}) }, null, 2));
    if (!summary.integrityOk || summary.errors > 0) {
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
