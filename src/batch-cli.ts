import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  extractVideoKey,
  queryProcessedVideoIndex,
  scanCorpusVideos,
  selectVideos,
  summarizeCorpusStatus,
} from "./corpus.js";
import { runCorpusQuestionGeneration } from "./corpus-questions.js";
import { DataMakerStore, validateMaxTurns } from "./db.js";
import { loadTargetQuestions, runDialogueBatch } from "./dialogue-loop.js";
import { assertNoEvalLeak, readEvalVideoKeys } from "./eval-guard.js";
import {
  DEFAULT_ANSWER_STYLE,
  DEFAULT_EVAL_RUBRIC_SKILL,
  DEFAULT_FOLLOWUP_SKILL,
  DEFAULT_QUALITY_JUDGE,
  DEFAULT_QUESTION_SKILL,
  readAnswerStyle,
  readEvalRubricSkill,
  readFollowupSkill,
  readQuestionSkill,
  readRubric,
} from "./io.js";
import { createPiRunner, readPiConfig } from "./pi-runner.js";
import {
  answerPrompt,
  DEFAULT_PROMPTS_DIR,
  evalRubricPrompt,
  followupPrompt as composeFollowupPrompt,
  judgePrompt,
  questionPrompt,
  readRubricPrompt,
} from "./prompts.js";
import {
  DEFAULT_CALL_MAX_ATTEMPTS,
  DEFAULT_CALL_RETRY_DELAY_MS,
  validateCallMaxAttempts,
  validateCallRetryDelayMs,
} from "./retry.js";
import { errorMessage, nonEmpty, validateConcurrency, validateMaxAttempts, validateSplit } from "./schema.js";
import { summarizeSplitCounts, syncCorpusSplits } from "./splits.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_CORPUS_DIR = join(ROOT, "data/weimingzi-semantic");
const DEFAULT_DB = join(ROOT, "data/data-maker.sqlite");
const NO_SKILL_PROMPTS_DIR = join(ROOT, "prompts/no-skill");

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

const HELP = `一条命令完成全流程批量生产：选未处理视频（多 P 自动合并防重）→ 并发出题 → 单/多轮问答质检 → 可选导出 JSONL

快速用法：
  npm run batch -- --limit 10 --shuffle --export output/train-batch.jsonl

查看语料库进度（不调用模型）：
  npm run batch -- --status

参数：
  --input-dir PATH       语料目录，默认 data/weimingzi-semantic
  --split SPLIT          数据集分区：train（默认）| test | dpo（持久哈希注册，防测试集泄漏）
  --limit N              本次抽取未处理视频数（按视频计，多 P 算 1 个），默认 10
  --shuffle              随机抽选未处理视频（默认按视频 ID 顺序）
  --max-questions N      可选：手动覆盖单视频/分块出题上限（默认按字数与分P数动态封顶 3–10 题）
  --max-turns N          每条样本对话轮上限，默认 3（搭配默认 1轮30%:2轮50%:3轮20% 比例分配），范围 1–20
  --fixed-turns          禁用按比例分配轮数，所有问题固定跑满 --max-turns 轮上限
  --no-length-tier       禁用短/中/长（25%:50%:25%）回答篇幅档位控制
  --max-attempts N       每对话轮质检返工上限，默认 3，范围 1–10
  --call-attempts N      单次模型调用异常/解析失败最多尝试次数（含重试），默认 3，范围 1–10（仍失败则丢弃该题）
  --retry-delay-ms MS    单次模型调用重试间隔毫秒数，默认 3000（3 秒），范围 0–60000
  --concurrency N        出题与问答并发数，默认 10，范围 1–500
  --include-unjudged     除本次新出题外，顺带补跑库里同分区之前未完成同轮数质检的遗留题（如上次 error）
  --extract-rubric       可选（推荐 test/dpo 分区开启）：对通过的每轮问答自动抽取结构化评分要点存入 eval_rubrics
  --rubric-skill PATH    评分要点 Skill，默认 skills/eval-rubric/SKILL.md
  --freeze-version NAME  可选（仅限 test/dpo 分区）：本批完成后将当前分区已通过样本冻结为不可变测试集版本（如 test-v1）
  --db PATH              统一 SQLite 路径，默认 data/data-maker.sqlite
  --prompts PATH         对话提示词目录（默认 prompts/；--no-skill 默认 prompts/no-skill/）
  --question-skill PATH  出题 Skill，默认 skills/question-design/SKILL.md
  --followup-skill PATH  追问 Skill，默认 skills/followup-strategy/SKILL.md
  --answer-style PATH    回答风格 Skill，默认 skills/answer-style/SKILL.md
  --skill PATH           判断 Skill，默认 skills/quality-judge/SKILL.md
  --no-skill             所有角色不加载 Skill
  --export PATH          可选：完成后导出本次通过结果为严格单行 JSONL
  --system TEXT          可选：搭配 --export 注入统一训练 system 提示词
  --system-file PATH     可选：从文件读取训练 system 提示词（与 --system 互斥）
  --status               仅查看语料库处理进度（含 train/test/dpo 分区统计），不调用模型
  --help                 查看说明
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "input-dir": { type: "string" },
      split: { type: "string" },
      limit: { type: "string" },
      shuffle: { type: "boolean", default: false },
      "max-questions": { type: "string" },
      "max-turns": { type: "string" },
      "fixed-turns": { type: "boolean", default: false },
      "no-length-tier": { type: "boolean", default: false },
      "max-attempts": { type: "string" },
      "call-attempts": { type: "string" },
      "retry-delay-ms": { type: "string" },
      concurrency: { type: "string" },
      "include-unjudged": { type: "boolean", default: false },
      "extract-rubric": { type: "boolean", default: false },
      "rubric-skill": { type: "string" },
      "freeze-version": { type: "string" },
      db: { type: "string" },
      prompts: { type: "string" },
      "question-skill": { type: "string" },
      "followup-skill": { type: "string" },
      "answer-style": { type: "string" },
      skill: { type: "string" },
      "no-skill": { type: "boolean", default: false },
      export: { type: "string" },
      system: { type: "string" },
      "system-file": { type: "string" },
      status: { type: "boolean", default: false },
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
  const noSkill = Boolean(values["no-skill"]);
  if (
    noSkill
    && (values["question-skill"] !== undefined || values["followup-skill"] !== undefined || values["answer-style"] !== undefined || values.skill !== undefined || values["rubric-skill"] !== undefined)
  ) {
    throw new Error("--no-skill 不能与任何 Skill 参数同时指定");
  }

  const targetSplit = validateSplit(values.split ?? "train", "--split");
  if (values["freeze-version"] !== undefined && targetSplit === "train") {
    throw new Error("--freeze-version 仅适用于 --split test 或 --split dpo");
  }

  const inputDir = resolve(values["input-dir"] ?? DEFAULT_CORPUS_DIR);
  const dbPath = resolve(values.db ?? DEFAULT_DB);
  const limit = parsePositiveInt(values.limit ?? "10", "--limit")!;
  const maxQuestionsPerVideo = parsePositiveInt(values["max-questions"], "--max-questions");
  const maxTurns = validateMaxTurns(Number(values["max-turns"] ?? 3));
  const distributeTurns = !values["fixed-turns"] && maxTurns > 1;
  const distributeLength = !values["no-length-tier"];
  const maxAttempts = validateMaxAttempts(Number(values["max-attempts"] ?? 3));
  const callMaxAttempts = validateCallMaxAttempts(Number(values["call-attempts"] ?? DEFAULT_CALL_MAX_ATTEMPTS));
  const callRetryDelayMs = validateCallRetryDelayMs(Number(values["retry-delay-ms"] ?? DEFAULT_CALL_RETRY_DELAY_MS));
  const concurrency = validateConcurrency(Number(values.concurrency ?? 10));
  const extractRubric = Boolean(values["extract-rubric"]);

  const store = new DataMakerStore(dbPath);
  try {
    if (values.status) {
      const units = await scanCorpusVideos(inputDir);
      syncCorpusSplits(store, units);
      const status = summarizeCorpusStatus(units, store);
      const splits = summarizeSplitCounts(store, units);
      const unjudged = loadTargetQuestions(store, { onlyUnjudged: true, maxTurns, split: targetSplit }).length;
      console.log(JSON.stringify({
        db: dbPath,
        inputDir,
        split: targetSplit,
        totalVideos: status.totalVideos,
        totalPartFiles: status.totalPartFiles,
        multiPartVideos: status.multiPartVideos,
        processedVideos: status.processedVideos,
        unprocessedVideos: status.unprocessedVideos,
        unjudgedQuestionsForMaxTurns: unjudged,
        maxTurns,
        splits,
      }, null, 2));
      return;
    }

    const promptDir = resolve(values.prompts ?? (noSkill ? NO_SKILL_PROMPTS_DIR : DEFAULT_PROMPTS_DIR));
    const questionBasePrompt = nonEmpty(
      await readFile(join(ROOT, "prompts/question-generator.md"), "utf8"),
      "问题生成系统提示词",
    );
    let questionSystemPrompt = questionBasePrompt;
    let answerSystemPrompt = nonEmpty(await readFile(join(promptDir, "answer.md"), "utf8"), "回答系统提示词");
    let judgeSystemPrompt = nonEmpty(await readFile(join(promptDir, "judge.md"), "utf8"), "质检系统提示词");
    let followupSystemPrompt = maxTurns > 1
      ? nonEmpty(await readFile(join(promptDir, "followup.md"), "utf8"), "多轮追问系统提示词")
      : undefined;
    let rubricSystemPrompt = extractRubric
      ? await readRubricPrompt(promptDir).catch(() => readRubricPrompt(DEFAULT_PROMPTS_DIR))
      : undefined;

    const questionSkills: Array<Record<string, unknown>> = [];
    const dialogueSkills: Array<Record<string, unknown>> = [];
    let rubricReady = false;

    if (!noSkill) {
      const qSkillPath = resolve(values["question-skill"] ?? DEFAULT_QUESTION_SKILL);
      const qSkill = await readQuestionSkill(qSkillPath);
      questionSystemPrompt = questionPrompt(questionBasePrompt, qSkill.body);
      questionSkills.push({ name: "question-design", path: qSkillPath, status: qSkill.status, body: qSkill.body, sha256: qSkill.sha256 });

      const stylePath = resolve(values["answer-style"] ?? DEFAULT_ANSWER_STYLE);
      const style = await readAnswerStyle(stylePath);
      answerSystemPrompt = answerPrompt(answerSystemPrompt, style.body);
      dialogueSkills.push({ name: "answer-style", path: stylePath, status: style.status, body: style.body, sha256: style.sha256 });

      const rubricPath = resolve(values.skill ?? DEFAULT_QUALITY_JUDGE);
      const rubric = await readRubric(rubricPath);
      judgeSystemPrompt = judgePrompt(judgeSystemPrompt, rubric.body);
      rubricReady = rubric.status === "ready";
      dialogueSkills.push({ name: "quality-judge", path: rubricPath, status: rubric.status, body: rubric.body, sha256: rubric.sha256 });

      if (maxTurns > 1 && followupSystemPrompt !== undefined) {
        const fSkillPath = resolve(values["followup-skill"] ?? DEFAULT_FOLLOWUP_SKILL);
        const fSkill = await readFollowupSkill(fSkillPath);
        followupSystemPrompt = composeFollowupPrompt(followupSystemPrompt, fSkill.body);
        dialogueSkills.push({ name: "followup-strategy", path: fSkillPath, status: fSkill.status, body: fSkill.body, sha256: fSkill.sha256 });
      }

      if (extractRubric && rubricSystemPrompt !== undefined) {
        const evalRubricSkillPath = resolve(values["rubric-skill"] ?? DEFAULT_EVAL_RUBRIC_SKILL);
        const evalRubricSkill = await readEvalRubricSkill(evalRubricSkillPath);
        rubricSystemPrompt = evalRubricPrompt(rubricSystemPrompt, evalRubricSkill.body);
        dialogueSkills.push({
          name: "eval-rubric",
          path: evalRubricSkillPath,
          status: evalRubricSkill.status,
          body: evalRubricSkill.body,
          sha256: evalRubricSkill.sha256,
        });
      }
    }

    const trainingEnabled = targetSplit === "train" && rubricReady;
    const evalEnabled = targetSplit !== "train" && rubricReady;

    let exportSystemPrompt: string | undefined;
    if (values.system !== undefined) {
      exportSystemPrompt = nonEmpty(values.system, "--system");
    } else if (values["system-file"] !== undefined) {
      exportSystemPrompt = nonEmpty(await readFile(resolve(values["system-file"]), "utf8"), "--system-file");
    }

    const config = readPiConfig();
    const { apiKey: _apiKey, ...sanitizedModel } = config;
    store.markInterruptedRuns();

    const allUnits = await scanCorpusVideos(inputDir);
    const splitMap = syncCorpusSplits(store, allUnits);
    const { processedVideoKeys } = queryProcessedVideoIndex(store);
    const unprocessedPool = allUnits.filter((u) => !processedVideoKeys.has(extractVideoKey(u.videoId)));
    const selectedVideos = selectVideos(unprocessedPool, {
      limit,
      shuffle: Boolean(values.shuffle),
      split: targetSplit,
      splitMap,
    });

    let questionSummary;
    let targetQuestionIds: number[] = [];

    if (selectedVideos.length > 0) {
      console.log(`=== 阶段 1/2：出题（分区 ${targetSplit}，选中 ${selectedVideos.length} 个未处理视频，并发 ${concurrency}，模型 ${config.modelId}）===`);
      questionSummary = await runCorpusQuestionGeneration({
        store,
        config,
        systemPrompt: questionSystemPrompt,
        skills: questionSkills,
        candidates: selectedVideos,
        concurrency,
        split: targetSplit,
        callMaxAttempts,
        callRetryDelayMs,
        maxQuestionsPerVideo,
        onProgress: (message) => console.log(message),
      });
      targetQuestionIds.push(...questionSummary.generatedQuestionIds);
    }

    if (values["include-unjudged"]) {
      const legacyUnjudged = loadTargetQuestions(store, {
        onlyUnjudged: true,
        maxTurns,
        split: targetSplit,
      }).map((q) => q.id);
      targetQuestionIds = [...new Set([...targetQuestionIds, ...legacyUnjudged])];
    }

    if (targetQuestionIds.length === 0) {
      console.log(JSON.stringify({
        db: dbPath,
        inputDir,
        split: targetSplit,
        selectedVideos: selectedVideos.length,
        questionRunId: questionSummary?.runId ?? null,
        judgeRunId: null,
        results: 0,
        message: selectedVideos.length === 0 ? "没有需要处理的未出题视频" : "本批视频未生成新问题，跳过问答质检",
      }, null, 2));
      if (questionSummary && (!questionSummary.integrityOk || questionSummary.errors > 0)) {
        process.exitCode = 1;
      }
      return;
    }

    console.log(`=== 阶段 2/2：回答与质检（分区 ${targetSplit}，${targetQuestionIds.length} 题，最多 ${maxTurns} 对话轮，并发 ${concurrency}）===`);
    const dialogueSummary = await runDialogueBatch({
      store,
      runRole: createPiRunner(config),
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
      questionIds: targetQuestionIds,
      config: {
        mode: noSkill ? "sqlite-batch-no-skill" : "sqlite-batch",
        split: targetSplit,
        model: sanitizedModel,
        promptDirectory: promptDir,
        questionRunId: questionSummary?.runId ?? null,
        ...(extractRubric ? { extractRubric: true } : {}),
        inputSchemaVersion: maxTurns > 1 ? "v2-multiturn-json" : "v1-minimal-json",
      },
      skills: dialogueSkills,
      exportPolicy: targetSplit === "train"
        ? { format: "messages_jsonl", split: "train", training_enabled: trainingEnabled }
        : {
            format: "messages_jsonl",
            split: targetSplit,
            purpose: targetSplit,
            training_enabled: false,
            eval_enabled: evalEnabled,
          },
      onProgress: (message) => console.log(message),
    });

    let frozenVersion: { id: number; name: string; sampleCount: number; videoCount: number; sha256: string } | undefined;
    if (values["freeze-version"] !== undefined && (targetSplit === "test" || targetSplit === "dpo")) {
      const ver = store.freezeTestSetVersion({
        name: nonEmpty(values["freeze-version"], "--freeze-version"),
        split: targetSplit,
        systemPrompt: exportSystemPrompt,
      });
      frozenVersion = {
        id: ver.id,
        name: ver.name,
        sampleCount: ver.sample_count,
        videoCount: ver.video_count,
        sha256: ver.sha256,
      };
    }

    let exportedPath: string | undefined;
    if (values.export !== undefined) {
      if (targetSplit === "train") {
        const evalVideoKeys = readEvalVideoKeys(join(dirname(dbPath), "eval.sqlite"));
        if (evalVideoKeys.size > 0) {
          const exported = store.exportMergedDataset({ runIds: [dialogueSummary.runId], split: "train" });
          const materialInfo = store.getMaterialVideoAndSplitMap();
          const videoKeys = exported.train.map((r) => materialInfo.get(r.materialId)?.videoKey ?? String(r.materialId));
          assertNoEvalLeak(videoKeys, evalVideoKeys, "批次训练导出");
        }
      }
      exportedPath = resolve(nonEmpty(values.export, "--export"));
      const jsonl = store.exportRunJsonl(dialogueSummary.runId, { systemPrompt: exportSystemPrompt });
      await mkdir(dirname(exportedPath), { recursive: true });
      await writeFile(exportedPath, jsonl, "utf8");
    }

    const totalErrors = (questionSummary?.errors ?? 0) + dialogueSummary.errors;
    const integrityOk = (questionSummary?.integrityOk ?? true) && dialogueSummary.integrityOk;

    console.log(JSON.stringify({
      db: dbPath,
      inputDir,
      split: targetSplit,
      questionRunId: questionSummary?.runId ?? null,
      selectedVideos: selectedVideos.length,
      processedVideos: questionSummary?.processedVideos ?? 0,
      savedQuestions: questionSummary?.savedQuestions ?? 0,
      questionErrors: questionSummary?.errors ?? 0,
      judgeRunId: dialogueSummary.runId,
      judgedQuestions: dialogueSummary.questions,
      maxTurns,
      maxAttempts,
      concurrency,
      ...(dialogueSummary.plannedTurnDistribution ? { plannedTurnDistribution: dialogueSummary.plannedTurnDistribution } : {}),
      ...(dialogueSummary.plannedLengthDistribution ? { plannedLengthDistribution: dialogueSummary.plannedLengthDistribution } : {}),
      outcomes: dialogueSummary.outcomes,
      results: dialogueSummary.results,
      judgeErrors: dialogueSummary.errors,
      ...(dialogueSummary.rubricsExtracted !== undefined ? { rubricsExtracted: dialogueSummary.rubricsExtracted, rubricErrors: dialogueSummary.rubricErrors ?? 0 } : {}),
      trainingEnabled,
      ...(targetSplit !== "train" ? { evalEnabled } : {}),
      ...(frozenVersion ? { frozenVersion } : {}),
      integrityOk,
      ...(exportedPath ? { exportedPath } : {}),
    }, null, 2));

    if (!integrityOk || totalErrors > 0) {
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
